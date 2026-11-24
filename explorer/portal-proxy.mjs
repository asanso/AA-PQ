import {isPortalPage} from '../frontend/site-config.mjs';

const assets = new Set(['/index.html','/site-config.js','/theme.js','/portal.css','/portal.js','/routes.js',
  '/faucet.js','/timestamp.js','/transaction-view.js','/native-frame-view.js','/input-data.js','/ethers.js','/ethereum.svg','/fonts/InterVariable.woff2']);
const portalApi = /^\/api\/(?:config|network|explorer\/(?:overview|block\/\d{1,12}|(?:tx|op)\/0x[0-9a-fA-F]{64}|address\/0x[0-9a-fA-F]{40}))$/;

// Leave native /api/overview, /api/block, /api/tx, /api/op and /api/address with the indexer.
export function isPortalRequest(path) {
  return isPortalPage(path) || assets.has(path) || portalApi.test(path);
}

// externalExplorerUrl: the network operators' explorer (Dora) from the network profile. The portal redirects explorer
// pages there; only a redirect to that origin is passed on to the browser, any other redirect is an error.
export function createPortalProxy({origin, externalExplorerUrl = null, fetchImpl = fetch} = {}) {
  if (!origin) return async () => false;
  const target = new URL(origin);
  if (!['http:','https:'].includes(target.protocol) || target.username || target.password ||
      target.pathname !== '/' || target.search || target.hash) throw new Error('PORTAL_ORIGIN must be an HTTP(S) origin.');
  const redirectOrigin = externalExplorerUrl ? new URL(externalExplorerUrl).origin : null;
  return async (req, res, path) => {
    if (req.method !== 'GET' || !isPortalRequest(path)) return false;
    try {
      const upstream = await fetchImpl(new URL(path, target), {redirect:'manual', signal:AbortSignal.timeout(20000)});
      if (upstream.status >= 300 && upstream.status < 400) {
        const location = new URL(upstream.headers.get('location') || '', target);
        if (!redirectOrigin || upstream.status !== 302 || location.origin !== redirectOrigin) throw new Error('unexpected redirect');
        res.writeHead(302, {location:location.href, 'cache-control':'no-store'});
        res.end();
        return true;
      }
      const body = Buffer.from(await upstream.arrayBuffer());
      res.writeHead(upstream.status, {
        'content-type':upstream.headers.get('content-type') || 'application/octet-stream',
        'cache-control':'no-store', 'x-content-type-options':'nosniff'
      });
      res.end(body);
    } catch {
      res.writeHead(502, {'content-type':'application/json','cache-control':'no-store'});
      res.end(JSON.stringify({error:'The portal service is unavailable.'}));
    }
    return true;
  };
}
