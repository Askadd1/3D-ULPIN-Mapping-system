'use strict';

// Local-only demo backend. It exposes fictional sample records as read-only JSON.
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 4173);
const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, 'data', 'neighborhood.json');
const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']]
]);

let neighborhood;

function sendJson(res, status, value) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(JSON.stringify(value));
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

async function handleRequest(req, res) {
  const requestUrl = new URL(req.url, `http://${HOST}:${PORT}`);
  const pathname = decodeURIComponent(requestUrl.pathname);

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return sendError(res, 405, 'This demo API is read-only.');
  }

  if (pathname === '/api/health') {
    return sendJson(res, 200, { status: 'ok', mode: 'local-demo' });
  }
  if (pathname === '/api/neighborhood') {
    return sendJson(res, 200, neighborhood);
  }
  if (pathname === '/api/properties') {
    const properties = neighborhood.properties.map(({ id, name, kind, demoId, floors, status, label }) => ({ id, name, kind, demoId, floors, status, label }));
    return sendJson(res, 200, { properties });
  }
  if (pathname.startsWith('/api/properties/')) {
    const id = pathname.slice('/api/properties/'.length);
    const property = neighborhood.properties.find(item => item.id === id);
    return property ? sendJson(res, 200, property) : sendError(res, 404, 'Sample property not found.');
  }

  const asset = STATIC_FILES.get(pathname);
  if (asset) {
    try {
      const body = await fs.readFile(path.join(ROOT, asset[0]));
      res.writeHead(200, { 'Content-Type': asset[1], 'X-Content-Type-Options': 'nosniff' });
      return res.end(body);
    } catch (error) {
      console.error(`Could not read ${asset[0]}:`, error);
      return sendError(res, 500, 'A local demo file could not be read.');
    }
  }

  return sendError(res, 404, 'Route not found.');
}

async function start() {
  neighborhood = JSON.parse(await fs.readFile(DATA_FILE, 'utf8'));
  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch(error => {
      console.error('Request failed:', error);
      if (!res.headersSent) sendError(res, 500, 'The local demo backend encountered an error.');
      else res.destroy(error);
    });
  });

  server.listen(PORT, HOST, () => {
    console.log(`3D ULPIN demo is running at http://${HOST}:${PORT}`);
    console.log('Press Ctrl+C to stop. This server only uses fictional local sample data.');
  });
}

start().catch(error => {
  console.error('Could not start the demo backend:', error);
  process.exitCode = 1;
});
