# 3D ULPIN Mapping System

> **Created by Team G**

A student prototype for exploring how land parcels, 3D floor units, and cadastral boundary conflicts can be visualized and measured in interactive 3D. The fictional Shantivan Layout includes sample homes, parcel boundaries, floor sub-ULPINs, streets, trees, and underground service routes. A lightweight Node.js backend serves the page and provides read-only JSON endpoints.

> **Prototype using sample data.** Nothing in this demo is an official ULPIN. It does not verify ownership or connect to government land records.

## Features

- **🔍 Google Maps-Style ULPIN Search Engine**:
  - Search by 14-digit ULPIN (e.g. `D-UL-2704-02117`), house name, parcel ID (`B-08`), or floor sub-ULPIN (`F01`, `B01`).
  - Smooth camera fly-to transition with animated radiating beacon pulses.
  - Automatic layer switching when floor-level or subsurface units are selected.
  - Quick-jump shortcut chips for one-click testing.

- **📐 Precise Boundary Overlap Measurement (m² & sq ft)**:
  - Automated cadastral conflict detection.
  - Computes exact encroached area in **square meters ($\text{m}^2$)** and **square feet ($\text{sq ft}$)**.
  - Displays linear encroachment dimensions ($\text{m} \times \text{m}$ / $\text{ft} \times \text{ft}$) and percentage of total parcel area affected.
  - Interactive $\text{m}^2 / \text{sq ft}$ unit toggle in the property inspector panel.
  - 3D visual hazard-hatched zone and floating measurement callouts on the canvas.

- **🏢 3D Spatial Units & Multi-layer Exploration**:
  - **Surface Layer**: 3D building prisms, parcel boundaries, trees, and overlap warnings.
  - **Building Floors Layer**: Exploded floor slabs with per-level sub-ULPIN badges.
  - **Underground Layer**: Subsurface utility networks (water, power, storm drainage) and basement structures.

## Run it

No API keys, accounts, installed packages, database, or external services are required. Install Node.js 18 or newer, then run:

```sh
npm start
# or
npm run dev
# or
node server.js
```

Open [http://localhost:4173](http://localhost:4173). Stop the server with `Ctrl+C`.

The server listens on `127.0.0.1` by default and uses port `4173`. To use a different port, set the `PORT` environment variable before starting it.

## Local API

All API routes are read-only and return sample data stored in `data/neighborhood.json`.

- `GET /api/health` — backend status.
- `GET /api/neighborhood` — scene geometry, scale factors, properties, trees, and utilities.
- `GET /api/properties` — short property list.
- `GET /api/properties/:id` — single sample property (e.g., `/api/properties/lot-b08`).

## Files

- [`index.html`](file:///index.html) — page structure, search bar widget, quick chips, map controls, and property panel.
- [`styles.css`](file:///styles.css) — responsive design, search dropdown styles, glassmorphism, and overlap inspector UI.
- [`app.js`](file:///app.js) — canvas rendering, camera fly-to, beacon pulse, search engine index & dropdown, overlap math, and layer switching.
- [`server.js`](file:///server.js) — zero-dependency Node.js HTTP server and static file server.
- [`package.json`](file:///package.json) — npm scripts (`start`, `dev`).
- [`data/neighborhood.json`](file:///data/neighborhood.json) — neighborhood geometry, scale factors, and overlap conflict data.

## Edit the sample neighborhood

Edit `data/neighborhood.json`. Each property contains a demo ID, floor count, floor units, boundary status, building footprint, parcel rectangle, and optional `overlapData`. The renderer uses native Canvas 2D APIs to draw an interactive isometric 3D illustration.
