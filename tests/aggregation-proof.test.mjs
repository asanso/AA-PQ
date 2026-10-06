import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {dependencyClaims, decodeBlockProof, loadBlockProof} from '../explorer/aggregation-proof.mjs';
import {nativeFrameDetails} from '../explorer/native-frame.mjs';
const {encodeRlp, decodeRlp, keccak256, concat, toBeHex} = createRequire(new URL('../explorer/package.json',import.meta.url))('ethers');
const dependency=concat([toBeHex(16,32),'0x'+'11'.repeat(32),'0x'+'22'.repeat(32)]);

function fixture() {
  const tx='0x06'+encodeRlp(['0x0539',['0x'],'0x','0x'+'33'.repeat(20),
    [['0x04','0x','0x',['0x0bb8','0x'],'0x',dependency]],[],['0x01','0x02','0x'],[]]).slice(2);
  // Synthetic structure; the explorer never treats these bytes as a verified proof.
  const header=[...Array(23).fill('0x'),['0xabcdef',keccak256(dependency)]];
  return {header,block:[header,[tx],[]],txHash:keccak256(tx)};
}
const decode = f => decodeBlockProof(encodeRlp(f.block),keccak256(encodeRlp(f.header)),f.txHash);

test('shared claims identify associated transactions and exclude unrelated transfers', () => {
  const f=fixture(), second=decodeRlp('0x'+f.block[1][0].slice(4)); second[2]='0x01';
  const secondRaw='0x06'+encodeRlp(second).slice(2); f.block[1].push(secondRaw);
  const unrelated=structuredClone(second); unrelated[2]='0x02'; unrelated[4]=[];
  const unrelatedRaw='0x06'+encodeRlp(unrelated).slice(2); f.block[1].push(unrelatedRaw);
  const result=decode(f);
  assert.equal(result.claimCount,1); assert.equal(result.declarationCount,2); assert.equal(result.transactionCount,2);
  assert.deepEqual(result.transactions.map(tx=>tx.hash),[f.txHash,keccak256(secondRaw)]);
  const uncovered=decodeBlockProof(encodeRlp(f.block),keccak256(encodeRlp(f.header)),keccak256(unrelatedRaw));
  assert.equal(uncovered.transactionCovered,false); assert.equal(uncovered.transactionClaimCount,0);
});

test('empty-set envelopes are not aggregated signature proofs', () => {
  const f=fixture(); f.block[1]=[]; f.header[23]=['0x4e4c52330000000000000000',keccak256('0x')];
  const result=decodeBlockProof(encodeRlp(f.block),keccak256(encodeRlp(f.header)));
  assert.equal(result.status,'empty-set'); assert.equal(result.claimCount,0);
  assert.equal(result.transactionCount,0); assert.equal(result.transactionCovered,null);
  assert.equal(result.proofBytes,12); assert.match(result.message,/not an aggregated signature proof/);
});

test('current and historical RPC gas names preserve exact budgets', () => {
  for(const gas of [{executionGas:'0x0',stateGas:'0x100'},{executionGasLimit:'0x0',stateGasLimit:'0x100'}]) {
    const detail=nativeFrameDetails({type:6,frames:[{mode:4,...gas}]},null);
    assert.equal(detail.frames[0].executionGasLimit,'0'); assert.equal(detail.frames[0].stateGasLimit,'256');
  }
});

test('the explorer preserves complete proof bytes and checks the exact dependency commitment', () => {
  const f=fixture(), result=decode(f);
  assert.equal(result.status,'available');
  assert.equal(result.proof,'0xabcdef');
  assert.equal(result.proofBytes,3);
  assert.equal(result.claimCount,1);
  assert.equal(result.transactionCount,1);
  assert.equal(result.transactionClaimCount,1);
  assert.equal(result.transactionCovered,true);
  assert.equal(result.cryptographicVerification,'not-performed-by-explorer');
  f.block[1].push(f.block[1][0]);
  assert.equal(decode(f).claimCount,1);
  assert.equal(decode(f).declarationCount,2);
});

test('proof availability never substitutes for block identity, membership or commitment checks', () => {
  const f=fixture();
  assert.throws(()=>decodeBlockProof(encodeRlp(f.block),'0x'+'00'.repeat(32),f.txHash),/inclusion block/);
  assert.throws(()=>decodeBlockProof(encodeRlp(f.block),keccak256(encodeRlp(f.header)),'0x'+'00'.repeat(32)),/absent/);
  f.header[23][1]='0x'+'ff'.repeat(32);
  assert.throws(()=>decode(f),/commitment/);
  f.header[23]='0x1234'; assert.throws(()=>decode(f),/encoding/);
});

test('missing, pending and unavailable proofs remain distinct', async () => {
  const f=fixture(); f.header.pop();
  assert.equal(decode(f).status,'missing');
  assert.equal((await loadBlockProof({},{})).status,'pending');
  const failure=await loadBlockProof({send:async()=>{throw Error('Method unavailable');}},{blockHash:'0x1',hash:'0x2'});
  assert.equal(failure.status,'unavailable');
  assert.match(failure.message,/Method unavailable/);
});

test('dependency frames expose their declared digest and key without inferring a signature algorithm', () => {
  const claims=dependencyClaims(dependency);
  assert.equal(claims[0].scheme,'16');
  assert.equal(claims[0].digest,'0x'+'11'.repeat(32));
  assert.equal(claims[0].keyHash,'0x'+'22'.repeat(32));
  assert.equal(dependencyClaims('0x'),null);
  assert.equal(dependencyClaims('0x00'),null);
  const native=nativeFrameDetails({type:'0x6',nonceKeys:['0x0'],frames:[{mode:'0x4',data:dependency}],signatures:[]},null);
  assert.equal(native.frames[0].modeName,'DEP_VERIFY');
  assert.deepEqual(native.frames[0].dependencies,claims);
  assert.deepEqual(native.nonceKeys,['0']);
  assert.deepEqual(native.witnesses,[]);
});
