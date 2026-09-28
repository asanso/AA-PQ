// End-to-end test. Creates one disposable account and sends tiny test ETH.
// Run only against this testnet. Requires npm ci --prefix frontend.
import assert from 'node:assert/strict';
import {Wallet, Interface, parseEther} from '../frontend/node_modules/ethers/lib.esm/index.js';
const base = process.env.WALLET_URL || 'http://127.0.0.1:3000';
const post = async (path,data) => (await fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)})).json();
async function rpc(path,method,params) {const r=await post(path,{jsonrpc:'2.0',id:1,method,params});if(r.error)throw new Error(r.error.message||r.error);return r.result;}
const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));
async function wait(method,hash,path='/rpc') {for(let i=0;i<120;i++){const r=await rpc(path,method,[hash]);if(r)return r;await sleep(1000);}throw new Error('Timed out waiting for '+hash);}
const cfg=await (await fetch(base+'/api/config')).json();assert.equal(cfg.chainId,1337);
const owner=Wallet.createRandom(), recipient=Wallet.createRandom().address;
const prepare=async extra=>{const s=await post('/api/aa/prepare',{owner:owner.address,...extra});assert.ok(!s.error,JSON.stringify(s));return s;};
let state=await prepare();
const funding=await post('/api/faucet',{address:state.sender,amount:'1'});assert.ok(funding.hash);
assert.equal((await wait('eth_getTransactionReceipt',funding.hash)).status,'0x1');
const bad={...state.userOperation,signature:Wallet.createRandom().signingKey.sign(state.hash).serialized};
const invalid=await post('/bundler',{jsonrpc:'2.0',id:1,method:'eth_sendUserOperation',params:[bad,cfg.entryPoint]});assert.ok(invalid.error,'Wrong-owner signature must be rejected');
assert.equal((await prepare()).hash,state.hash,'Rejected signature must leave the operation nonce/state unchanged');
const eventAbi=new Interface(['event UserOperationEvent(bytes32 indexed userOpHash,address indexed sender,address indexed paymaster,uint256 nonce,bool success,uint256 actualGasCost,uint256 actualGasUsed)']);
async function submit(s) {
  s.userOperation.signature=owner.signingKey.sign(s.hash).serialized;
  const opHash=await rpc('/bundler','eth_sendUserOperation',[s.userOperation,cfg.entryPoint]);
  const receipt=await wait('eth_getUserOperationReceipt',opHash,'/bundler');assert.equal(receipt.success,true);
  const tx=await rpc('/rpc','eth_getTransactionByHash',[receipt.receipt.transactionHash]);
  assert.equal(tx.to.toLowerCase(),cfg.entryPoint.toLowerCase());
  const logs=receipt.receipt.logs.filter(log=>log.address.toLowerCase()===cfg.entryPoint.toLowerCase());
  const events=logs.map(log=>{try{return eventAbi.parseLog(log);}catch{return null;}}).filter(Boolean);
  assert.ok(events.some(e=>e.args.userOpHash===opHash && e.args.sender.toLowerCase()===s.sender.toLowerCase() && e.args.success));
  return {userOpHash:opHash,transactionHash:tx.hash,entryPoint:tx.to,selector:tx.input.slice(0,10)};
}
const creation=await submit(state);
assert.notEqual(await rpc('/rpc','eth_getCode',[state.sender,'latest']),'0x');
state=await prepare({recipient,amount:'0.001'});
assert.equal(state.userOperation.factory,undefined,'Deployed account should not include initCode');
const before=BigInt(await rpc('/rpc','eth_getBalance',[recipient,'latest']));
const transfer=await submit(state);
const after=BigInt(await rpc('/rpc','eth_getBalance',[recipient,'latest']));assert.equal(after-before,parseEther('0.001'));
const replay=await post('/bundler',{jsonrpc:'2.0',id:1,method:'eth_sendUserOperation',params:[state.userOperation,cfg.entryPoint]});assert.ok(replay.error,'Used nonce must not execute again');
assert.equal(BigInt(await rpc('/rpc','eth_getBalance',[recipient,'latest'])),after,'Rejected replay must not transfer value again');
const blocked=await post('/rpc',{jsonrpc:'2.0',id:1,method:'eth_sendRawTransaction',params:['0x']});assert.ok(blocked.error,'Ordinary transaction submission must be blocked by wallet RPC proxy');
console.log(JSON.stringify({passed:true,account:state.sender,creation,transfer,wrongSignatureRejected:true,replayRejected:true,ordinaryRpcSendBlocked:true},null,2));
