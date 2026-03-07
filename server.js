/**
 * Jackbox Mirror Server
 *
 * Фикс 403 от ecast: подставляем Origin/Referer = jackbox.tv
 * чтобы официальные серверы не блокировали запросы.
 */

const path    = require('path');
const fs      = require('fs');
const express = require('express');
const https   = require('https');
const app     = express();

const YOUR_DOMAIN   = process.env.YOUR_DOMAIN || 'jackbox3.onrender.com';
const BUNDLES_HOST  = 'jackbox.fun';
const ECAST_HOST    = 'ecast.jackboxgames.com';
const BLOBCAST_HOST = 'blobcast.jackboxgames.com';
const API_HOST      = 'api.jackboxgames.com';

// ── Статика ───────────────────────────────────────────────────────────────────
function findStaticDir() {
    const candidates = [__dirname, path.join(__dirname,'client'), process.cwd(), path.join(process.cwd(),'client')];
    const found = candidates.find(p => fs.existsSync(path.join(p, 'index.htm')));
    console.log('[static]', found ? 'найдено в: ' + found : 'НЕ НАЙДЕНО');
    return found || __dirname;
}
const STATIC_DIR = findStaticDir();

// ── Прокси-хелпер ─────────────────────────────────────────────────────────────
// spoofOrigin: true — притворяемся jackbox.tv (нужно для ecast/blobcast/api)
// spoofOrigin: false — для jackbox.fun (бандлы, там не нужна маскировка)
function proxyTo(host, fullPath, req, res, spoofOrigin) {
    console.log('[proxy] ->', host + fullPath);

    const headers = {
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept':          req.headers['accept'] || '*/*',
        'Accept-Language': req.headers['accept-language'] || 'ru-RU,ru;q=0.9,en;q=0.8',
        'Accept-Encoding': 'identity',
        'Host':            host,
    };

    if (spoofOrigin) {
        // Эмулируем запрос с jackbox.tv — иначе ecast/api дают 403
        headers['Origin']  = 'https://jackbox.tv';
        headers['Referer'] = 'https://jackbox.tv/';
    } else {
        headers['Referer'] = 'https://' + host + '/';
    }

    // Пробрасываем Authorization если есть
    if (req.headers['authorization']) headers['Authorization'] = req.headers['authorization'];
    // Content-Type для POST
    if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];

    const options = { hostname: host, port: 443, path: fullPath, method: req.method || 'GET', headers };

    const proxyReq = https.request(options, (proxyRes) => {
        console.log('[proxy] <-', proxyRes.statusCode, fullPath);

        const outHeaders = {
            'access-control-allow-origin':      '*',
            'access-control-allow-headers':      '*',
            'access-control-allow-methods':      'GET,POST,PUT,DELETE,OPTIONS',
            'access-control-allow-credentials':  'true',
        };
        ['content-type','content-length','cache-control','last-modified','etag','transfer-encoding','set-cookie']
            .forEach(h => { if (proxyRes.headers[h]) outHeaders[h] = proxyRes.headers[h]; });

        // Убираем CORS-блокирующие заголовки из ответа
        delete outHeaders['x-frame-options'];
        delete outHeaders['content-security-policy'];

        res.writeHead(proxyRes.statusCode, outHeaders);
        proxyRes.pipe(res, { end: true });
    });

    proxyReq.on('error', (err) => {
        console.error('[proxy] ERROR', host + fullPath, err.message);
        if (!res.headersSent) res.status(502).send('Proxy error: ' + err.message);
    });

    // Для POST/PUT — пробрасываем тело
    if (!['GET','HEAD'].includes(req.method)) {
        req.pipe(proxyReq, { end: true });
    } else {
        proxyReq.end();
    }
}

// ── Роуты ─────────────────────────────────────────────────────────────────────

app.options('*', (_, res) => res.set({
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
}).sendStatus(204));

app.get('/health', (_, res) => res.json({ status: 'ok', domain: YOUR_DOMAIN, time: new Date().toISOString() }));

// Бандлы игр (script.js каждой игры) — jackbox.fun, без подмены Origin
app.use('/main', (req, res) => proxyTo(BUNDLES_HOST, '/main' + req.url, req, res, false));

// Ecast (Pack 7+) — spoofOrigin=true, иначе 403
app.use('/ecast', (req, res) => proxyTo(ECAST_HOST, '/ecast' + req.url, req, res, true));
app.use('/api/v2', (req, res) => proxyTo(ECAST_HOST, '/api/v2' + req.url, req, res, true));

// Blobcast (Pack 1–6) — spoofOrigin=true
app.use('/room',      (req, res) => proxyTo(BLOBCAST_HOST, '/room'      + req.url, req, res, true));
app.use('/socket.io', (req, res) => proxyTo(BLOBCAST_HOST, '/socket.io' + req.url, req, res, true));
app.use('/bc',        (req, res) => proxyTo(BLOBCAST_HOST, '/bc'        + req.url, req, res, true));

// API — spoofOrigin=true
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

const PORT = process.env.PORT || 3333;
app.listen(PORT, () => {
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log(  '║           Jackbox Mirror — готов к работе        ║');
    console.log(  '╚══════════════════════════════════════════════════╝');
    console.log('  Порт     :', PORT);
    console.log('  Домен    : https://' + YOUR_DOMAIN);
    console.log('  Статика  :', STATIC_DIR);
    console.log('  Бандлы   : https://' + BUNDLES_HOST + '/main/... (без спуфинга)');
    console.log('  Ecast    : https://' + ECAST_HOST + ' (Origin: jackbox.tv)');
    console.log('  Blobcast : https://' + BLOBCAST_HOST + ' (Origin: jackbox.tv)');
    console.log('  API      : https://' + API_HOST + ' (Origin: jackbox.tv)\n');
});
