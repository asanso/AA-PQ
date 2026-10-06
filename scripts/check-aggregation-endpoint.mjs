// Read-only capability probe. This command never funds, deploys or sends a transaction.
import {DAISUGI_GENESIS} from '../explorer/native-frame.mjs';

const endpoint = new URL(process.argv[2] || '');
if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
  throw Error('Provide an explicit HTTPS RPC endpoint without credentials, query or fragment.');

async function read(method, params = []) {
  try {
    const response = await fetch(endpoint, {method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(15000)});
    const body = await response.json();
    return {httpStatus:response.status,...body};
  } catch (error) { return {error:{message:error.message}}; }
}

const [client,chain,genesis,wrapper] = await Promise.all([
  read('web3_clientVersion'),read('eth_chainId'),read('eth_getBlockByNumber',['0x0',false]),read('eth_getProofWrapper'),
]);
const identityMatches = chain.result === '0x539' && genesis.result?.hash === DAISUGI_GENESIS;
const wrapperMethodAvailable = Object.hasOwn(wrapper,'result') || (wrapper.error?.code === -32000 &&
  wrapper.error.message === 'Proof wrapper is not ready; retry after the next background cycle.');
console.log(JSON.stringify({endpoint:endpoint.href,clientVersion:client.result??null,chainId:chain.result??null,
  genesisHash:genesis.result?.hash??null,identityMatches,wrapperMethodAvailable,
  wrapperError:wrapper.error??null,liveTransactionsSubmitted:0,
  limitation:'RPC availability does not establish Engine API, consensus transport, fork activation or contract deployment readiness.'},null,2));
if (!identityMatches || !wrapperMethodAvailable) process.exitCode=2;
