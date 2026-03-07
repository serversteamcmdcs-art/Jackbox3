/**
 * Jackbox Mirror Server v4
 *
 * КЛЮЧЕВОЕ ИСПРАВЛЕНИЕ:
 * Ecast возвращает JSON с "host": "blobcast.jackboxgames.com"
 * Браузер подключается к этому хосту НАПРЯМУЮ, минуя наш прокси.
 * Blobcast блокирует запросы не с jackbox.tv → бесконечная загрузка.
 *
 * Решение: перехватываем JSON ответы ecast и заменяем host на наш домен.
 * Тогда браузер подключается к НАМ, а мы проксируем на blobcast со спуфингом.
 */

const path      = require('path');
const fs        = require('fs');
const http      = require('http');
const https     = require('https');
const express   = require('express');
const httpProxy = require('http-proxy');

const app = express();

// ── Конфиг ────────────────────────────────────────────────────────────────────
const YOUR_DOMAIN   = process.env.YOUR_DOMAIN || 'jackbox3.onrender.com';
const BUNDLES_HOST  = 'jackbox.fun';
const ECAST_HOST    = 'ecast.jackboxgames.com';
const BLOBCAST_HOST = 'blobcast.jackboxgames.com';
const API_HOST      = 'api.jackboxgames.com';

// Хосты которые нужно заменять в JSON ответах на наш домен
const REPLACE_HOSTS = [
    ECAST_HOST,
    BLOBCAST_HOST,
    API_HOST,
    'jackbox.tv',
    'dev.jackbox.tv',
];

// ── Статика ───────────────────────────────────────────────────────────────────
function findStaticDir() {
    const candidates = [__dirname, path.join(__dirname,'client'), process.cwd(), path.join(process.cwd(),'client')];
    const found = candidates.find(p => fs.existsSync(path.join(p, 'index.htm')));
    console.log('[static]', found ? 'найдено: ' + found : 'НЕ НАЙДЕНО');
    return found || __dirname;
}
const STATIC_DIR = findStaticDir();

// ── WebSocket прокси (Blobcast Socket.IO — Pack 1–6) ─────────────────────────
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

// WebSocket прокси для Ecast (Pack 7+)
const wsEcastProxy = httpProxy.createProxyServer({
    target: 'https://' + ECAST_HOST,
    changeOrigin: true,
    secure: true,
    ws: true,
    headers: {
        'host':    ECAST_HOST,
        'origin':  'https://jackbox.tv',
        'referer': 'https://jackbox.tv/',
    },
});
wsEcastProxy.on('error', (err) => console.error('[ws-ecast] ERROR:', err.message));

