import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

// Runs the extension's real rpc() from src/native-frame/client.js (loaded through Vite, which resolves its JSON and
// build-time imports) against canned fetch outcomes, and returns the errors it throws.
// Each reply is {status, body} for an HTTP response, or {fetchError: name} for a failed fetch.
export function transportErrors(replies) {
  const script = `
    import {createServer} from 'vite';
    const server = await createServer({logLevel:'silent', appType:'custom', build:{outDir:'nicetry-transport-test'},
      server:{middlewareMode:true, hmr:false}, optimizeDeps:{noDiscovery:true}});
    const errors = [];
    try {
      const {rpc} = await server.ssrLoadModule('/src/native-frame/client.js');
      for (const reply of JSON.parse(process.env.REPLIES)) {
        globalThis.fetch = async () => {
          if (reply.fetchError) throw new DOMException('The operation failed.', reply.fetchError);
          return new Response(reply.body, {status: reply.status});
        };
        try { await rpc('eth_sendProofWrapper', ['0x']); errors.push(null); }
        catch (error) { errors.push({message: error.message, rpcCode: error.rpcCode, httpStatus: error.httpStatus}); }
      }
    } finally { await server.close(); }
    process.stdout.write(JSON.stringify(errors));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8', timeout: 60000,
    env: {...process.env, REPLIES: JSON.stringify(replies), NICETRY_RPC_URL: 'https://staging.invalid/rpc',
      NICETRY_BUNDLER_URL: 'https://staging.invalid/bundler', NICETRY_EXPLORER_URL: 'https://staging.invalid/explorer'}});
  if (result.status !== 0) throw Error(result.stderr || 'The transport fixture failed.');
  return JSON.parse(result.stdout).map(error => error && Object.assign(Error(error.message), error));
}
