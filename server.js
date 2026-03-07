/**
 * Jackbox Mirror Server
 *
 * Что делает:
 *  - Отдаёт статику (index.htm, script-0.js, style-0.css) локально
 *  - /main/*   → jackbox.fun (бандлы игр — script.js, style-0.css каждой игры)
 *  - /ecast/*  → ecast.jackboxgames.com  (Pack 7+, WebSocket)
 *  - /room/*   → blobcast.jackboxgames.com (Pack 1–6, Socket.IO)
 *  - /api/*    → api.jackboxgames.com
 *  - Инжектирует window.__JACKBOX_DOMAIN__ в HTML
 */

const path    = require('path');
const fs      = require('fs');
const express = require('express');
const https   = require('https');
const app     = express();

// ── Конфиг ────────────────────────────────────────────────────────────────────
const YOUR_DOMAIN   = process.env.YOUR_DOMAIN || 'your-domain.onrender.com';

const BUNDLES_HOST  = 'jackbox.fun';
const ECAST_HOST    = 'ecast.jackboxgames.com';
const BLOBCAST_HOST = 'blobcast.jackboxgames.com';
const API_HOST      = 'api.jackboxgames.com';

// ── Найти папку со статикой ───────────────────────────────────────────────────
function findStaticDir() {
    const candidates = [
        __dirname,
        path.join(__dirname, 'client'),
        process.cwd(),
        path.join(process.cwd(), 'client'),
    ];
    const found = candidates.find(p => fs.existsSync(path.join(p, 'index.htm')));
    console.log('[static] найдено в:', found || 'НЕ НАЙДЕНО');
    return found || __dirname;
}
const STATIC_DIR = findStaticDir();

// ── Прокси-хелпер ─────────────────────────────────────────────────────────────
function proxyTo(host, fullPath, req, res) {
    console.log('[proxy] ->', host + fullPath);
    const options = {
        hostname: host, port: 443, path: fullPath, method: 'GET',
        headers: {
            'User-Agent': 'Mozilla/5.0', 'Accept': '*/*',
            'Accept-Encoding': 'identity', 'Host': host,
            'Referer': 'https://' + host + '/',
        },
    };
    const proxyReq = https.request(options, (proxyRes) => {
        console.log('[proxy] <-', proxyRes.statusCode, fullPath);
        const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
        ['content-type','content-length','cache-control','last-modified','etag','transfer-encoding']
            .forEach(h => { if (proxyRes.headers[h]) headers[h] = proxyRes.headers[h]; });
        res.writeHead(proxyRes.statusCode, headers);
        proxyRes.pipe(res, { end: true });
    });
    proxyReq.on('error', (err) => {
        console.error('[proxy] ERROR', host + fullPath, err.message);
        if (!res.headersSent) res.status(502).send('Proxy error: ' + err.message);
    });
    proxyReq.end();
}

// ── Роуты ─────────────────────────────────────────────────────────────────────

app.options('*', (_, res) => res.set({
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
}).sendStatus(204));

app.get('/health', (_, res) => res.json({ status: 'ok', domain: YOUR_DOMAIN, time: new Date().toISOString() }));

// Бандлы игр (script.js/style-0.css каждой игры) — через jackbox.fun
app.use('/main', (req, res) => proxyTo(BUNDLES_HOST, '/main' + req.url, req, res));

// Ecast — Pack 7+
app.use('/ecast', (req, res) => proxyTo(ECAST_HOST, '/ecast' + req.url, req, res));
app.use('/api/v2', (req, res) => proxyTo(ECAST_HOST, '/api/v2' + req.url, req, res));

// Blobcast — Pack 1–6
app.use('/room',      (req, res) => proxyTo(BLOBCAST_HOST, '/room'      + req.url, req, res));
app.use('/socket.io', (req, res) => proxyTo(BLOBCAST_HOST, '/socket.io' + req.url, req, res));
app.use('/bc',        (req, res) => proxyTo(BLOBCAST_HOST, '/bc'        + req.url, req, res));

// API
app.use('/api', (req, res) => proxyTo(API_HOST, '/api' + req.url, req, res));

// Статика
app.use(express.static(STATIC_DIR));

// Главная — инжектируем конфиг
app.get('/', (req, res) => {
    const indexPath = path.join(STATIC_DIR, 'index.htm');
    if (!fs.existsSync(indexPath)) {
        return res.status(500).send('index.htm not found in ' + STATIC_DIR);
    }
    let html = fs.readFileSync(indexPath, 'utf-8');
    const inject = '<script>\nwindow.__JACKBOX_DOMAIN__ = "' + YOUR_DOMAIN + '";\nwindow.__JACKBOX_SERVER__ = "ecast.jackboxgames.com";\n</script>';
    html = html.replace('</head>', inject + '\n</head>');
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(html);
});

// ── Запуск ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3333;
app.listen(PORT, () => {
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log(  '║           Jackbox Mirror — готов к работе        ║');
    console.log(  '╚══════════════════════════════════════════════════╝');
    console.log('  Порт     :', PORT);
    console.log('  Домен    : https://' + YOUR_DOMAIN);
    console.log('  Статика  :', STATIC_DIR);
    console.log('  Бандлы   : https://' + BUNDLES_HOST + '/main/...');
    console.log('  Ecast    : https://' + ECAST_HOST + ' (Pack 7+)');
    console.log('  Blobcast : https://' + BLOBCAST_HOST + ' (Pack 1–6)\n');
});
