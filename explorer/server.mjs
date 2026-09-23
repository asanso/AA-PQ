import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {ethers} from 'ethers';
import {operationSignature} from './user-operation.mjs';
import {createPortalProxy} from './portal-proxy.mjs';

const port = Number(process.env.PORT || 3001);
const portalProxy = createPortalProxy({origin:process.env.PORTAL_ORIGIN});
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || 'http://127.0.0.1:8545');
const entryPoint = process.env.ENTRY_POINT || '0x433709009B8330FDa32311DF1C2AFA402eD8D009';
const iface = new ethers.Interface([
  'event UserOperationEvent(bytes32 indexed userOpHash,address indexed sender,address indexed paymaster,uint256 nonce,bool success,uint256 actualGasCost,uint256 actualGasUsed)',
  'event AccountDeployed(bytes32 indexed userOpHash,address indexed sender,address factory,address paymaster)',
]);
let indexedTo = -1, operations = [], deployments = [], syncing;
const serialize = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v);
function event(log) {
  const parsed = iface.parseLog(log);
  if (!parsed) return null;
  const result = {type:parsed.name, transactionHash:log.transactionHash, blockNumber:log.blockNumber, logIndex:log.index};
  parsed.fragment.inputs.forEach((input,i) => {result[input.name] = parsed.args[i];});
  return result;
}
async function sync() {
  if (syncing) return syncing;
  syncing = (async () => {
    const head = await provider.getBlockNumber();
    // Re-read the last 12 blocks to reconcile short devnet reorganizations.
    const from = Math.max(0, Math.min(indexedTo - 11, head - 11));
    const nextOps = operations.filter(op => op.blockNumber < from);
    const nextDeployments = deployments.filter(op => op.blockNumber < from);
    for (let start = from; start <= head; start += 1000) {
      const logs = await provider.getLogs({address:entryPoint, fromBlock:start, toBlock:Math.min(head, start+999), topics:[[iface.getEvent('UserOperationEvent').topicHash, iface.getEvent('AccountDeployed').topicHash]]});
      for (const log of logs) {
        const item = event(log);
        if (item?.type === 'UserOperationEvent') nextOps.push(item);
        else if (item?.type === 'AccountDeployed') nextDeployments.push(item);
      }
    }
    operations = nextOps; deployments = nextDeployments; indexedTo = head;
    return head;
  })().finally(() => {syncing = null;});
  return syncing;
}
const blockSummary = block => ({number:block.number, hash:block.hash, timestamp:block.timestamp, gasUsed:block.gasUsed, gasLimit:block.gasLimit, transactionCount:block.transactions.length, transactions:block.transactions});
async function overview() {
  const head = await sync();
  const blocks = (await Promise.all(Array.from({length:Math.min(12, head+1)}, (_, i) => provider.getBlock(head-i)))).filter(Boolean).map(blockSummary);
  return {chainId:Number((await provider.getNetwork()).chainId), entryPoint, indexedTo, operationCount:operations.length, walletCount:new Set(deployments.map(d => d.sender)).size, blocks, operations:operations.slice(-20).reverse(), wallets:deployments.slice(-100).reverse()};
}
async function api(path) {
  if (path === '/api/overview') return overview();
  const [, , kind, id] = path.split('/');
  if (kind === 'block' && /^\d{1,12}$/.test(id || '')) {
    const block = await provider.getBlock(Number(id));
    if (!block) throw new Error('Block not found');
    return blockSummary(block);
  }
  if (kind === 'tx' && /^0x[0-9a-fA-F]{64}$/.test(id || '')) {
    const [tx, receipt] = await Promise.all([provider.getTransaction(id), provider.getTransactionReceipt(id)]);
    if (!tx) throw new Error('Transaction not found');
    const events = receipt?.logs.filter(log => log.address.toLowerCase() === entryPoint.toLowerCase()).map(log => {try{return event(log);}catch{return null;}}).filter(Boolean) || [];
    return {hash:tx.hash, from:tx.from, to:tx.to, value:ethers.formatEther(tx.value), blockNumber:tx.blockNumber, status:receipt ? receipt.status === 1 ? 'Confirmed' : 'Reverted' : 'Pending', gasUsed:receipt?.gasUsed, selector:tx.data.slice(0,10), entryPoint, isAaBundle:tx.to?.toLowerCase() === entryPoint.toLowerCase() && events.some(e => e.type === 'UserOperationEvent'), events};
  }
  if (kind === 'op' && /^0x[0-9a-fA-F]{64}$/.test(id || '')) {
    await sync();
    const op = operations.find(op => op.userOpHash.toLowerCase() === id.toLowerCase());
    if (!op) throw new Error('Confirmed UserOperation not found');
    const tx = await provider.getTransaction(op.transactionHash);
    return {...op, signature:operationSignature(tx, op, entryPoint)};
  }
  if (kind === 'address' && ethers.isAddress(id || '')) {
    await sync();
    const [balance, code] = await Promise.all([provider.getBalance(id), provider.getCode(id)]);
    const deployment = deployments.find(d => d.sender.toLowerCase() === id.toLowerCase());
    return {address:ethers.getAddress(id), balance:ethers.formatEther(balance), type:deployment ? 'AA smart account (EntryPoint deployment)' : code !== '0x' ? 'Contract' : 'Externally owned / unused address', deployment, operations:operations.filter(op => op.sender.toLowerCase() === id.toLowerCase()).slice(-100).reverse()};
  }
  throw new Error('Invalid explorer request');
}
const files = {'/':'index.html', '/explorer.js':'explorer.js', '/explorer.css':'explorer.css'};
http.createServer(async (req,res) => {
  res.setHeader('cache-control','no-store');
  res.setHeader('x-content-type-options','nosniff');
  if (req.method !== 'GET') {res.writeHead(405);res.end('Read-only explorer');return;}
  const path = new URL(req.url, 'http://localhost').pathname;
  try {
    if (await portalProxy(req,res,path)) return;
    if (path.startsWith('/api/')) {const data = await api(path); res.setHeader('content-type','application/json'); res.end(serialize(data));return;}
    if (!files[path]) {res.writeHead(404);res.end('Not found');return;}
    const data = await readFile(new URL(`./public/${files[path]}`, import.meta.url));
    res.setHeader('content-type', path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html');
    res.end(data);
  } catch(error) {res.writeHead(400, {'content-type':'application/json'});res.end(serialize({error:error.shortMessage || error.message}));}
}).listen(port, process.env.HOST || '0.0.0.0', () => console.log(`AA PQ explorer on port ${port}`));
