const path = require('path');
const express = require('express');
const https = require('https');
const app = express();

const PROXY_HOST = 'jackbox.fun';

function proxyTo(fullPath, req, res) {
    console.log(`[proxy] -> https://${PROXY_HOST}${fullPath}`);

    const options = {
        hostname: PROXY_HOST,
        port: 443,
        path: fullPath,
        method: 'GET',
        headers: {
            'User-Agent': 'Mozilla/5.0',
            'Accept': '*/*',
            'Accept-Encoding': 'identity',
            'Host': PROXY_HOST,
        }
    };

    const proxyReq = https.request(options, (proxyRes) => {
        console.log(`[proxy] <- ${proxyRes.statusCode} ${fullPath}`);

        // Strip problematic headers, add CORS
        const headers = {};
        const keep = ['content-type', 'content-length', 'cache-control', 'last-modified', 'etag'];
        keep.forEach(h => { if (proxyRes.headers[h]) headers[h] = proxyRes.headers[h]; });
        headers['access-control-allow-origin'] = '*';

        res.writeHead(proxyRes.statusCode, headers);
        proxyRes.pipe(res, { end: true });
    });

    proxyReq.on('error', (err) => {
        console.error(`[proxy] ERROR ${fullPath}:`, err.message);
        res.status(502).send('Proxy error: ' + err.message);
    });

    proxyReq.end();
}

// Proxy all /main/* requests (game bundles) to jackbox.fun
app.use('/main', (req, res) => {
    proxyTo('/main' + req.url, req, res);
});

// Local static files
app.use(express.static(path.join(__dirname, '/')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.htm'));
});

const PORT = process.env.PORT || 3333;
app.listen(PORT, () => console.log(`Jackbox listening on port ${PORT}`));
