// Mutating test for the pinned Nethermind devnet7 wire format, not generic EIP-8141.
// Uses a disposable funded signer; the faucet key must never be supplied here.
import assert from 'node:assert/strict';
import {ethers} from '../frontend/node_modules/ethers/lib.esm/index.js';

const url=process.env.FRAME_RPC_URL;
const key=process.env.FRAME_TEST_PRIVATE_KEY;
const faucet=process.env.FRAME_FAUCET_URL;
if (!url || (!key && !faucet) || process.env.CONFIRM_TESTNET !== '1337') {
  throw Error('Set FRAME_RPC_URL, FRAME_TEST_PRIVATE_KEY or FRAME_FAUCET_URL, and CONFIRM_TESTNET=1337');
}
async function rpc(method,params=[]) {
  const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(15000)});
  const result=await response.json();
  if(result.error) throw Error(`${method}: ${JSON.stringify(result.error)}`);
  return result.result;
}
assert.equal(BigInt(await rpc('eth_chainId')),1337n);
const signer=key?new ethers.Wallet(key):ethers.Wallet.createRandom(), recipient=ethers.Wallet.createRandom().address;
if(faucet) {
  const response=await fetch(faucet,{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({address:signer.address,amount:'0.01'}),signal:AbortSignal.timeout(30000)});
  const funding=await response.json();assert.ok(funding.hash,JSON.stringify(funding));
  let funded=false;
  for(let i=0;i<120;i++) {
    const receipt=await rpc('eth_getTransactionReceipt',[funding.hash]);
    if(receipt) {assert.equal(receipt.status,'0x1');funded=true;break;}
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
  assert.ok(funded,'Faucet funding did not confirm');
}
const quantity=x=>BigInt(x)===0n?'0x':ethers.toBeHex(x);
const nonce=BigInt(await rpc('eth_getTransactionCount',[signer.address,'pending']));
const head=await rpc('eth_getBlockByNumber',['latest',false]);
const fee=BigInt(head.baseFeePerGas)*2n+1000000000n;
const payload=[quantity(1337),quantity(nonce),signer.address,
  [[quantity(1),quantity(3),signer.address,[quantity(150000),'0x'],'0x','0x'],
   [quantity(2),'0x',recipient,[quantity(100000),quantity(100000)],quantity(123),'0x']],
  [[quantity(1),signer.address,'0x','0x']],
  [quantity(1000000000),quantity(fee),'0x'],[]];
const encode=p=>'0x06'+ethers.encodeRlp(p).slice(2);
const signature=signer.signingKey.sign(ethers.keccak256(encode(payload)));
payload[4][0][3]=ethers.concat([ethers.toBeHex(signature.yParity,1),signature.r,signature.s]);
const raw=encode(payload);
if(process.env.FRAME_EXPECT_UNSUPPORTED==='1') {
  await assert.rejects(rpc('eth_sendRawTransaction',[raw]),/unsupported transaction type|transaction type not supported/i);
  console.log(JSON.stringify({passed:true,preactivationRejected:true}));
} else {
const hash=await rpc('eth_sendRawTransaction',[raw]);
let receipt;
for(let i=0;i<180;i++) {
  receipt=await rpc('eth_getTransactionReceipt',[hash]);
  if(receipt) break;
  await new Promise(resolve=>setTimeout(resolve,1000));
}
assert.ok(receipt,'Frame transaction not included');
assert.equal(receipt.status,'0x1');
assert.equal(receipt.type,'0x6');
assert.equal(receipt.frameReceipts.length,2);
assert.ok(receipt.frameReceipts.every(frame=>frame.status===1));
assert.equal(BigInt(await rpc('eth_getBalance',[recipient,receipt.blockNumber])),123n);
await assert.rejects(rpc('eth_sendRawTransaction',[raw]),/already known|nonce.*low|old nonce/i);
payload[1]=quantity(nonce+1n);
await assert.rejects(rpc('eth_sendRawTransaction',[encode(payload)]),/signer.*match|signature/i);
let finalized=false;
for(let i=0;i<300;i++) {
  const block=await rpc('eth_getBlockByNumber',['finalized',false]);
  if(block && BigInt(block.number)>=BigInt(receipt.blockNumber)) {finalized=true;break;}
  await new Promise(resolve=>setTimeout(resolve,1000));
}
assert.ok(finalized,'Frame block did not finalize');
assert.equal((await rpc('eth_getBlockByNumber',[receipt.blockNumber,false])).hash,receipt.blockHash);
console.log(JSON.stringify({passed:true,hash,blockNumber:receipt.blockNumber,
  blockHash:receipt.blockHash,finalized,recipient,amountWei:123,
  invalidSignatureRejected:true,duplicateRejected:true},null,2));
}
