import test from 'node:test';
import assert from 'node:assert/strict';
import {formatInputText,renderInputPanel,clearInputPanels} from '../frontend/public/input-data.js';
const decoded={status:'decoded',functionSignature:'execute(address target, uint256 value, bytes data)',selector:'0xb61d27f6',abiSource:'Smart-account execute ABI template',parameters:[{name:'data',type:'bytes',value:'0x'}],trailingData:'0x'};
test('original view preserves the input and default view adds function context without removing bytes',()=>{
 const raw='0xb61d27f6'+'ab'.repeat(9000);
 assert.equal(formatInputText(raw,'original',decoded),raw);assert.ok(formatInputText(raw,'default',decoded).endsWith(raw));assert.match(formatInputText(raw,'default',decoded),/Function: execute/);
});
test('UTF-8 decodes readable text and escapes invisible controls',()=>{
 assert.equal(formatInputText('0x6369616f20e29895','utf8'),'ciao ☕');assert.equal(formatInputText('0x410042','utf8'),'A\\u0000B');assert.equal(formatInputText('0x','utf8'),'');
 assert.throws(()=>formatInputText('0xfffe','utf8'),/not valid UTF-8/);
});
test('decoded parameter values and metadata are escaped instead of becoming HTML',()=>{
 const html=renderInputPanel({id:'testInput',title:'Input',value:'0xab',selector:true,decoded:{...decoded,parameters:[{name:'<img>',type:'string',value:'<script>alert(1)</script>'}]}});
 assert.ok(!html.includes('<script>'));assert.ok(html.includes('&lt;script&gt;'));assert.ok(html.includes('Export JSON'));assert.ok(html.includes('Decode input data'));clearInputPanels();
});
test('unavailable data and empty bytes remain distinguishable in a panel',()=>{
 const unavailable=renderInputPanel({id:'missing',value:null,title:'Input',selector:true,error:'RPC offline'});assert.match(unavailable,/RPC offline/);assert.ok(!unavailable.includes('<textarea'));
 const empty=renderInputPanel({id:'empty',value:'0x',title:'Input',selector:true,decoded:{status:'empty',message:'No bytes'}});assert.match(empty,/0 bytes · 0 bits/);assert.match(empty,/No bytes/);clearInputPanels();
});
