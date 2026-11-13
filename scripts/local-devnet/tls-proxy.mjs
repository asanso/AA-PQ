// Local HTTPS front for the portal. The NiceTry extension build accepts only HTTPS, non-localhost endpoints, so a
// local devnet serves the portal (and its /rpc gateway) as https://daisugi.test:8443 with a self-signed certificate.
// Usage: node tls-proxy.mjs <cert.pem> <key.pem> <listen port> <portal origin>
import https from 'node:https';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { pipeline } from 'node:stream';

const [cert, key, port, origin] = process.argv.slice(2);
const target = new URL(origin);
https.createServer({ cert: readFileSync(cert), key: readFileSync(key) }, (req, res) => {
  const upstream = http.request({ hostname: target.hostname, port: target.port, path: req.url, method: req.method,
    headers: { ...req.headers, host: target.host } }, response => {
    res.writeHead(response.statusCode, response.headers);
    // pipeline, not pipe: a portal that dies mid-body leaves pipe's destination open, and the browser then waits for
    // its own timeout instead of seeing the response end. Destroying each side keeps a failed request short.
    pipeline(response, res, () => res.destroy());
  });
  upstream.on('error', () => {
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end('{"error":"portal unavailable"}');
  });
  pipeline(req, upstream, () => upstream.destroy());
}).listen(Number(port), '127.0.0.1', () => console.log(`tls proxy listening on https://127.0.0.1:${port} -> ${origin}`));
