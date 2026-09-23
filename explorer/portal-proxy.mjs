import {isPortalPage} from '../frontend/site-config.mjs';

const assets = new Set(['/index.html','/site-config.js','/theme.js','/portal.css','/portal.js','/routes.js',
  '/faucet.js','/transaction-view.js','/input-data.js','/ethers.js','/ethereum.svg','/fonts/InterVariable.woff2']);
const portalApi = /^\/api\/(?:config|network|explorer\/(?:overview|block\/\d{1,12}|(?:tx|op)\/0x[0-9a-fA-F]{64}|address\/0x[0-9a-fA-F]{40}))$/;

// Leave native /api/overview, /api/block, /api/tx, /api/op and /api/address with the indexer.
export function isPortalRequest(path) {
  return isPortalPage(path) || assets.has(path) || portalApi.test(path);
}

export function createPortalProxy({origin, fetchImpl = fetch} = {}) {
  if (!origin) return async () => false;
  const target = new URL(origin);
  if (!['http:','https:'].includes(target.protocol) || target.username || target.password ||
      target.pathname !== '/' || target.search || target.hash) throw new Error('PORTAL_ORIGIN must be an HTTP(S) origin.');
  return async (req, res, path) => {
    if (req.method !== 'GET' || !isPortalRequest(path)) return false;
    try {
      const upstream = await fetchImpl(new URL(path, target), {redirect:'error', signal:AbortSignal.timeout(20000)});
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