// ── HTTP прокси с перехватом JSON ─────────────────────────────────────────────
// replaceHosts: заменить все упоминания официальных хостов на наш домен
function proxyTo(host, fullPath, req, res, spoofOrigin, replaceHosts) {
    console.log('[proxy] ->', host + fullPath);

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
        console.log('[proxy] <-', proxyRes.statusCode, fullPath);

        const outHeaders = {
            'access-control-allow-origin':      '*',
            'access-control-allow-headers':      '*',
            'access-control-allow-methods':      'GET,POST,PUT,DELETE,OPTIONS',
            'access-control-allow-credentials':  'true',
        };
        const ct = proxyRes.headers['content-type'] || '';
        ['content-type','cache-control','last-modified','etag','set-cookie']
            .forEach(h => { if (proxyRes.headers[h]) outHeaders[h] = proxyRes.headers[h]; });
        delete outHeaders['x-frame-options'];
        delete outHeaders['content-security-policy'];

        // Если это JSON и нужна замена хостов — буферизуем и патчим
        if (replaceHosts && (ct.includes('json') || ct.includes('javascript'))) {
            const chunks = [];
            proxyRes.on('data', chunk => chunks.push(chunk));
            proxyRes.on('end', () => {
                let body = Buffer.concat(chunks).toString('utf-8');
                let patched = false;

                // Заменяем все официальные хосты на наш домен в JSON
                REPLACE_HOSTS.forEach(h => {
                    if (body.includes(h)) {
                        body = body.split(h).join(YOUR_DOMAIN);
                        patched = true;
                    }
                });

                if (patched) {
                    console.log('[patch] заменены хосты в ответе', fullPath);
                }

                // Убираем https:// перед нашим доменом если там было jackbox.tv
                // (наш домен уже содержит https в window.__JACKBOX_SERVER__)
                const bodyBuf = Buffer.from(body, 'utf-8');
                outHeaders['content-length'] = bodyBuf.length;
                res.writeHead(proxyRes.statusCode, outHeaders);
                res.end(bodyBuf);
            });
        } else {
            // Обычная потоковая передача
            if (proxyRes.headers['content-length']) outHeaders['content-length'] = proxyRes.headers['content-length'];
            if (proxyRes.headers['transfer-encoding']) outHeaders['transfer-encoding'] = proxyRes.headers['transfer-encoding'];
            res.writeHead(proxyRes.statusCode, outHeaders);
            proxyRes.pipe(res, { end: true });
        }
    });

    proxyReq.on('error', (err) => {
        console.error('[proxy] ERROR', err.message);
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

// Бандлы игр — jackbox.fun, без замены хостов
app.use('/main', (req, res) => proxyTo(BUNDLES_HOST, '/main' + req.url, req, res, false, false));

// Ecast API — с заменой хостов в JSON ответах!
// Именно здесь ecast возвращает "host": "blobcast.jackboxgames.com"
// Мы меняем его на наш домен → браузер подключается к нам, а не напрямую
app.use('/ecast', (req, res) => proxyTo(ECAST_HOST, '/ecast' + req.url, req, res, true, true));
app.use('/api/v2', (req, res) => proxyTo(ECAST_HOST, '/api/v2' + req.url, req, res, true, true));

// Blobcast HTTP + Socket.IO (Pack 1–6) — через wsProxy
app.use('/room',      (req, res) => wsProxy.web(req, res, { target: 'https://' + BLOBCAST_HOST }));
app.use('/socket.io', (req, res) => wsProxy.web(req, res, { target: 'https://' + BLOBCAST_HOST }));
app.use('/bc',        (req, res) => wsProxy.web(req, res, { target: 'https://' + BLOBCAST_HOST }));

// API
app.use('/api', (req, res) => proxyTo(API_HOST, '/api' + req.url, req, res, true, true));

// Статика
app.use(express.static(STATIC_DIR));

// Главная
app.get('/', (req, res) => {
    const indexPath = path.join(STATIC_DIR, 'index.htm');
    if (!fs.existsSync(indexPath)) return res.status(500).send('index.htm not found in ' + STATIC_DIR);
    let html = fs.readFileSync(indexPath, 'utf-8');
    const inject = '<script>\nwindow.__JACKBOX_DOMAIN__ = "' + YOUR_DOMAIN + '";\nwindow.__JACKBOX_SERVER__ = "ecast.jackboxgames.com";\n</script>';
    html = html.replace('</head>', inject + '\n</head>');
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(html);
});

// ── HTTP сервер с WebSocket Upgrade ──────────────────────────────────────────
const PORT   = process.env.PORT || 3333;
const server = http.createServer(app);

server.on('upgrade', (req, socket, head) => {
    const url = req.url || '';
    if (url.startsWith('/room') || url.startsWith('/socket.io') || url.startsWith('/bc')) {
        console.log('[ws-upgrade] blobcast ->', url);
        wsProxy.ws(req, socket, head, { target: 'https://' + BLOBCAST_HOST });
    } else {
        console.log('[ws-upgrade] ecast ->', url);
        wsEcastProxy.ws(req, socket, head, { target: 'https://' + ECAST_HOST });
    }
});

server.listen(PORT, () => {
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log(  '║        Jackbox Mirror v4 — с патчем хостов       ║');
    console.log(  '╚══════════════════════════════════════════════════╝');
    console.log('  Порт     :', PORT);
    console.log('  Домен    : https://' + YOUR_DOMAIN);
    console.log('  Патч     : заменяем хосты в JSON ответах ecast');
    console.log('  Бандлы   :', BUNDLES_HOST);
    console.log('  Ecast    :', ECAST_HOST, '(+JSON патч)');
    console.log('  Blobcast :', BLOBCAST_HOST, '(HTTP + WS)');
    console.log('  Origin   : spoofed as jackbox.tv\n');
});
