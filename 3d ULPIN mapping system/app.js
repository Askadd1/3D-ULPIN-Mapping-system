(async () => {
  'use strict';

  let data;
  try {
    const response = await fetch('/api/neighborhood');
    if (!response.ok) throw new Error(`API returned ${response.status}`);
    data = await response.json();
  } catch (error) {
    const map = document.querySelector('.map-frame');
    map.innerHTML = '<div style="position:absolute;inset:0;display:grid;place-content:center;padding:24px;text-align:center;color:#405849;font:14px sans-serif"><strong>Could not load neighborhood sample data.</strong><span style="margin-top:8px;color:#78867b">Start the local backend with <code>npm start</code>, then open <code>http://localhost:4173</code>.</span></div>';
    console.error('Neighborhood API unavailable:', error);
    return;
  }

  // SCALE CONSTANTS
  const UNIT_TO_M = data.scale?.unitToMeters || 2.5;
  const UNIT_TO_SQM = data.scale?.unitToSqMeters || (UNIT_TO_M * UNIT_TO_M); // 6.25 m²
  const SQM_TO_SQFT = 10.7639;

  const canvas = document.getElementById('mapCanvas');
  const ctx = canvas.getContext('2d');
  const frame = document.querySelector('.map-frame');
  const panel = document.getElementById('propertyPanel');
  const content = document.getElementById('propertyContent');
  const showDetails = document.getElementById('showDetails');
  const searchInput = document.getElementById('ulpinSearch');
  const searchClearBtn = document.getElementById('searchClearBtn');
  const searchDropdown = document.getElementById('searchDropdown');
  const unitToggleBtn = document.getElementById('unitToggleBtn');

  const initial = { angle: -0.55, tilt: 0.62, zoom: 1, panX: 0, panY: 20 };
  const camera = { ...initial };

  const state = {
    layer: 'surface',
    selected: data.properties[1], // Default: Gulmohar House with overlap
    highlightFloor: null,
    hits: [],
    pointer: null,
    dragging: false,
    moved: false,
    lastX: 0,
    lastY: 0,
    dpr: 1,
    width: 1,
    height: 1,
    unitSystem: 'metric', // 'metric' (m²) or 'imperial' (sq ft)
    beacon: null, // { x, z, startTime, duration }
    selectedIndex: -1,
    animating: false
  };

  const TAU = Math.PI * 2;
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

  function resize() {
    const rect = frame.getBoundingClientRect();
    state.dpr = Math.min(window.devicePixelRatio || 1, 2);
    state.width = rect.width;
    state.height = rect.height;
    canvas.width = Math.round(rect.width * state.dpr);
    canvas.height = Math.round(rect.height * state.dpr);
    ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    render();
  }

  function scale() {
    return clamp(Math.min(state.width / 49, state.height / 34) * 0.91 * camera.zoom, 8, 30);
  }

  function project(x, y, z) {
    const s = scale(), a = camera.angle, tilt = camera.tilt;
    const xx = x * Math.cos(a) - z * Math.sin(a);
    const depth = x * Math.sin(a) + z * Math.cos(a);
    const cx = state.width * (state.width < 700 ? 0.5 : 0.455) + camera.panX;
    const cy = state.height * 0.53 + camera.panY;
    return { x: cx + xx * s, y: cy - (y * Math.cos(tilt) - depth * Math.sin(tilt)) * s, depth };
  }

  function polygon(points, fill, stroke, lineWidth = 1, dash = []) {
    if (!points || !points.length) return;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.closePath();
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) {
      ctx.save();
      ctx.strokeStyle = stroke;
      ctx.lineWidth = lineWidth;
      ctx.setLineDash(dash);
      ctx.stroke();
      ctx.restore();
    }
  }

  function line(points, stroke, width = 1, dash = []) {
    if (!points || points.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    points.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
    ctx.save();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.setLineDash(dash);
    ctx.stroke();
    ctx.restore();
  }

  function box(x, z, w, d, y0, y1) {
    const pts = [
      project(x - w / 2, y0, z - d / 2),
      project(x + w / 2, y0, z - d / 2),
      project(x + w / 2, y0, z + d / 2),
      project(x - w / 2, y0, z + d / 2),
      project(x - w / 2, y1, z - d / 2),
      project(x + w / 2, y1, z - d / 2),
      project(x + w / 2, y1, z + d / 2),
      project(x - w / 2, y1, z + d / 2)
    ];
    return { p: pts, depth: project(x, 0, z).depth };
  }

  function shade(hex, amount) {
    const n = parseInt(hex.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
    const f = v => Math.round(clamp(v + amount, 0, 255));
    return `rgb(${f(r)},${f(g)},${f(b)})`;
  }

  function drawPrism(x, z, w, d, h, color, roof, accent, opts = {}) {
    const base = box(x, z, w, d, opts.base || 0, (opts.base || 0) + h).p;
    const left = [base[3], base[2], base[6], base[7]];
    const right = [base[1], base[2], base[6], base[5]];
    polygon(left, shade(color, -35), opts.edge || 'rgba(75,82,72,.2)', 0.65);
    polygon(right, shade(color, -13), opts.edge || 'rgba(75,82,72,.2)', 0.65);
    polygon([base[4], base[5], base[6], base[7]], roof, opts.edge || 'rgba(75,82,72,.2)', 0.65);

    if (opts.windows !== false && h > 2.7) {
      const floors = Math.max(1, Math.min(7, Math.round(h / 1.5)));
      for (let j = 1; j < floors; j++) {
        const fy = (opts.base || 0) + (h * j) / floors;
        const pts = box(x, z, w, d, fy, fy).p;
        line([pts[3], pts[2]], 'rgba(255,255,250,.53)', 0.8);
        line([pts[1], pts[2]], 'rgba(255,255,250,.42)', 0.8);
      }
      const door = project(x, 0.7, z + d / 2 + 0.015);
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.ellipse(door.x, door.y, Math.max(1, scale() * 0.075), Math.max(2, scale() * 0.18), 0, 0, TAU);
      ctx.fill();
    }
    return base;
  }

  function drawGround() {
    const { width, depth } = data.bounds;
    const corners = [
      project(-width / 2, 0, -depth / 2),
      project(width / 2, 0, -depth / 2),
      project(width / 2, 0, depth / 2),
      project(-width / 2, 0, depth / 2)
    ];
    polygon(corners, state.layer === 'utilities' ? '#d7ded5' : '#dfe6db', 'rgba(71,90,77,.16)', 1);

    for (let x = -20; x <= 20; x += 2) {
      line([project(x, 0.015, -17), project(x, 0.015, 17)], 'rgba(111,132,110,.075)', 0.55);
    }
    for (let z = -16; z <= 16; z += 2) {
      line([project(-20, 0.015, z), project(20, 0.015, z)], 'rgba(111,132,110,.075)', 0.55);
    }

    [[-16, -6, 1.25], [-1, -1.2, 1.1], [10, -6.5, 1.0], [-16, 4.5, 1.05], [0, 11.4, 1.0], [19, 0, 1.15]].forEach(([x, z, r]) => {
      const p = [project(x - r, 0, z - r), project(x + r, 0, z - r), project(x + r, 0, z + r), project(x - r, 0, z + r)];
      polygon(p, 'rgba(131,166,123,.24)');
    });
  }

  function drawRoads() {
    data.roads.forEach(road => {
      const w = road.width;
      const x0 = road.x - road.length / 2, x1 = road.x + road.length / 2, z0 = road.z - w / 2, z1 = road.z + w / 2;
      const pts = [project(x0, 0, z0), project(x1, 0, z0), project(x1, 0, z1), project(x0, 0, z1)];
      if (state.layer === 'utilities') {
        polygon(pts, 'rgba(109,122,116,.09)', 'rgba(106,119,112,.16)', 0.7, [3, 4]);
      } else {
        polygon(pts, '#c5cbc4', 'rgba(112,122,113,.18)', 0.65);
        const mid = [project(x0, 0.025, road.z), project(x1, 0.025, road.z)];
        if (road.length === 34) {
          mid.splice(0, 2, project(road.x, 0.025, road.z - road.length / 2), project(road.x, 0.025, road.z + road.length / 2));
        }
        line(mid, 'rgba(255,255,246,.52)', 0.8, [5, 7]);
      }
    });
  }

  function drawParcel(prop) {
    const b = prop.parcel, selected = state.selected?.id === prop.id;
    const p = [
      project(b.x, 0.06, b.z),
      project(b.x + b.w, 0.06, b.z),
      project(b.x + b.w, 0.06, b.z + b.d),
      project(b.x, 0.06, b.z + b.d)
    ];
    polygon(p, selected ? 'rgba(90,138,111,.15)' : null, selected ? '#387352' : 'rgba(77,112,83,.48)', selected ? 2.2 : 1, [4, 3]);

    const label = project(b.x + b.w / 2, 0.16, b.z + b.d / 2);
    ctx.save();
    ctx.font = '700 9.5px "DM Sans",sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (scale() > 10) {
      ctx.fillStyle = selected ? '#264833' : 'rgba(57,78,64,.75)';
      ctx.fillText(prop.label, label.x, label.y);
    }
    ctx.restore();
    state.hits.push({ type: 'property', item: prop, poly: p, depth: label.depth });
  }

  function drawTree(x, z, r) {
    const root = project(x, 0, z), trunk = project(x, 0.8 * r, z);
    line([root, trunk], '#9a7858', Math.max(2, scale() * 0.12));
    const top = project(x, 1.65 * r, z), rad = Math.max(3, scale() * r * 0.37);
    ctx.save();
    ctx.fillStyle = 'rgba(43,77,54,.13)';
    ctx.beginPath();
    ctx.ellipse(root.x, root.y + 2, rad * 1.3, rad * 0.44, -0.15, 0, TAU);
    ctx.fill();
    [[-0.34, 0.16, '#82a77b'], [0.24, 0.11, '#71986f'], [0, -0.23, '#96b68a']].forEach(([dx, dy, c]) => {
      ctx.beginPath();
      ctx.fillStyle = c;
      ctx.arc(top.x + dx * rad, top.y + dy * rad, rad * (dx === 0 ? 0.68 : 0.59), 0, TAU);
      ctx.fill();
    });
    ctx.restore();
  }

  function drawUtility(u) {
    const pts = u.points.map(([x, z]) => project(x, -0.12, z));
    line(pts, 'rgba(255,255,255,.85)', Math.max(2, scale() * u.width * 1.12));
    line(pts, u.color, Math.max(1.3, scale() * u.width * 0.64));
    pts.forEach((p, i) => {
      if (i === 0 || i === pts.length - 1) {
        ctx.beginPath();
        ctx.fillStyle = u.color;
        ctx.arc(p.x, p.y, 3, 0, TAU);
        ctx.fill();
      }
    });
  }

  function drawBuildings() {
    const props = [...data.properties].sort((a, b) => project(a.x, 0, a.z).depth - project(b.x, 0, b.z).depth);
    for (const prop of props) {
      const selected = state.selected?.id === prop.id;
      if (state.layer === 'utilities') continue;

      if (state.layer === 'surface') {
        const footprint = [
          project(prop.x - prop.w / 2, 0.1, prop.z - prop.d / 2),
          project(prop.x + prop.w / 2, 0.1, prop.z - prop.d / 2),
          project(prop.x + prop.w / 2, 0.1, prop.z + prop.d / 2),
          project(prop.x - prop.w / 2, 0.1, prop.z + prop.d / 2)
        ];
        state.hits.push({ type: 'property', item: prop, poly: footprint, depth: project(prop.x, 0, prop.z).depth + 10 });
        const shadow = footprint.map(p => ({ x: p.x + 7, y: p.y + 7 }));
        polygon(shadow, 'rgba(57,67,56,.10)');
        drawPrism(prop.x, prop.z, prop.w, prop.d, prop.h, prop.color, prop.roof, prop.accent, {
          edge: selected ? '#387352' : 'rgba(75,82,72,.25)'
        });
        if (selected) {
          const bounds = prop.parcel;
          const p = [
            project(bounds.x, 0.1, bounds.z),
            project(bounds.x + bounds.w, 0.1, bounds.z),
            project(bounds.x + bounds.w, 0.1, bounds.z + bounds.d),
            project(bounds.x, 0.1, bounds.z + bounds.d)
          ];
          polygon(p, null, '#387352', 1.8, [4, 3]);
        }
      } else {
        // Exploded floors view
        const floors = Math.max(1, Math.min(prop.floors, 6)), fh = 1.23, gap = 0.13;
        const total = floors * (fh + gap) - gap;
        const floorUnits = prop.floorUnits || [];
        const aboveGround = floorUnits.filter(fu => fu.floor >= 0).sort((a, b) => a.floor - b.floor);

        for (let i = 0; i < floors; i++) {
          const by = i * (fh + gap) + 0.12 + (selected && i > 0 ? 0.11 : 0);
          const isFloorHighlighted = selected && state.highlightFloor === i;
          const part = drawPrism(prop.x, prop.z, prop.w * 0.9, prop.d * 0.9, fh, prop.color, prop.roof, prop.accent, {
            base: by,
            windows: false,
            edge: isFloorHighlighted ? '#d97724' : 'rgba(67,88,69,.32)'
          });

          if (isFloorHighlighted || (selected && state.highlightFloor === null && i === Math.min(floors - 1, Math.max(0, floors - 2)))) {
            polygon([part[4], part[5], part[6], part[7]], '#f7d6a0', 'rgba(201,145,68,.85)', 1);
          }

          const fu = aboveGround[i];
          if (fu && scale() > 10) {
            const tagY = by + fh * 0.55;
            const tagP = project(prop.x + prop.w * 0.48, tagY, prop.z);
            ctx.save();
            const tagText = fu.subUlpin.slice(-3);
            const fullTag = fu.subUlpin;
            const pillW = scale() > 14 ? Math.max(58, fullTag.length * 5.3) : Math.max(22, tagText.length * 6.5);
            const pillH = 13;
            ctx.fillStyle = isFloorHighlighted ? 'rgba(255,225,170,.95)' : 'rgba(255,253,243,.88)';
            ctx.strokeStyle = isFloorHighlighted ? '#d97724' : prop.accent;
            ctx.lineWidth = isFloorHighlighted ? 1.2 : 0.7;
            ctx.beginPath();
            ctx.roundRect(tagP.x + 3, tagP.y - pillH / 2, pillW, pillH, 4);
            ctx.fill();
            ctx.stroke();

            ctx.fillStyle = isFloorHighlighted ? '#8a4b13' : '#3a5141';
            ctx.font = '700 7px "DM Sans",sans-serif';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(scale() > 14 ? fullTag : tagText, tagP.x + 6, tagP.y + 0.5);
            ctx.restore();
          }
        }

        const footprint = [
          project(prop.x - prop.w * 0.48, 0.1, prop.z - prop.d * 0.48),
          project(prop.x + prop.w * 0.48, 0.1, prop.z - prop.d * 0.48),
          project(prop.x + prop.w * 0.48, 0.1, prop.z + prop.d * 0.48),
          project(prop.x - prop.w * 0.48, 0.1, prop.z + prop.d * 0.48)
        ];
        state.hits.push({ type: 'property', item: prop, poly: footprint, depth: project(prop.x, 0, prop.z).depth + 10 });
        const roof = project(prop.x, total + 0.6, prop.z);
        ctx.save();
        ctx.fillStyle = '#fffdf3';
        ctx.strokeStyle = prop.accent;
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.arc(roof.x, roof.y, 7, 0, TAU);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#536c57';
        ctx.font = '700 8px "DM Sans"';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`${floors}F`, roof.x, roof.y);
        ctx.restore();
      }
    }
  }

  function drawUtilities() {
    data.utilities.forEach(u => drawUtility(u));
    data.properties.filter(p => p.units.some(unit => unit.toLowerCase().includes('basement'))).forEach(p => {
      const b = box(p.x, p.z, p.w * 0.7, p.d * 0.7, -1.45, -0.15).p;
      polygon([b[3], b[2], b[6], b[7]], 'rgba(128,151,155,.38)', 'rgba(92,121,127,.8)', 1);
      polygon([b[1], b[2], b[6], b[5]], 'rgba(104,135,145,.40)', 'rgba(92,121,127,.8)', 1);
      polygon([b[4], b[5], b[6], b[7]], 'rgba(230,240,235,.72)', 'rgba(92,121,127,.85)', 1, [3, 2]);
      const pp = project(p.x, -1.9, p.z);
      ctx.fillStyle = '#4d7379';
      ctx.beginPath();
      ctx.arc(pp.x, pp.y, 3, 0, TAU);
      ctx.fill();
    });

    data.utilities.forEach(u => {
      const mid = u.points[Math.floor(u.points.length / 2)], p = project(mid[0], -0.1, mid[1]);
      if (scale() > 11) {
        ctx.save();
        ctx.fillStyle = '#f9fbf7';
        ctx.strokeStyle = u.color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(p.x + 5, p.y - 8, 89, 18, 8);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#4e6256';
        ctx.font = '600 8px "DM Sans"';
        ctx.fillText(u.name, p.x + 11, p.y + 3);
        ctx.restore();
      }
    });
  }

  // REQUIREMENT 2: OVERLAP DRAWING WITH EXACT AREA IN METERS & SQ FT
  function drawOverlap() {
    const prop = data.properties.find(p => p.status === 'overlap');
    if (!prop) return;

    const overlapData = prop.overlapData || {
      overlapRect: { x: 7.3, z: -8.7, w: 2.4, d: 4.8 },
      overlapAreaM2: 28.8,
      overlapAreaSqFt: 310.0
    };
    const r = overlapData.overlapRect;

    // Overlap polygon in 3D ground coordinates
    const poly = [
      project(r.x, 0.08, r.z),
      project(r.x + r.w, 0.08, r.z),
      project(r.x + r.w, 0.08, r.z + r.d),
      project(r.x, 0.08, r.z + r.d)
    ];

    // Shaded striped hazard fill
    polygon(poly, 'rgba(245, 158, 57, 0.28)', '#d97724', 1.8, [3, 3]);

    // Draw diagonal hatch lines across the overlap zone
    ctx.save();
    ctx.strokeStyle = 'rgba(217, 119, 36, 0.45)';
    ctx.lineWidth = 1;
    for (let offset = 0; offset <= r.w + r.d; offset += 0.8) {
      const p1 = project(Math.min(r.x + r.w, r.x + offset), 0.08, Math.max(r.z, r.z + offset - r.w));
      const p2 = project(Math.max(r.x, r.x + offset - r.d), 0.08, Math.min(r.z + r.d, r.z + offset));
      line([p1, p2], 'rgba(217, 119, 36, 0.45)', 1);
    }
    ctx.restore();

    // Floating 3D Warning & Measurement Badge
    const midX = r.x + r.w / 2;
    const midZ = r.z + r.d / 2;
    const pCenter = project(midX, 0.45, midZ);

    const isSelected = state.selected?.id === prop.id;
    const areaText = state.unitSystem === 'metric'
      ? `${overlapData.overlapAreaM2.toFixed(1)} m²`
      : `${overlapData.overlapAreaSqFt.toFixed(0)} sq ft`;

    ctx.save();
    ctx.shadowColor = 'rgba(180, 83, 9, 0.25)';
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 2;

    // Badge bubble
    const badgeW = scale() > 12 ? 118 : 88;
    const badgeH = 22;
    const bx = pCenter.x - badgeW / 2;
    const by = pCenter.y - badgeH - 6;

    ctx.fillStyle = isSelected ? '#fff3e3' : 'rgba(255, 248, 238, 0.95)';
    ctx.strokeStyle = '#d97724';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.roundRect(bx, by, badgeW, badgeH, 6);
    ctx.fill();
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Badge text
    ctx.fillStyle = '#b45309';
    ctx.font = '800 9.5px "DM Sans", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`⚠️ Overlap: ${areaText}`, pCenter.x, by + badgeH / 2);

    // Indicator pin stem
    ctx.beginPath();
    ctx.moveTo(pCenter.x, by + badgeH);
    ctx.lineTo(pCenter.x, pCenter.y);
    ctx.strokeStyle = '#d97724';
    ctx.lineWidth = 1.2;
    ctx.stroke();

    ctx.restore();
  }

  // GOOGLE MAPS STYLE BEACON PULSE
  function drawBeacon() {
    if (!state.beacon) return;
    const now = performance.now();
    const elapsed = now - state.beacon.startTime;
    if (elapsed > state.beacon.duration) {
      state.beacon = null;
      return;
    }

    const progress = elapsed / state.beacon.duration;
    const p = project(state.beacon.x, 0.2, state.beacon.z);

    ctx.save();
    // Radiating animated circles
    const maxR = scale() * 1.8;
    const r1 = (progress * 1.2 % 1) * maxR;
    const alpha1 = Math.max(0, 1 - (progress * 1.2 % 1));
    ctx.beginPath();
    ctx.arc(p.x, p.y, r1, 0, TAU);
    ctx.strokeStyle = `rgba(59, 115, 87, ${alpha1 * 0.8})`;
    ctx.lineWidth = 2.5;
    ctx.stroke();

    const r2 = ((progress * 1.2 + 0.4) % 1) * maxR;
    const alpha2 = Math.max(0, 1 - ((progress * 1.2 + 0.4) % 1));
    ctx.beginPath();
    ctx.arc(p.x, p.y, r2, 0, TAU);
    ctx.strokeStyle = `rgba(59, 115, 87, ${alpha2 * 0.5})`;
    ctx.lineWidth = 1.8;
    ctx.stroke();

    // Spotlight marker dot
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4.5, 0, TAU);
    ctx.fillStyle = '#2f6b4a';
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();

    // Keep animating if beacon active
    requestAnimationFrame(render);
  }

  function render() {
    if (!ctx || !state.width) return;
    ctx.clearRect(0, 0, state.width, state.height);
    state.hits = [];
    drawGround();
    drawRoads();
    data.properties.forEach(drawParcel);

    if (state.layer === 'utilities') {
      drawUtilities();
    } else {
      data.trees.forEach(t => drawTree(...t));
      drawBuildings();
      if (state.layer === 'surface') drawOverlap();
    }

    drawBeacon();

    if (state.pointer && !state.dragging) {
      const h = pick(state.pointer.x, state.pointer.y);
      canvas.style.cursor = h ? 'pointer' : 'grab';
    }
  }

  function inside(x, y, poly) {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) c = !c;
    }
    return c;
  }

  function pick(x, y) {
    const candidates = state.hits.filter(h => inside(x, y, h.poly)).sort((a, b) => b.depth - a.depth);
    return candidates[0] || null;
  }

  // SMOOTH CAMERA FLY-TO (Google Maps style transition)
  function flyTo(target, onComplete) {
    const startX = camera.panX, startY = camera.panY, startZoom = camera.zoom;
    const startAngle = camera.angle, startTilt = camera.tilt;

    const dur = 750;
    const startTime = performance.now();

    function easeOutCubic(t) { return (--t) * t * t + 1; }

    function step(now) {
      const t = Math.min(1, (now - startTime) / dur);
      const ease = easeOutCubic(t);

      camera.panX = startX + (target.panX - startX) * ease;
      camera.panY = startY + (target.panY - startY) * ease;
      camera.zoom = startZoom + (target.zoom - startZoom) * ease;
      if (target.angle !== undefined) camera.angle = startAngle + (target.angle - startAngle) * ease;
      if (target.tilt !== undefined) camera.tilt = startTilt + (target.tilt - startTilt) * ease;

      render();

      if (t < 1) {
        requestAnimationFrame(step);
      } else {
        state.animating = false;
        if (onComplete) onComplete();
      }
    }
    state.animating = true;
    requestAnimationFrame(step);
  }

  function setSelection(prop, options = {}) {
    if (!prop) return;
    state.selected = prop;
    state.highlightFloor = options.floor !== undefined ? options.floor : null;

    // Trigger Beacon at property position
    state.beacon = {
      x: prop.x,
      z: prop.z,
      startTime: performance.now(),
      duration: 2200
    };

    if (options.flyTo !== false) {
      // Calculate pan to center the property
      const s = scale(), a = camera.angle, tilt = camera.tilt;
      const xx = prop.x * Math.cos(a) - prop.z * Math.sin(a);
      const depth = prop.x * Math.sin(a) + prop.z * Math.cos(a);

      const targetCenterX = state.width * 0.44;
      const targetCenterY = state.height * 0.52;

      const targetPanX = targetCenterX - (state.width * 0.455 + xx * s);
      const targetPanY = targetCenterY - (state.height * 0.53 + depth * Math.sin(tilt) * s);

      flyTo({
        panX: clamp(targetPanX, -140, 140),
        panY: clamp(targetPanY, -100, 100),
        zoom: clamp(camera.zoom < 1.1 ? 1.25 : camera.zoom, 0.9, 1.6)
      });
    } else {
      render();
    }

    updatePanel();
    panel.classList.remove('is-hidden');
    showDetails.hidden = true;
  }

  // UPDATE PROPERTY PANEL WITH OVERLAP IN METERS & SQ FT
  function updatePanel() {
    const p = state.selected;
    if (!p) return;

    const units = p.units.map(unit => `<li><span class="unit-dot"></span><span>${escapeHtml(unit)}</span></li>`).join('');
    const overlap = p.status === 'overlap';
    const unitsLabel = state.layer === 'utilities' ? 'SPATIAL UNITS' : 'EXAMPLE UNITS';

    // Calculate Parcel Area in real units
    const parcelW_m = p.parcel.w * UNIT_TO_M;
    const parcelD_m = p.parcel.d * UNIT_TO_M;
    const parcelAreaM2 = (p.parcel.w * p.parcel.d) * UNIT_TO_SQM;
    const parcelAreaSqFt = parcelAreaM2 * SQM_TO_SQFT;

    const isMetric = state.unitSystem === 'metric';
    const parcelAreaDisplay = isMetric
      ? `${parcelAreaM2.toFixed(1)} m²`
      : `${parcelAreaSqFt.toFixed(0)} sq ft`;

    const parcelDimDisplay = isMetric
      ? `${parcelW_m.toFixed(1)}m × ${parcelD_m.toFixed(1)}m`
      : `${(parcelW_m * 3.28084).toFixed(0)}ft × ${(parcelD_m * 3.28084).toFixed(0)}ft`;

    // REQUIREMENT 2: Detailed Overlap Inspector UI
    let overlapInspector = '';
    if (overlap && p.overlapData) {
      const od = p.overlapData;
      const overlapVal = isMetric ? `${od.overlapAreaM2.toFixed(1)} m²` : `${od.overlapAreaSqFt.toFixed(0)} sq ft`;
      const altVal = isMetric ? `${od.overlapAreaSqFt.toFixed(0)} sq ft` : `${od.overlapAreaM2.toFixed(1)} m²`;

      const netClearM2 = parcelAreaM2 - od.overlapAreaM2;
      const netClearSqFt = parcelAreaSqFt - od.overlapAreaSqFt;
      const netClearDisplay = isMetric ? `${netClearM2.toFixed(1)} m²` : `${netClearSqFt.toFixed(0)} sq ft`;

      overlapInspector = `
        <div class="overlap-inspector">
          <div class="overlap-header">
            <span class="overlap-title-tag"><span class="overlap-tag-icon">!</span> BOUNDARY OVERLAP CONFLICT</span>
            <span class="overlap-pct-badge">${od.overlapPercentage}% of parcel</span>
          </div>
          <div class="overlap-stat-hero">
            <div class="overlap-stat-value">${overlapVal}</div>
            <div class="overlap-stat-unit">${isMetric ? 'Square Meters' : 'Square Feet'}</div>
            <div class="overlap-stat-alt">(${altVal})</div>
          </div>
          <div class="overlap-meter" title="${od.overlapPercentage}% overlap encroachment">
            <div class="overlap-meter-fill" style="width: ${Math.min(100, Math.max(5, od.overlapPercentage * 2.5))}%;"></div>
          </div>
          <div class="overlap-specs">
            <div class="overlap-spec-item">
              <span>Total Parcel:</span>
              <strong>${parcelAreaDisplay}</strong>
            </div>
            <div class="overlap-spec-item">
              <span>Net Usable Area:</span>
              <strong>${netClearDisplay}</strong>
            </div>
            <div class="overlap-spec-item">
              <span>Encroachment Dim:</span>
              <strong>${od.encroachmentWidthM}m × ${od.encroachmentLengthM}m</strong>
              <small>(${(od.encroachmentWidthM * 3.28084).toFixed(1)}ft × ${(od.encroachmentLengthM * 3.28084).toFixed(1)}ft)</small>
            </div>
            <div class="overlap-spec-item">
              <span>Conflict Party:</span>
              <strong>${escapeHtml(od.conflictingEntity || 'Adjacent Lot')}</strong>
            </div>
            <div class="overlap-spec-item full-width">
              <span>Description:</span>
              <small>${escapeHtml(od.description || 'Boundary intersection with adjacent cadastral line.')}</small>
            </div>
          </div>
        </div>
      `;
    }

    // Build floor sub-ULPIN section
    const floorUnits = p.floorUnits || [];
    const floorRows = floorUnits.sort((a, b) => a.floor - b.floor).map(fu => {
      const floorTag = fu.floor < 0 ? `B${String(Math.abs(fu.floor)).padStart(2, '0')}` : `F${String(fu.floor).padStart(2, '0')}`;
      const isHighlighted = state.highlightFloor === fu.floor;
      return `<li class="floor-unit-row" style="${isHighlighted ? 'border-color:#d97724;background:#fff8ee;' : ''}">
        <span class="floor-tag" style="${isHighlighted ? 'background:#d97724;' : ''}">${floorTag}</span>
        <div class="floor-unit-info">
          <strong>${escapeHtml(fu.subUlpin)}</strong>
          <small>${escapeHtml(fu.label)}</small>
        </div>
      </li>`;
    }).join('');

    const floorSection = floorUnits.length
      ? `<div class="floor-ulpin-section">
          <div class="subhead"><span>FLOOR SUB-ULPINs</span><b>${String(floorUnits.length).padStart(2, '0')}</b></div>
          <ul class="floor-unit-list">${floorRows}</ul>
        </div>`
      : '';

    content.innerHTML = `
      <div class="property-title-row">
        <div>
          <span class="property-kind">${escapeHtml(p.kind)}</span>
          <h2>${escapeHtml(p.name)}</h2>
        </div>
        <span class="property-symbol">⌂</span>
      </div>

      <div class="demo-id">
        <span>DEMO ULPIN ID</span>
        <strong>${escapeHtml(p.demoId)}</strong>
        <small>14-Digit Land Identification Code</small>
      </div>

      <div class="detail-grid">
        <div class="detail-cell">
          <span>FLOORS</span>
          <strong>${p.floors} Levels</strong>
          <small>above ground</small>
        </div>
        <div class="detail-cell">
          <span>PARCEL SIZE</span>
          <strong>${parcelAreaDisplay}</strong>
          <small>${parcelDimDisplay}</small>
        </div>
      </div>

      ${overlapInspector}

      ${floorSection}

      <div class="units-section">
        <div class="subhead"><span>${unitsLabel}</span><b>${String(p.units.length).padStart(2, '0')}</b></div>
        <ul class="unit-list">${units}</ul>
      </div>

      <div class="status-card ${overlap ? 'overlap' : 'clear'}">
        <span class="status-icon">${overlap ? '!' : '✓'}</span>
        <div>
          <strong>${overlap ? 'Cadastral Overlap Detected' : 'Boundary Clear · No Conflict'}</strong>
          <small>${overlap ? 'Encroachment identified with neighbor boundary' : 'Parcel fits cleanly within surveyed coordinates'}</small>
        </div>
        <span class="status-arrow">↗</span>
      </div>
    `;

    // Sync unit toggle button labels
    document.querySelectorAll('.unit-toggle-label').forEach(el => {
      el.classList.toggle('active', el.dataset.unit === state.unitSystem);
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function setLayer(layer) {
    state.layer = layer;
    document.querySelectorAll('.layer-button').forEach(btn => {
      const active = btn.dataset.layer === layer;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', String(active));
    });
    frame.dataset.layer = layer;
    render();
    updatePanel();
  }

  // ==========================================
  // REQUIREMENT 1: GOOGLE MAPS SEARCH ENGINE
  // ==========================================
  function buildSearchIndex() {
    const items = [];

    data.properties.forEach(prop => {
      // 1. Primary Property / ULPIN Entry
      items.push({
        type: 'property',
        title: prop.name,
        ulpin: prop.demoId,
        label: `Parcel ${prop.label} · ${prop.kind}`,
        property: prop,
        floor: null,
        icon: '⌂',
        overlap: prop.status === 'overlap'
      });

      // 2. Floor Sub-ULPIN Entries
      (prop.floorUnits || []).forEach(fu => {
        items.push({
          type: 'floor',
          title: `${prop.name} — ${fu.label}`,
          ulpin: fu.subUlpin,
          label: `Sub-ULPIN · Level ${fu.floor >= 0 ? 'F' + fu.floor : 'B' + Math.abs(fu.floor)}`,
          property: prop,
          floor: fu.floor,
          icon: fu.floor < 0 ? '⌁' : '▤',
          overlap: false
        });
      });
    });

    return items;
  }

  const searchIndex = buildSearchIndex();

  function highlightMatch(text, query) {
    if (!query) return escapeHtml(text);
    const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(${escapedQuery})`, 'gi');
    return escapeHtml(text).replace(regex, '<mark>$1</mark>');
  }

  function performSearch(query) {
    query = (query || '').trim().toLowerCase();
    if (!query) {
      searchDropdown.hidden = true;
      searchClearBtn.hidden = true;
      return;
    }

    searchClearBtn.hidden = false;

    const matches = searchIndex.filter(item => {
      return (
        item.ulpin.toLowerCase().includes(query) ||
        item.title.toLowerCase().includes(query) ||
        item.label.toLowerCase().includes(query) ||
        item.property.label.toLowerCase().includes(query)
      );
    });

    if (matches.length === 0) {
      searchDropdown.innerHTML = '<div class="search-no-results">No properties or ULPINs found for "<strong>' + escapeHtml(query) + '</strong>". Try <em>Gulmohar</em>, <em>B-08</em>, or <em>D-UL-2704</em>.</div>';
      searchDropdown.hidden = false;
      return;
    }

    state.searchResults = matches.slice(0, 8);
    state.selectedIndex = 0;

    renderDropdownResults(query);
  }

  function renderDropdownResults(query) {
    const html = state.searchResults.map((item, idx) => {
      const isSelected = idx === state.selectedIndex;
      const overlapBadge = item.overlap ? '<span class="search-item-badge">⚠️ Overlap</span>' : '';
      return `
        <div class="search-item ${isSelected ? 'is-selected' : ''} ${item.overlap ? 'has-overlap' : ''}" data-index="${idx}" role="option" aria-selected="${isSelected}">
          <div class="search-item-icon">${item.icon}</div>
          <div class="search-item-body">
            <div class="search-item-title">
              <span>${highlightMatch(item.title, query)}</span>
              ${overlapBadge}
            </div>
            <div class="search-item-ulpin">${highlightMatch(item.ulpin, query)}</div>
            <div class="search-item-sub">${escapeHtml(item.label)}</div>
          </div>
        </div>
      `;
    }).join('');

    searchDropdown.innerHTML = html;
    searchDropdown.hidden = false;

    // Attach click listeners to dropdown items
    searchDropdown.querySelectorAll('.search-item').forEach(el => {
      el.addEventListener('click', () => {
        const idx = parseInt(el.dataset.index, 10);
        selectSearchResult(state.searchResults[idx]);
      });
    });
  }

  function selectSearchResult(item) {
    if (!item) return;

    searchInput.value = item.ulpin;
    searchDropdown.hidden = true;

    // Switch layer if floor or underground selected
    if (item.type === 'floor') {
      if (item.floor < 0) {
        setLayer('utilities');
      } else {
        setLayer('floors');
      }
    } else if (state.layer === 'utilities' && item.type === 'property') {
      setLayer('surface');
    }

    // Fly to and select property
    setSelection(item.property, { floor: item.floor, flyTo: true });
  }

  // SEARCH INPUT EVENT LISTENERS
  searchInput.addEventListener('input', e => {
    performSearch(e.target.value);
  });

  searchInput.addEventListener('keydown', e => {
    if (searchDropdown.hidden || !state.searchResults?.length) {
      if (e.key === 'Enter' && searchInput.value.trim()) {
        performSearch(searchInput.value);
        if (state.searchResults?.length) selectSearchResult(state.searchResults[0]);
      }
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      state.selectedIndex = (state.selectedIndex + 1) % state.searchResults.length;
      renderDropdownResults(searchInput.value);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      state.selectedIndex = (state.selectedIndex - 1 + state.searchResults.length) % state.searchResults.length;
      renderDropdownResults(searchInput.value);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (state.selectedIndex >= 0 && state.selectedIndex < state.searchResults.length) {
        selectSearchResult(state.searchResults[state.selectedIndex]);
      }
    } else if (e.key === 'Escape') {
      searchDropdown.hidden = true;
    }
  });

  searchClearBtn.addEventListener('click', () => {
    searchInput.value = '';
    searchDropdown.hidden = true;
    searchClearBtn.hidden = true;
    searchInput.focus();
  });

  // Global Keyboard Shortcut: '/' to focus search
  window.addEventListener('keydown', e => {
    if (e.key === '/' && document.activeElement !== searchInput) {
      e.preventDefault();
      searchInput.focus();
      searchInput.select();
    }
  });

  // Hide dropdown on outside click
  document.addEventListener('click', e => {
    if (!document.getElementById('searchWidget').contains(e.target)) {
      searchDropdown.hidden = true;
    }
  });

  // Quick Jump Chips Handler
  document.querySelectorAll('.quick-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const ulpin = chip.dataset.ulpin;
      const item = searchIndex.find(i => i.ulpin === ulpin && i.type === 'property');
      if (item) {
        searchInput.value = item.ulpin;
        searchClearBtn.hidden = false;
        selectSearchResult(item);
      }
    });
  });

  // Unit Toggle (Metric m² vs Imperial sq ft)
  unitToggleBtn.addEventListener('click', () => {
    state.unitSystem = state.unitSystem === 'metric' ? 'imperial' : 'metric';
    updatePanel();
    render();
  });

  // ==========================================
  // POINTER & CANVAS NAVIGATION
  // ==========================================
  canvas.addEventListener('pointerdown', e => {
    canvas.setPointerCapture(e.pointerId);
    state.dragging = true;
    state.moved = false;
    state.lastX = e.clientX;
    state.lastY = e.clientY;
    state.pointer = { x: e.clientX - frame.getBoundingClientRect().left, y: e.clientY - frame.getBoundingClientRect().top };
    canvas.style.cursor = 'grabbing';
  });

  canvas.addEventListener('pointermove', e => {
    const rect = frame.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    state.pointer = { x, y };

    if (!state.dragging) {
      render();
      return;
    }

    const dx = e.clientX - state.lastX, dy = e.clientY - state.lastY;
    state.lastX = e.clientX;
    state.lastY = e.clientY;

    if (Math.abs(dx) + Math.abs(dy) > 1) state.moved = true;

    if (e.shiftKey || e.buttons === 4) {
      camera.panX += dx;
      camera.panY += dy;
    } else {
      camera.angle += dx * 0.008;
      camera.tilt = clamp(camera.tilt + dy * 0.003, 0.3, 0.94);
    }
    render();
  });

  canvas.addEventListener('pointerup', e => {
    if (state.dragging && !state.moved) {
      const rect = frame.getBoundingClientRect();
      const hit = pick(e.clientX - rect.left, e.clientY - rect.top);
      if (hit) setSelection(hit.item, { flyTo: false });
    }
    state.dragging = false;
    canvas.style.cursor = 'grab';
  });

  canvas.addEventListener('pointercancel', () => { state.dragging = false; });

  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    camera.zoom = clamp(camera.zoom * (e.deltaY < 0 ? 1.1 : 0.9), 0.63, 2.2);
    render();
  }, { passive: false });

  canvas.addEventListener('keydown', e => {
    if (e.key === '+' || e.key === '=') camera.zoom = clamp(camera.zoom * 1.1, 0.63, 2.2);
    else if (e.key === '-') camera.zoom = clamp(camera.zoom * 0.9, 0.63, 2.2);
    else if (e.key === 'ArrowLeft') camera.angle -= 0.1;
    else if (e.key === 'ArrowRight') camera.angle += 0.1;
    else return;
    render();
    e.preventDefault();
  });

  document.getElementById('zoomIn').addEventListener('click', () => {
    camera.zoom = clamp(camera.zoom * 1.14, 0.63, 2.2);
    render();
  });

  document.getElementById('zoomOut').addEventListener('click', () => {
    camera.zoom = clamp(camera.zoom / 1.14, 0.63, 2.2);
    render();
  });

  document.getElementById('resetView').addEventListener('click', () => {
    flyTo({ panX: initial.panX, panY: initial.panY, zoom: initial.zoom, angle: initial.angle, tilt: initial.tilt });
  });

  document.querySelectorAll('.layer-button').forEach(btn => btn.addEventListener('click', () => setLayer(btn.dataset.layer)));
  document.getElementById('closePanel').addEventListener('click', () => { panel.classList.add('is-hidden'); showDetails.hidden = false; });
  showDetails.addEventListener('click', () => { panel.classList.remove('is-hidden'); showDetails.hidden = true; });

  const dialog = document.getElementById('aboutDialog');
  document.getElementById('aboutBtn').addEventListener('click', () => dialog.showModal());
  ['closeAbout', 'doneAbout'].forEach(id => document.getElementById(id).addEventListener('click', () => dialog.close()));
  dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close(); });

  window.addEventListener('resize', resize);

  // Initial setup
  updatePanel();
  resize();
})();
