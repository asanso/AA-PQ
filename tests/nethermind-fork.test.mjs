import {test} from 'node:test';
import assert from 'node:assert/strict';
import {frameGenesis} from '../scripts/schedule-nethermind-frames.mjs';
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
