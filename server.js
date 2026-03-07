/**
 * Jackbox Mirror Server — улучшенная версия
 *
 * Изменения:
 *  1. Проксирует /main/* напрямую на официальный jackboxgames.com (не через jackbox.fun)
 *  2. Проксирует ecast и blobcast для всех версий паков
 *  3. Инжектирует __JACKBOX_SERVER__ и __JACKBOX_DOMAIN__ в index.htm
 *  4. Поддержка ?server= для переключения ecast-сервера
 */

const path    = require('path');
const express = require('express');
const https   = require('https');
const http    = require('http');
const app     = express();

// ── Конфиг ────────────────────────────────────────────────────────────────────
// Твой домен (после деплоя замени на реальный)
const YOUR_DOMAIN   = process.env.YOUR_DOMAIN || 'your-domain.onrender.com';

// Официальные серверы (больше НЕ зависим от jackbox.fun)
const BUNDLES_HOST  = 'cdn.jackboxgames.com';
const ECAST_HOST    = 'ecast.jackboxgames.com';
const BLOBCAST_HOST = 'blobcast.jackboxgames.com';
const API_HOST      = 'api.jackboxgames.com';

// ── Прокси-хелпер ─────────────────────────────────────────────────────────────
function proxyRequest(targetHost, targetPath, req, res) {
    console.log(`[proxy] -> https://${targetHost}${targetPath}`);

    const options = {
        hostname: targetHost,
        port: 443,
        path: targetPath,
        method: req.method,
        headers: {
            'User-Agent':       'Mozilla/5.0',
            'Accept':           req.headers['accept']           || '*/*',
            'Accept-Encoding':  'identity',
            'Accept-Language':  req.headers['accept-language']  || 'ru,en',
            'Host':             targetHost,
            'Origin':           `https://${targetHost}`,
            'Referer':          `https://${targetHost}/`,
        }
    };

    const proxyReq = https.request(options, (proxyRes) => {
        console.log(`[proxy] <- ${proxyRes.statusCode} ${targetPath}`);

        const headers = {};
        ['content-type','content-length','cache-control','last-modified','etag','transfer-encoding'].forEach(h => {
            if (proxyRes.headers[h]) headers[h] = proxyRes.headers[h];
        });
        headers['access-control-allow-origin']  = '*';
        headers['access-control-allow-headers'] = '*';

        res.writeHead(proxyRes.statusCode, headers);
        proxyRes.pipe(res, { end: true });
    });

    proxyReq.on('error', (err) => {
        console.error(`[proxy] ERROR ${targetPath}:`, err.message);
        if (!res.headersSent) res.status(502).send('Proxy error: ' + err.message);
    });

    if (req.method !== 'GET' && req.method !== 'HEAD') {
        req.pipe(proxyReq, { end: true });
    } else {
        proxyReq.end();
    }
}

// ── Роуты ─────────────────────────────────────────────────────────────────────

// CORS preflight
app.options('*', (req, res) => {
    res.set({
        'access-control-allow-origin':  '*',
        'access-control-allow-headers': '*',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
    }).sendStatus(204);
});

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', domain: YOUR_DOMAIN, time: new Date().toISOString() });
});

// Бандлы игр → напрямую на официальный CDN (раньше шло через jackbox.fun)
app.use('/main', (req, res) => {
    proxyRequest(BUNDLES_HOST, '/main' + req.url, req, res);
});

// Ecast API (Pack 7+)
app.use('/ecast', (req, res) => {
    proxyRequest(ECAST_HOST, '/ecast' + req.url, req, res);
});
app.use('/api/v2', (req, res) => {
    proxyRequest(ECAST_HOST, '/api/v2' + req.url, req, res);
});

// Blobcast (Pack 1–6, Socket.IO)
app.use('/room', (req, res) => {
    proxyRequest(BLOBCAST_HOST, '/room' + req.url, req, res);
});
app.use('/socket.io', (req, res) => {
    proxyRequest(BLOBCAST_HOST, '/socket.io' + req.url, req, res);
});
app.use('/bc', (req, res) => {
    proxyRequest(BLOBCAST_HOST, '/bc' + req.url, req, res);
});

// Общий API
app.use('/api', (req, res) => {
    proxyRequest(API_HOST, '/api' + req.url, req, res);
});

// Статика (css, js, иконки)
app.use(express.static(path.join(__dirname, '/')));

// Главная страница — инжектируем конфиг внутрь HTML
app.get('/', (req, res) => {
    const fs = require('fs');
    let html = fs.readFileSync(path.join(__dirname, 'index.htm'), 'utf-8');

    // Вставляем конфиг перед </head> — script-0.js прочитает эти переменные
    const inject = `
    <script>
      // Jackbox Mirror config — автоматически подставляет твой домен
      window.__JACKBOX_DOMAIN__ = "${YOUR_DOMAIN}";
      window.__JACKBOX_SERVER__ = "ecast.jackboxgames.com";
    </script>`;

    html = html.replace('</head>', inject + '\n</head>');
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(html);
});

// ── Запуск ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3333;
app.listen(PORT, () => {
    console.log('');
    console.log('╔══════════════════════════════════════════════════╗');
    console.log('║        Jackbox Mirror  — улучшенная версия       ║');
    console.log('╚══════════════════════════════════════════════════╝');
    console.log(`  Порт      : ${PORT}`);
    console.log(`  Домен     : https://${YOUR_DOMAIN}`);
    console.log(`  Бандлы    : cdn.jackboxgames.com (официальный CDN)`);
    console.log(`  Ecast     : ecast.jackboxgames.com (Pack 7+)`);
    console.log(`  Blobcast  : blobcast.jackboxgames.com (Pack 1–6)`);
    console.log(`  Health    : http://localhost:${PORT}/health`);
    console.log('');
    console.log('  ✅ Больше НЕ зависит от jackbox.fun');
    console.log('');
});
