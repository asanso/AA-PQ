import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {validateProofWrapper} from '../frontend/aggregation-rpc.mjs';
import {validateRpcRequest, createRpcProxy} from '../frontend/rpc-policy.mjs';
import {DAISUGI_GENESIS} from '../explorer/native-frame.mjs';

const {encodeRlp, keccak256, concat, toBeHex} = createRequire(new URL('../frontend/package.json', import.meta.url))('ethers');
const sender = '0x' + '11'.repeat(20);
// Structural gateway fixture only. These bytes are not a valid signature.
const witness = '0x' + '22'.repeat(6208);
const dependency = concat([toBeHex(16,32), '0x'+'33'.repeat(32), keccak256('0x'+witness.slice(2,66))]);
function transaction() {
  return ['0x0539', ['0x'], '0x', sender, [
    ['0x04','0x','0x',['0x0bb8','0x'],'0x',dependency],
    ['0x01','0x03','0x',['0x0186a0','0x'],'0x','0x'],
    ['0x02','0x',sender,['0x03d090','0x03d090'],'0x','0x'],
  ], [], ['0x01','0x02','0x'], []];
}
const typed = tx => '0x06'+encodeRlp(tx).slice(2);
const wrap = (tx=transaction(), dep=dependency, signatures=[witness]) => encodeRlp([[typed(tx)],'0x',[dep,signatures]]);
const request = (method,params=[]) => ({jsonrpc:'2.0',id:17,method,params});

test('the aggregate gateway preserves one complete direct-witness wrapper', () => {
  assert.equal(validateProofWrapper(wrap()), keccak256(typed(transaction())));
  const tx = transaction();
  tx[4].unshift(['0x','0x',sender,['0x0186a0','0x06ddd0'],'0x','0x12345678']);
  assert.equal(validateProofWrapper(wrap(tx)), keccak256(typed(tx)));
});

test('aggregate methods are disabled by default and cannot bypass the raw transaction policy', () => {
  for (const method of ['eth_sendProofWrapper','eth_getProofWrapper']) {
    assert.throws(() => validateRpcRequest(request(method,method.includes('send')?[wrap()]:[])), /not enabled/);
  }
  validateRpcRequest(request('eth_sendProofWrapper',[wrap()]),{aggregationEnabled:true});
  validateRpcRequest(request('eth_getProofWrapper'),{aggregationEnabled:true});
  assert.throws(() => validateRpcRequest(request('eth_sendRawTransaction',[typed(transaction())]),{aggregationEnabled:true}), /not enabled/);
  assert.throws(() => validateRpcRequest(request('eth_getProofWrapper',[1]),{aggregationEnabled:true}), /no parameters/);
  assert.throws(() => validateRpcRequest([request('eth_sendProofWrapper',[wrap()])],{aggregationEnabled:true}), /single/);
});

test('foreign chains, unsupported envelopes and mismatched witnesses are rejected', () => {
  const mutations = [
    tx => tx[0]='0x01', tx => tx[1]=['0x01'], tx => tx[2]='0x00',
    tx => tx[2]='0x010000000000000000', tx => tx[5]=[['0x']], tx => tx[6][2]='0x01',
    tx => tx[7]=['0x'+'00'.repeat(32)], tx => tx[4][0][0]='0x03',
    tx => tx[4][1][1]='0x', tx => tx[4][2][5]='0x'+'ab'.repeat(4097),
    tx => tx[4][2][3][0]='0x4c4b41', tx => tx[4].pop(),
  ];
  for (const mutate of mutations) {
    const tx = transaction(); mutate(tx); assert.throws(() => validateProofWrapper(wrap(tx)));
  }
  assert.throws(() => validateProofWrapper(wrap(transaction(),dependency,[])));
  assert.throws(() => validateProofWrapper(wrap(transaction(),dependency,['0x'+'44'.repeat(6208)])));
  assert.throws(() => validateProofWrapper(wrap(transaction(),'0x'+'00'.repeat(96))));
  assert.throws(() => validateProofWrapper('0x'+'00'.repeat(50000)), /oversized/);
  assert.throws(() => validateProofWrapper(encodeRlp([[typed(transaction()),typed(transaction())],'0x',[dependency,[witness]]])));
});

test('forwarding checks chain identity and sends the exact wrapper without rewriting it', async () => {
  const calls=[];
  const proxy=createRpcProxy({url:'http://mock.invalid',aggregationEnabled:true,fetchImpl:async (_url, options) => {
    const call=JSON.parse(options.body); calls.push(call);
    return {ok:true,json:async()=>({jsonrpc:'2.0',id:call.id,result:call.method==='eth_chainId'?'0x539':
      call.method==='eth_getBlockByNumber'?{hash:DAISUGI_GENESIS}:[keccak256(typed(transaction()))]})};
  }});
  const payload=request('eth_sendProofWrapper',[wrap()]);
  assert.deepEqual((await proxy(payload)).result,[keccak256(typed(transaction()))]);
  assert.deepEqual(calls.at(-1),payload);
  assert.equal(calls.length,3);
});

test('a wrong genesis prevents aggregate submission', async () => {
  const calls=[];
  const proxy=createRpcProxy({url:'http://mock.invalid',aggregationEnabled:true,fetchImpl:async (_url,options)=>{
    const call=JSON.parse(options.body); calls.push(call.method);
    return {ok:true,json:async()=>({result:call.method==='eth_chainId'?'0x539':{hash:'0x'+'00'.repeat(32)}})};
  }});
  await assert.rejects(proxy(request('eth_sendProofWrapper',[wrap()])), /genesis/);
  assert.ok(!calls.includes('eth_sendProofWrapper'));
});
