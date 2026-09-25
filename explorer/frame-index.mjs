import {readFile, mkdir, rename, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {DAISUGI_GENESIS, FRAME_ACTIVATION_BLOCK, isFrameTransaction, nativeFrameSummary} from './native-frame.mjs';

const hex = number => '0x' + number.toString(16);
const hash = value => /^0x[0-9a-f]{64}$/i.test(value || '');
async function limitedMap(values, fn) {
  const result = new Array(values.length);
  let cursor = 0;
  await Promise.all(Array.from({length:Math.min(4,values.length)}, async () => {
    while (cursor < values.length) {const i = cursor++; result[i] = await fn(values[i]);}
  }));
  return result;
}

// Index full blocks: native frames need not emit any contract event. Work is
// bounded per pass and independent of HTTP requests; partial coverage is explicit.
export function createFrameIndex({rpc, cacheFile, startBlock = FRAME_ACTIVATION_BLOCK,
  genesisHash = DAISUGI_GENESIS, batchSize = 64}) {
  if (!Number.isSafeInteger(startBlock) || startBlock < 0 || !Number.isInteger(batchSize) || batchSize < 16 || batchSize > 256) throw new Error('Invalid frame index range or batch size.');
  let blocks = [], ready = false, running, error = null, storageError = null, observedHead = null, savedAt = 0;
  const identity = {version:1,chainId:1337,genesisHash,startBlock};
  async function initialize() {
    const [chain, genesis] = await Promise.all([rpc('eth_chainId',[]),rpc('eth_getBlockByNumber',['0x0',false])]);
    if (Number(chain) !== 1337 || genesis?.hash !== genesisHash) throw new Error('Native frame index requires the configured Daisugi chain and genesis.');
    if (cacheFile) {
      try {
        const saved = JSON.parse(await readFile(cacheFile,'utf8'));
        if (JSON.stringify(saved.identity) !== JSON.stringify(identity) || !Array.isArray(saved.blocks)) throw new Error('Cache identity mismatch');
        if (!saved.blocks.every((b,i,a) => Number.isSafeInteger(b.number) && b.number >= startBlock && hash(b.hash) &&
          Array.isArray(b.transactions) && (!i || (b.number === a[i-1].number+1 && b.parentHash === a[i-1].hash)))) throw new Error('Invalid cached block range');
        blocks = saved.blocks;
      } catch { blocks = []; }
    }
    ready = true;
  }
  async function readRange(from,to) {
    const range = await limitedMap(Array.from({length:to-from+1},(_,i)=>from+i),async number => {
      const block = await rpc('eth_getBlockByNumber',[hex(number),true]);
      if (!block || Number(block.number) !== number || !hash(block.hash) || !Array.isArray(block.transactions)
          || block.transactions.some(tx => !tx || typeof tx !== 'object')) throw new Error('Full block data is unavailable; frame coverage was not advanced.');
      const transactions = [];
      for (const tx of block.transactions.filter(isFrameTransaction)) {
        const receipt = await rpc('eth_getTransactionReceipt',[tx.hash]);
        if (!receipt || receipt.blockHash !== block.hash) throw new Error('Frame receipt unavailable or block changed; retrying this range.');
        transactions.push(nativeFrameSummary(tx,receipt,block));
      }
      return {number,hash:block.hash,parentHash:block.parentHash,timestamp:Number(block.timestamp),transactions};
    });
    if (range.some((b,i) => i && b.parentHash !== range[i-1].hash)) throw new Error('Block range changed during indexing.');
    const tip = await rpc('eth_getBlockByNumber',[hex(to),false]);
    if (tip?.hash !== range.at(-1).hash) throw new Error('Block range changed during indexing.');
    return range;
  }
  async function persist(force = false) {
    if (!cacheFile || (!force && Date.now()-savedAt < 30000)) return;
    try {
      await mkdir(dirname(cacheFile),{recursive:true});
      const temporary = cacheFile + '.' + process.pid + '.tmp';
      await writeFile(temporary,JSON.stringify({identity,blocks}),{mode:0o600});
      await rename(temporary,cacheFile);
      savedAt = Date.now(); storageError = null;
    } catch { storageError = 'Frame index is available in memory; persistent cache could not be written.'; }
  }
  async function update() {
    if (running) return running;
    running = (async () => {
      try {
        if (!ready) await initialize();
        const head = Number(await rpc('eth_blockNumber',[]));
        if (!Number.isSafeInteger(head) || head < 0) throw new Error('Invalid chain height');
        observedHead = head;
        if (head < startBlock) {blocks = []; error = null; return;}
        if (blocks.length) {
          // A changed anchor outside the overlap requires a full rebuild. A head
          // regression also invalidates coverage rather than retaining orphaned rows.
          const anchor = blocks[Math.max(0,blocks.length-13)];
          if (head < blocks.at(-1).number || (await rpc('eth_getBlockByNumber',[hex(anchor.number),false]))?.hash !== anchor.hash) blocks = [];
        }
        if (!blocks.length) blocks = await readRange(Math.max(startBlock,head-batchSize+1),head);
        else {
          const from = Math.max(blocks[0].number,blocks.at(-1).number-11);
          const to = Math.min(head,from+batchSize-1);
          const fresh = await readRange(from,to);
          const retained = blocks.filter(block => block.number < from);
          if (retained.length && fresh[0].parentHash !== retained.at(-1).hash) {blocks = []; throw new Error('Reorganization detected; rebuilding native frame coverage.');}
          blocks = [...retained,...fresh];
        }
        // Prioritize new blocks; backfill a bounded earlier range on every pass.
        if (blocks.at(-1).number === head && blocks[0].number > startBlock) {
          const earlier = await readRange(Math.max(startBlock,blocks[0].number-batchSize),blocks[0].number-1);
          if (earlier.at(-1).hash !== blocks[0].parentHash) {blocks = []; throw new Error('Historical block range changed; rebuilding native frame coverage.');}
          blocks = [...earlier,...blocks];
        }
        error = null;
        await persist();
      } catch (cause) {error = cause.message;}
    })().finally(()=>{running = null;});
    return running;
  }
  function snapshot(address) {
    const from = blocks[0]?.number ?? null, to = blocks.at(-1)?.number ?? null;
    const records = blocks.flatMap(block => block.transactions);
    const filtered = address ? records.filter(tx => [tx.from,...tx.targets].some(a=>a?.toLowerCase()===address.toLowerCase())) : records;
    return {
      status:!ready ? 'unavailable' : error ? 'degraded' : observedHead < startBlock ? 'complete' : from === startBlock && to === observedHead ? 'complete' : 'indexing',
      startBlock, indexedFrom:from, indexedTo:to, observedHead,
      count:ready && observedHead != null && (blocks.length || observedHead < startBlock) ? records.length : null,
      message:error || storageError,
      transactions:filtered.slice(-100).reverse()
    };
  }
  return {update,snapshot,flush:()=>persist(true)};
}
