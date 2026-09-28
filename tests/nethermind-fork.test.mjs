import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {verifiedGenesis,frameGenesis} from '../scripts/schedule-nethermind-frames.mjs';
const fixture=()=>({genesis:{timestamp:1,alloc:{},config:{chainId:1337,pragueTime:0}},head:{timestamp:1001},finalized:{number:101},migrationBlock:100,activation:1401,now:1001});
test('adds only the prototype timestamp without modifying input or prerequisite forks',()=>{
  const input=fixture(),before=structuredClone(input),result=frameGenesis(input);
  assert.deepEqual(input,before);
  assert.deepEqual(result,{...input.genesis,config:{...input.genesis.config,eip8141PrototypeTime:1401}});
});
test('rejects unfinalized migration, stale head, misaligned or rushed activation and rescheduling',()=>{
  for(const patch of [{finalized:{number:100}},{now:1100},{activation:1402},{activation:1101},{activation:NaN}]) {
    assert.throws(()=>frameGenesis({...fixture(),...patch}));
  }
  const input=fixture();input.genesis.config.eip8141PrototypeTime=1401;
  assert.throws(()=>frameGenesis(input),/already configured/);
});

test('binds the complete original configuration to its trusted migration fingerprint',()=>{
  const original=Buffer.from(JSON.stringify({...fixture().genesis,gasLimit:'0x1c9c380',extraData:'0x',alloc:{'0x01':{balance:'1'}}}));
  const digest=createHash('sha256').update(original).digest('hex');
  assert.deepEqual(verifiedGenesis(original,digest),JSON.parse(original));
  for (const patch of [{alloc:{}},{gasLimit:'0x1'},{extraData:'0xdeadbeef'},{config:{chainId:1337,pragueTime:1}}]) {
    const changed=Buffer.from(JSON.stringify({...JSON.parse(original),...patch}));
    assert.throws(()=>verifiedGenesis(changed,digest),/fingerprint differs/);
  }
  assert.throws(()=>verifiedGenesis(original,''),/trusted migration record/);
});
