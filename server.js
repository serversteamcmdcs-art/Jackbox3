const http = require('http');
const https = require('https');
const httpProxy = require('http-proxy');
const WebSocket = require('ws');

// Целевые официальные сервера Jackbox
const ECAST_TARGET = 'https://ecast.jackboxgames.com';
const BLOBCAST_TARGET = 'https://blobcast.jackboxgames.com';

const proxy = httpProxy.createProxyServer({
  target: ECAST_TARGET,
  changeOrigin: true,
  ws: true,  // Важно! Jackbox использует WebSocket
  secure: true,
  headers: {
    'host': 'ecast.jackboxgames.com'
  }
});

proxy.on('error', (err, req, res) => {
  console.error('Proxy error:', err.message);
  if (res && res.writeHead) {
    res.writeHead(502);
    res.end('Proxy error');
  }
});

// Подменяем заголовки ответа — убираем CORS-проблемы
proxy.on('proxyRes', (proxyRes, req, res) => {
  proxyRes.headers['access-control-allow-origin'] = '*';
  proxyRes.headers['access-control-allow-headers'] = '*';
});

const server = http.createServer((req, res) => {
  // Определяем, куда проксировать по пути
  if (req.url.startsWith('/blobcast')) {
    proxy.web(req, res, { target: BLOBCAST_TARGET });
  } else {
    proxy.web(req, res, { target: ECAST_TARGET });
  }
});

// WebSocket поддержка (критично для Jackbox!)
server.on('upgrade', (req, socket, head) => {
  proxy.ws(req, socket, head, { target: ECAST_TARGET });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Jackbox proxy running on port ${PORT}`);
});
