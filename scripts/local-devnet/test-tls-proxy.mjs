// Checks that tls-proxy.mjs relays a complete response and ends one whose portal dies mid-body.
// Usage: node scripts/local-devnet/test-tls-proxy.mjs
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'tls-proxy-'));
const cert = join(dir, 'cert.pem');
const key = join(dir, 'key.pem');
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
  '-keyout', key, '-out', cert], { stdio: 'ignore' });

const portal = http.createServer((req, res) => {
  if (req.url === '/die') {
    res.writeHead(200, { 'content-length': '100' });
    res.write('partial');
    setTimeout(() => res.socket.destroy(), 50);
    return;
  }
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => setTimeout(() => res.end(`${req.method} ${body}`), 50));
});
await new Promise(resolve => portal.listen(0, '127.0.0.1', resolve));
const proxyPort = 20000 + Math.floor(Math.random() * 20000);
const proxy = spawn(process.execPath, [new URL('./tls-proxy.mjs', import.meta.url).pathname, cert, key, String(proxyPort),
  `http://127.0.0.1:${portal.address().port}`], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise(resolve => proxy.stdout.once('data', resolve));

const request = (path, method, body) => new Promise(resolve => {
  const started = Date.now();
  const req = https.request({ host: '127.0.0.1', port: proxyPort, path, method, ca: readFileSync(cert),
    servername: 'localhost' }, res => {
    let data = '';
    res.on('data', chunk => { data += chunk; });
    res.on('end', () => resolve({ status: res.statusCode, data, complete: res.complete, ms: Date.now() - started }));
    res.on('error', () => resolve({ status: res.statusCode, data, complete: false, ms: Date.now() - started }));
  });
  req.setTimeout(3000, () => req.destroy());
  req.on('error', () => resolve({ status: 0, data: '', complete: false, ms: Date.now() - started }));
  req.end(body);
});

let failed = false;
const check = (ok, message) => { if (!ok) { console.error(`FAIL: ${message}`); failed = true; } };
try {
  const get = await request('/', 'GET');
  check(get.status === 200 && get.data === 'GET ', `GET returned ${get.status} '${get.data}'`);
  const post = await request('/rpc', 'POST', '{"id":1}');
  check(post.status === 200 && post.data === 'POST {"id":1}', `POST returned ${post.status} '${post.data}'`);
  const died = await request('/die', 'GET');
  check(!died.complete && died.ms < 2000, `a portal dying mid-body gave status ${died.status}, complete=${died.complete}, after ${died.ms} ms`);
} finally {
  proxy.kill();
  portal.close();
  rmSync(dir, { recursive: true, force: true });
}
if (failed) process.exit(1);
console.log('PASS');
