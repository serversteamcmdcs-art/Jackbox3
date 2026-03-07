/**
 * Jackbox Mirror Server v3
 *
 * Ключевое отличие от v2:
 *  - /room/ и /socket.io/ используют http-proxy с поддержкой WebSocket (WS Upgrade)
 *  - Обычные HTTP запросы к ecast/api через https.request со спуфингом Origin
 *  - Все запросы притворяются что идут с jackbox.tv
 */

const path     = require('path');
const fs       = require('fs');
const http     = require('http');
const https    = require('https');
const express  = require('express');
const httpProxy = require('http-proxy');

const app = express();

// ── Конфиг ────────────────────────────────────────────────────────────────────
const YOUR_DOMAIN   = process.env.YOUR_DOMAIN || 'jackbox3.onrender.com';
const BUNDLES_HOST  = 'jackbox.fun';
const ECAST_HOST    = 'ecast.jackboxgames.com';
const BLOBCAST_HOST = 'blobcast.jackboxgames.com';
const API_HOST      = 'api.jackboxgames.com';

// ── Статика ───────────────────────────────────────────────────────────────────
function findStaticDir() {
    const candidates = [__dirname, path.join(__dirname,'client'), process.cwd(), path.join(process.cwd(),'client')];
    const found = candidates.find(p => fs.existsSync(path.join(p, 'index.htm')));
    console.log('[static]', found ? 'найдено: ' + found : 'НЕ НАЙДЕНО');
    return found || __dirname;
}
const STATIC_DIR = findStaticDir();

// ── WebSocket прокси (для Blobcast Socket.IO — Pack 1–6) ──────────────────────
const wsProxy = httpProxy.createProxyServer({
    target: 'https://' + BLOBCAST_HOST,
    changeOrigin: true,
    secure: true,
    ws: true,
    headers: {
        'host':    BLOBCAST_HOST,
        'origin':  'https://jackbox.tv',
        'referer': 'https://jackbox.tv/',
    },
});

wsProxy.on('error', (err, req, res) => {
    console.error('[ws-proxy] ERROR:', err.message);
    try { if (res && !res.headersSent) res.writeHead(502); res.end(); } catch(_) {}
});

wsProxy.on('proxyRes', (proxyRes) => {
    proxyRes.headers['access-control-allow-origin'] = '*';
    delete proxyRes.headers['content-security-policy'];
});

