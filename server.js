/**
 * Jackbox Universal Proxy Server
 * ================================
 * Supports ALL Jackbox Party Pack versions:
 *
 * Pack 1–6  → Blobcast  (Socket.IO / HTTP REST)
 * Pack 7+   → Ecast v2  (WebSocket native)
 *
 * Deploy on Render → set as serverUrl in jbg.config
 */

const http = require('http');
const httpProxy = require('http-proxy');

// ─── Official Jackbox servers ───────────────────────────────────────────────
const TARGETS = {
  ecast:    'https://ecast.jackboxgames.com',    // Pack 7+ (new WS API)
  blobcast: 'https://blobcast.jackboxgames.com', // Pack 1–6 (Socket.IO)
  api:      'https://api.jackboxgames.com',       // General API
  cdn:      'https://bundles.jackboxgames.com',   // Asset CDN
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
function getTarget(url) {
  // Blobcast routes: /room/, /socket.io/, /bc/
  if (url.startsWith('/room/')   ||
      url.startsWith('/socket.io') ||
      url.startsWith('/bc/'))        return TARGETS.blobcast;

  // API routes
  if (url.startsWith('/api/'))       return TARGETS.api;

  // CDN / bundles
  if (url.startsWith('/bundles/'))   return TARGETS.cdn;

  // Default → Ecast (Pack 7+)
  return TARGETS.ecast;
}

function getHostname(target) {
  return target.replace('https://', '').replace('http://', '');
}

// ─── Create proxy instances (one per upstream) ───────────────────────────────
function makeProxy(target) {
  const p = httpProxy.createProxyServer({
    target,
    changeOrigin: true,
    secure: true,
    ws: true,
    headers: { host: getHostname(target) },
  });

  p.on('error', (err, req, res) => {
    console.error(`[PROXY ERROR] ${target} → ${err.message}`);
    try {
      if (res && res.writeHead && !res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('Proxy error: ' + err.message);
      }
    } catch (_) {}
  });

  // Inject CORS headers so browser clients never get blocked
  p.on('proxyRes', (proxyRes) => {
    proxyRes.headers['access-control-allow-origin']      = '*';
    proxyRes.headers['access-control-allow-headers']     = '*';
    proxyRes.headers['access-control-allow-methods']     = 'GET,POST,PUT,DELETE,OPTIONS,PATCH';
    proxyRes.headers['access-control-allow-credentials'] = 'true';
  });

  return p;
}

const proxies = {
  ecast:    makeProxy(TARGETS.ecast),
  blobcast: makeProxy(TARGETS.blobcast),
  api:      makeProxy(TARGETS.api),
  cdn:      makeProxy(TARGETS.cdn),
};

function getProxyKey(url) {
  if (url.startsWith('/room/')    ||
      url.startsWith('/socket.io')||
      url.startsWith('/bc/'))       return 'blobcast';
  if (url.startsWith('/api/'))      return 'api';
  if (url.startsWith('/bundles/'))  return 'cdn';
  return 'ecast';
}

// ─── HTTP server ─────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  // Pre-flight CORS
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin':  '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS,PATCH',
      'access-control-max-age':       '86400',
    });
    return res.end();
  }

  // Health check endpoint (for Render, UptimeRobot, etc.)
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      status: 'ok',
      proxy:  'Jackbox Universal Proxy',
      targets: TARGETS,
      time:   new Date().toISOString(),
    }));
  }

  const key = getProxyKey(req.url);
  const target = TARGETS[key];

  console.log(`[${new Date().toISOString()}] HTTP  ${req.method} ${req.url} → ${target}`);
  proxies[key].web(req, res, { target });
});

// ─── WebSocket upgrade (critical for Ecast v2 & Socket.IO) ───────────────────
server.on('upgrade', (req, socket, head) => {
  const key = getProxyKey(req.url);
  const target = TARGETS[key];

  console.log(`[${new Date().toISOString()}] WS    UPGRADE ${req.url} → ${target}`);
  proxies[key].ws(req, socket, head, { target });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Jackbox Universal Proxy — ALL versions supported');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  Port    : ${PORT}`);
  console.log(`  Ecast   : ${TARGETS.ecast}   (Pack 7+)`);
  console.log(`  Blobcast: ${TARGETS.blobcast} (Pack 1–6)`);
  console.log(`  Health  : http://localhost:${PORT}/health`);
  console.log('═══════════════════════════════════════════════════');
});
