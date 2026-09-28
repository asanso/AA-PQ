import {site} from './routes.js';
import {formatUnits} from '/ethers.js';
import {renderInputPanel,inputSize} from './input-data.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num = value => value == null ? 'Unavailable' : BigInt(value).toLocaleString('en-US');
const address = value => /^0x[0-9a-f]{40}$/i.test(value || '') ? `<a class="mono" href="${site.href({page:'explorer',kind:'address',id:value})}">${esc(value)}</a>` : '<span class="subtle">Unavailable</span>';
const field = (name,value) => `<div><dt>${esc(name)}</dt><dd>${value}</dd></div>`;
const status = value => `<span class="tx-status ${value==='Success'?'success':value==='Failed'?'failed':'pending'}">${esc(value || 'Unavailable')}</span>`;
const short = value => value.slice(0,8)+'…'+value.slice(-6);

// Counts describe frame receipts, not inclusion or committed state after rollback.
export function frameExecutionSummary(native, included = false) {
  const frames = native?.frames;
  if (!Array.isArray(frames) || !frames.length) return {label:'Frame results unavailable',tone:'pending'};
  if (!included) return {label:'Awaiting inclusion',tone:'pending'};
  const succeeded = frames.filter(frame=>frame.status==='Success').length;
  const failed = frames.filter(frame=>frame.status==='Failed').length;
  const skipped = frames.filter(frame=>frame.status==='Skipped').length;
  const unavailable = frames.length-succeeded-failed-skipped;
  const parts = [`${succeeded}/${frames.length} frames succeeded`];
  if (failed) parts.push(`${failed} failed`);
  if (skipped) parts.push(`${skipped} skipped`);
  if (unavailable) parts.push(`${unavailable} unavailable`);
  if (!unavailable && !native.resultsComplete) parts.push('Incomplete receipt data');
  return {label:parts.join(' · '),tone:failed ? 'failed' : skipped || unavailable || !native.resultsComplete ? 'pending' : 'success'};
}

function frameOperation(frame, sender) {
  if (frame.mode === 1) return (frame.flags & 3) ? 'Verification and authorization' : 'Verification';
  const amount = frame.valueWei == null ? 'Value unavailable' : formatUnits(frame.valueWei,18)+' ETH';
  const decoded = frame.inputDecoded;
  if (decoded?.status === 'decoded' && decoded.functionName) return decoded.functionName+'(…)'+(frame.valueWei != null && BigInt(frame.valueWei)>0n ? ' · '+amount : '');
  if (!frame.effectiveTarget) return 'Call · target unavailable';
  const self = sender && frame.effectiveTarget.toLowerCase() === sender.toLowerCase();
  return (self ? 'Self call' : 'Call to '+short(frame.effectiveTarget))+' · '+amount;
}

export function renderNativeFrames(native, {included = false} = {}) {
  const frames = native?.frames;
  const outcome = frameExecutionSummary(native,included);
  const rows = Array.isArray(frames) ? frames.map(frame=>`<details class="native-frame-row" data-frame-index="${frame.index}">
    <summary><span class="frame-number"><span class="sr-only">Frame </span>${frame.index}</span><span class="frame-operation">${esc(frameOperation(frame,native.rawTransaction?.from))}</span><span class="native-mode">${esc(frame.modeName)}</span>${status(frame.status)}<span class="disclosure-chevron" aria-hidden="true">›</span></summary>
    <div class="native-body"><dl class="native-fields">${field('Target',address(frame.effectiveTarget)+(frame.target === null && frame.effectiveTarget ? ' <span class="subtle">(implicit sender)</span>' : ''))}${field('Value',frame.valueWei == null ? 'Unavailable' : esc(formatUnits(frame.valueWei,18))+' ETH')}${field('Flags',num(frame.flags))}${field('Execution gas · used / limit',num(frame.executionGasUsed)+' / '+num(frame.executionGasLimit))}${field('State gas · used / limit',num(frame.stateGasUsed)+' / '+num(frame.stateGasLimit))}</dl>
    <h3 class="native-input-label">Input data <span class="data-size">${inputSize(frame.data)}</span></h3>${renderInputPanel({id:'frameInput'+frame.index,title:'Frame '+frame.index+' input data',value:frame.data,decoded:frame.inputDecoded,selector:true,embedded:true,description:'Complete calldata submitted to this frame target.'})}
    <details class="native-raw"><summary>Frame receipt logs${Array.isArray(frame.logs) ? ' · '+frame.logs.length : ' · unavailable'}</summary><pre>${esc(frame.logs == null ? 'Unavailable' : JSON.stringify(frame.logs,null,2))}</pre></details></div></details>`).join('') : '';
  return `<section class="panel native-sequence" aria-labelledby="frameSequenceTitle"><div class="panel-heading"><h2 id="frameSequenceTitle">Frame sequence</h2><span class="tx-status ${outcome.tone}" title="Derived from individual frame receipts. It does not describe transaction inclusion or prove that effects survived a batch rollback.">${esc(outcome.label)}</span></div>
    ${rows ? `<div class="frame-columns" aria-hidden="true"><span>Frame</span><span>Operation</span><span>Mode</span><span>Result</span><span></span></div>${rows}` : '<p class="native-empty">Frame input data is unavailable.</p>'}
    <p class="native-sequence-note">Per-frame execution results. A later batch failure can roll back earlier changes.</p></section>`;
}

export function renderNativeWitnesses(native) {
  const witnesses = native?.witnesses;
  const size = witnesses?.length === 1 ? inputSize(witnesses[0].signature) : witnesses ? witnesses.length+' witnesses' : 'Unavailable';
  return `<details class="panel native-disclosure"><summary><span>Signature witnesses</span><span class="disclosure-meta">${size}</span><span class="disclosure-chevron" aria-hidden="true">›</span></summary><div class="native-body">${Array.isArray(witnesses) ? witnesses.length ? witnesses.map(witness=>`<section class="native-witness"><h3>Witness ${witness.index} <span class="data-size">${inputSize(witness.signature)}</span></h3><dl class="native-fields">${field('Scheme',esc(witness.schemeName)+' · '+num(witness.scheme))}${field('Signer',witness.signer ? address(witness.signer) : '<span class="subtle">Not specified in the witness</span>')}</dl>${renderInputPanel({id:'frameSignature'+witness.index,title:'Signature data',value:witness.signature,embedded:true,description:'Complete signature bytes returned by the node.'})}<h3 class="native-input-label">Witness message</h3>${renderInputPanel({id:'frameMessage'+witness.index,title:'Witness message',value:witness.message,embedded:true,description:'An empty message selects the transaction signing digest.'})}</section>`).join('') : '<p>No signature witnesses (empty list).</p>' : '<p>Signature witnesses are unavailable.</p>'}<p class="subtle">ARBITRARY witnesses are interpreted by the account. Byte and bit counts describe encoded length, not cryptographic security strength. An empty witness message selects the transaction signing digest.</p></div></details>`;
}

export function renderNativeMetadata(native) {
  return `<dl class="native-fields">${field('Fee payer',address(native?.payer))}${field('Account verification profile',native?.accountProfile ? '<strong>'+esc(native.accountProfile.name)+'</strong><p class="subtle">'+esc(native.accountProfile.basis)+'</p>'+address(native.accountProfile.verifier) : '<span class="subtle">Unidentified or historical bytecode unavailable</span>')}</dl>`;
}