// ── HTTP прокси-хелпер (для ecast, api, bundles) ──────────────────────────────
function proxyTo(host, fullPath, req, res, spoofOrigin) {
    console.log('[http-proxy] ->', host + fullPath);

    const headers = {
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept':          req.headers['accept'] || '*/*',
        'Accept-Language': req.headers['accept-language'] || 'ru-RU,ru;q=0.9,en;q=0.8',
        'Accept-Encoding': 'identity',
        'Host':            host,
    };
    if (spoofOrigin) {
        headers['Origin']  = 'https://jackbox.tv';
        headers['Referer'] = 'https://jackbox.tv/';
    } else {
        headers['Referer'] = 'https://' + host + '/';
    }
    if (req.headers['authorization']) headers['Authorization'] = req.headers['authorization'];
    if (req.headers['content-type'])  headers['Content-Type']  = req.headers['content-type'];

    const options = { hostname: host, port: 443, path: fullPath, method: req.method || 'GET', headers };

    const proxyReq = https.request(options, (proxyRes) => {
        console.log('[http-proxy] <-', proxyRes.statusCode, fullPath);
        const outHeaders = {
            'access-control-allow-origin':     '*',
            'access-control-allow-headers':    '*',
            'access-control-allow-methods':    'GET,POST,PUT,DELETE,OPTIONS',
            'access-control-allow-credentials':'true',
        };
        ['content-type','content-length','cache-control','last-modified','etag','transfer-encoding','set-cookie']
            .forEach(h => { if (proxyRes.headers[h]) outHeaders[h] = proxyRes.headers[h]; });
        delete outHeaders['x-frame-options'];
        delete outHeaders['content-security-policy'];
        res.writeHead(proxyRes.statusCode, outHeaders);
        proxyRes.pipe(res, { end: true });
    });

    proxyReq.on('error', (err) => {
        console.error('[http-proxy] ERROR', err.message);
        if (!res.headersSent) res.status(502).send('Proxy error: ' + err.message);
    });
    if (!['GET','HEAD'].includes(req.method)) req.pipe(proxyReq, { end: true });
    else proxyReq.end();
}

// ── Express роуты ─────────────────────────────────────────────────────────────

app.options('*', (_, res) => res.set({
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
}).sendStatus(204));

app.get('/health', (_, res) => res.json({ status: 'ok', domain: YOUR_DOMAIN, time: new Date().toISOString() }));

// Бандлы (script.js каждой игры) — jackbox.fun
app.use('/main', (req, res) => proxyTo(BUNDLES_HOST, '/main' + req.url, req, res, false));

// Ecast HTTP API (Pack 7+) — с Origin: jackbox.tv
app.use('/ecast', (req, res) => proxyTo(ECAST_HOST, '/ecast' + req.url, req, res, true));
app.use('/api/v2', (req, res) => proxyTo(ECAST_HOST, '/api/v2' + req.url, req, res, true));

// Blobcast HTTP + Socket.IO (Pack 1–6)
// /room/ и /socket.io/ идут через wsProxy (умеет WebSocket Upgrade)
app.use('/room',      (req, res) => wsProxy.web(req, res, { target: 'https://' + BLOBCAST_HOST }));
app.use('/socket.io', (req, res) => wsProxy.web(req, res, { target: 'https://' + BLOBCAST_HOST }));
app.use('/bc',        (req, res) => wsProxy.web(req, res, { target: 'https://' + BLOBCAST_HOST }));

// API
app.use('/api', (req, res) => proxyTo(API_HOST, '/api' + req.url, req, res, true));

// Статика
app.use(express.static(STATIC_DIR));

// Главная — инжектируем конфиг
app.get('/', (req, res) => {
    const indexPath = path.join(STATIC_DIR, 'index.htm');
    if (!fs.existsSync(indexPath)) return res.status(500).send('index.htm not found in ' + STATIC_DIR);
    let html = fs.readFileSync(indexPath, 'utf-8');
    const inject = '<script>\nwindow.__JACKBOX_DOMAIN__ = "' + YOUR_DOMAIN + '";\nwindow.__JACKBOX_SERVER__ = "ecast.jackboxgames.com";\n</script>';
    html = html.replace('</head>', inject + '\n</head>');
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(html);
});

// ── Создаём HTTP сервер вручную (нужно для WS Upgrade) ────────────────────────
const PORT = process.env.PORT || 3333;
const server = http.createServer(app);

// WebSocket Upgrade — перенаправляем на wsProxy
server.on('upgrade', (req, socket, head) => {
    const url = req.url || '';
    if (url.startsWith('/room') || url.startsWith('/socket.io') || url.startsWith('/bc')) {
        console.log('[ws-upgrade] ->', BLOBCAST_HOST + url);
        wsProxy.ws(req, socket, head, { target: 'https://' + BLOBCAST_HOST });
    } else {
        // Ecast WebSocket (Pack 7+) — пробрасываем напрямую
        console.log('[ws-upgrade] ecast ->', ECAST_HOST + url);
        const wsEcast = httpProxy.createProxyServer({
            target: 'https://' + ECAST_HOST,
            changeOrigin: true, secure: true, ws: true,
            headers: { host: ECAST_HOST, origin: 'https://jackbox.tv' },
        });
        wsEcast.ws(req, socket, head, { target: 'https://' + ECAST_HOST });
    }
});

server.listen(PORT, () => {
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log(  '║        Jackbox Mirror v3 — готов к работе        ║');
    console.log(  '╚══════════════════════════════════════════════════╝');
    console.log('  Порт     :', PORT);
    console.log('  Домен    : https://' + YOUR_DOMAIN);
    console.log('  Статика  :', STATIC_DIR);
    console.log('  Бандлы   :', BUNDLES_HOST, '(HTTP)');
    console.log('  Ecast    :', ECAST_HOST, '(HTTP + WS, Pack 7+)');
    console.log('  Blobcast :', BLOBCAST_HOST, '(HTTP + WS Socket.IO, Pack 1–6)');
    console.log('  Origin   : spoofed as jackbox.tv\n');
});
