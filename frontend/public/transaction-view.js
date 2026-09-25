import {site} from './routes.js';
import { formatUnits } from '/ethers.js';
import { renderInputPanel, inputSize } from './input-data.js';
import {renderTimestamp, formatTimestamp} from './timestamp.js';
import {renderNativeFrames,renderNativeWitnesses,renderNativeMetadata} from './native-frame-view.js';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const int = value => value == null ? '—' : BigInt(value).toLocaleString('en-US');
const short = value => String(value).slice(0, 10) + '…' + String(value).slice(-8);
const amount = (value, decimals = 18) => value == null ? '—' : formatUnits(BigInt(value), decimals);
const mono = value => `<span class="mono">${esc(value ?? '—')}</span>`;
const notAvailable = '<span class="tx-unavailable">Unavailable</span>';
const eth = value => value == null ? notAvailable : `<span class="tx-amount">${esc(amount(value))} <span class="tx-unit">ETH</span></span>`;
const copy = value => `<button type="button" class="copy-value" data-copy-value="${esc(value)}" aria-label="Copy ${esc(value)}" title="Copy"><svg viewBox="0 0 20 20" aria-hidden="true"><rect x="7" y="3" width="10" height="12" rx="1.5"/><path d="M13 17H4a1 1 0 0 1-1-1V7"/></svg></button>`;
function address(value, compact = false) { return /^0x[0-9a-fA-F]{40}$/.test(value || '') ? `<span class="address-value"><a class="mono" href="${site.href({page:'explorer',kind:'address',id:value})}">${esc(compact ? short(value) : value)}</a>${copy(value)}</span>` : notAvailable; }
const row = (name, value, help = '', extra = '') => `<div class="tx-row ${extra}"><dt><span class="tx-help" title="${esc(help || name)}" aria-label="${esc(help || name)}">?</span>${esc(name)}</dt><dd>${value}</dd></div>`;
const section = content => `<section class="panel tx-panel"><dl class="tx-properties">${content}</dl></section>`;
function internalTransfers(trace) {
  if (!trace || trace.status !== 'available') return `<div class="trace-unavailable"><span class="trace-state">Trace unavailable</span><p>${esc(trace?.message || 'Internal transfer data could not be retrieved from the node.')}</p></div>`;
  if (!trace.transfers.length) return `<span class="tx-unavailable">${trace.reverted ? 'No committed internal transfers: this transaction reverted.' : 'No internal ETH transfers recorded.'}</span>`;
  return `<div class="transfer-tabs" role="group" aria-label="Internal transfer view"><button type="button" data-transfer-view="all" aria-pressed="true">All transfers</button><button type="button" data-transfer-view="net" aria-pressed="false">Net transfers</button></div><div data-transfer-list="all">${trace.transfers.map(t => `<div class="transfer-line"><span class="transfer-chevron" aria-hidden="true">›</span><span>Transfer ${eth(t.valueWei)} <span class="tx-muted">From</span> ${address(t.from, true)} <span class="tx-muted">To</span> ${address(t.to, true)} <span class="transfer-type">${esc(t.type)}</span></span></div>`).join('')}</div><div data-transfer-list="net" hidden>${trace.netTransfers.length ? trace.netTransfers.map(t => `<div class="transfer-line">${address(t.address, true)}<span class="net-value ${BigInt(t.valueWei) > 0n ? 'positive' : 'negative'}">${BigInt(t.valueWei) > 0n ? '+' : ''}${esc(amount(t.valueWei))} ETH</span></div>`).join('') : '<p class="tx-muted">Net internal value change is zero for every address.</p>'}<p class="tx-muted transfer-note">Net changes from internal ETH transfers only; excludes transaction value and gas fees.</p></div>`;
}
const txType = type => ({ 0: 'Legacy', 1: 'EIP-2930', 2: 'EIP-1559', 3: 'EIP-4844', 4: 'EIP-7702', 6:'EIP-8141 prototype' })[type] || 'Typed transaction';
function badge(label, value) { return `<span class="attribute-badge"><span>${esc(label)}:</span> ${esc(value)}</span>`; }
export function renderTransactionDetails(data) {
  const d = data.transactionDetails || {};
  const native = Number(d.type ?? data.type) === 6 || !!data.nativeFrame;
  const pending = d.status === 'Pending' || (!d.status && data.status === 'Pending');
  const status = d.status || (data.status === 'Confirmed' ? 'Success' : data.status === 'Reverted' ? 'Failed' : data.status || 'Unknown');
  const block = d.blockNumber ?? data.blockNumber;
  const blockValue = block == null ? '<span class="tx-unavailable">Pending inclusion</span>' : `<a href="${site.href({page:'explorer',kind:'block',id:block})}">${int(block)}</a>${d.confirmations != null ? `<span class="attribute-badge confirmations">${int(d.confirmations)} block confirmations</span>` : ''}`;
  const to = d.to ?? data.to;
  let destination = to ? address(to) : '<span class="tx-muted">Contract creation</span>';
  if (native) destination = '<span class="tx-muted">Per-frame targets · shown below</span>';
  const creations = [...(d.contractAddress ? [{ address: d.contractAddress }] : []), ...(d.internalTransfers?.createdContracts || [])];
  for (const created of creations) destination += `<div class="created-contract">${address(created.address)} <span class="created-label">Created</span></div>`;
  const errors = (d.errors || []).length ? `<div class="inline-notice">${esc(d.errors.join(' '))}</div>` : !data.transactionDetails ? '<div class="inline-notice">Extended RPC details are unavailable. Indexed transaction data is shown below.</div>' : '';
  const fee = d.transactionFeeWei != null ? eth(d.transactionFeeWei) : pending ? '<span class="tx-unavailable">Available after inclusion</span>' : notAvailable;
  const price = d.effectiveGasPriceWei == null ? pending ? '<span class="tx-unavailable">Available after inclusion</span>' : notAvailable : `${esc(amount(d.effectiveGasPriceWei, 9))} Gwei <span class="tx-muted">(${esc(amount(d.effectiveGasPriceWei))} ETH)</span>`;
  const caps = [['Base', d.baseFeePerGasWei], ['Max', d.maxFeePerGasWei], ['Max priority', d.maxPriorityFeePerGasWei]].map(([name, value]) => `<span><span class="tx-muted">${name}:</span> ${value != null ? esc(amount(value, 9)) + ' Gwei' : '<span class="tx-muted">' + (name !== 'Base' && Number(d.type) < 2 ? 'N/A' : 'Unavailable') + '</span>'}</span>`).join('<span class="fee-divider">|</span>');
  const gasUsed = d.gasUsed != null ? `${int(d.gasUsed)}${d.gasUsedPercent != null ? ' <span class="tx-muted">(' + esc(d.gasUsedPercent) + '%)</span>' : ''}` : '<span class="tx-unavailable">' + (pending ? 'Pending' : 'Unavailable') + '</span>';
  const attributes = [d.type != null ? badge('Tx type', d.type + ' (' + txType(d.type) + ')') : '', d.nonce != null ? badge('Nonce', int(d.nonce)) : '', d.transactionIndex != null ? badge('Position in block', int(d.transactionIndex)) : ''].join('');
  const input = renderInputPanel({ id: 'transactionInput', title: 'Transaction input data', value: data.inputData, decoded: data.inputDecoded, error: data.inputDataError, selector: true, creation: data.inputIsContractCreation, embedded: true, description: 'Complete transaction input.' });
  const feeExtras = (d.blobGasUsed != null ? row('Blob gas', int(d.blobGasUsed) + ' used · ' + eth(d.blobFeeWei), 'Blob gas and blob fee are separate from execution gas.') : '');
  if (native) {
    const included = block != null;
    const inclusion = included ? 'Included in block' : pending ? 'Pending inclusion' : 'Inclusion unavailable';
    return `<div class="tx-record native-tx-record"><div class="native-record-nav"><a class="back-link" href="${site.href({page:'explorer'})}">← Back to explorer</a><span class="network-label">Daisugi Testnet · Type 0x06</span></div>${errors}
      <section class="panel native-overview"><dl class="native-overview-grid">
      ${row('Transaction hash',`<span class="hash-value">${mono(data.hash)}${copy(data.hash)}</span>`,'Unique identifier of this native frame transaction.','native-wide')}
      ${row('Inclusion',`<span class="tx-status ${included?'success':'pending'}">${inclusion}</span>`,'Block inclusion is separate from the execution result of each frame.')}
      ${row('Block',blockValue,'Containing block and confirmations at the latest observed height.')}
      ${row('Sender',address(d.from ?? data.from),'Native transaction sender; execution targets appear in the frame sequence.')}
      ${row('Timestamp',renderTimestamp(d.timestamp ?? data.timestamp,{pending:!included && pending}),'Timestamp of the containing block.')}
      ${row('Total gas used',d.gasUsed != null ? int(d.gasUsed) : pending ? '<span class="tx-unavailable">Pending</span>' : notAvailable,'Total gas consumed according to the transaction receipt, including transaction overhead; distinct from the gas limit.')}
      </dl></section>
      ${renderNativeFrames(data.nativeFrame,{included})}
      <div class="native-extra-grid"><details class="panel native-disclosure"><summary><span>Fees and transaction details</span><span class="disclosure-meta">${fee}</span><span class="disclosure-chevron" aria-hidden="true">›</span></summary><dl class="tx-properties">
      ${row('Transaction fee',fee,'Actual receipt gas used × effective gas price, plus blob fees if applicable.')}
      ${row('Gas price',price,'Effective price paid per unit of gas.')}${feeExtras}
      ${row('Gas limit & usage',`${int(d.gasLimit)}<span class="fee-divider">|</span>${gasUsed}`,'Transaction gas limit and actual receipt gas usage.')}
      ${row('Gas fees',`<div class="fee-parts">${caps}</div>`,'Block base fee and transaction fee caps.')}
      ${row('Burnt & savings',`<div class="fee-parts"><span class="fee-badge burnt">Burnt: ${eth(d.burntExecutionFeeWei)}</span><span class="fee-badge saving">Fee savings: ${eth(d.feeSavingWei)}</span></div>`,'Burned fee and unused fee-cap allowance; savings are not an additional refund.')}
      ${row('Other attributes',`<div class="attribute-list">${attributes || notAvailable}</div>`,'Envelope type, native nonce and transaction position in the block.')}
      ${row('Internal transactions',internalTransfers(d.internalTransfers),'Internal transfer tracing is separate from individual frame execution results.')}
      </dl><div class="native-body">${renderNativeMetadata(data.nativeFrame)}</div></details>
      ${renderNativeWitnesses(data.nativeFrame)}</div>
      <p id="txCopyStatus" class="copy-status" role="status"></p><p class="tx-record-note">Daisugi testnet · Test ETH has no monetary value.</p></div>`;
  }
  return `<div class="tx-record"><a class="back-link" href="${site.href({page:'explorer'})}">← Back to explorer</a><div class="tx-record-top"><span class="record-tab">Overview</span><span class="network-label">Daisugi Testnet <span class="mono">1337</span></span></div>${errors}` +
    section(row('Transaction hash', `<span class="hash-value">${mono(data.hash)}${copy(data.hash)}</span>`, 'Unique identifier of this transaction.') +
      row('Status', `<span class="tx-status ${status === 'Success' ? 'success' : status === 'Failed' ? 'failed' : 'pending'}">${status === 'Success' ? '✓ ' : status === 'Failed' ? '× ' : ''}${esc(status)}</span>`, 'Receipt execution status; distinct from each UserOperation result.') +
      row('Block', blockValue, 'Confirmations include the containing block, using the latest observed chain height.') +
      row('Timestamp', renderTimestamp(d.timestamp ?? data.timestamp, {pending}), 'Timestamp of the block that included this transaction.') +
      row('From', address(d.from ?? data.from), 'Account that submitted the enclosing Ethereum transaction.', 'tx-group-start') +
      row('To', destination, 'Destination of the outer transaction, or the contract created by it.') +
      row('Internal transactions', internalTransfers(d.internalTransfers), 'Committed internal ETH transfers reconstructed from a call trace; excludes the outer transaction value.', 'tx-group-start') +
      row('Value', native ? '<span class="tx-muted">Specified separately in each frame</span>' : d.valueWei != null ? eth(d.valueWei) : `${esc(data.value ?? '—')} ETH`, 'Native transactions specify value per frame; other transactions have one outer value.', 'tx-group-start') +
      row('Transaction fee', fee, 'Actual execution gas used × effective gas price, plus blob fees if applicable.') +
      row('Gas price', price, 'Actual price paid per unit of execution gas, from the receipt.') + feeExtras) +
    section(row('Gas limit & usage', `<span>${d.gasLimit != null ? int(d.gasLimit) : '—'}</span><span class="fee-divider">|</span>${gasUsed}`, 'Execution gas limit, actual gas consumed and percentage of the limit.') +
      row('Gas fees', `<div class="fee-parts">${caps}</div>`, 'Block base fee, transaction fee cap and priority fee cap per gas.') +
      row('Burnt & savings', `<div class="fee-parts"><span class="fee-badge burnt">Burnt: ${eth(d.burntExecutionFeeWei)}</span><span class="fee-badge saving">Fee savings: ${eth(d.feeSavingWei)}</span></div>`, 'Execution fee burned = gas used × block base fee. Savings = gas used × (max fee cap − effective gas price); not a separate refund.') +
      row('Other attributes', `<div class="attribute-list">${attributes || notAvailable}</div>`, 'Transaction envelope type, sender nonce and zero-based position in the block.', 'tx-group-start') +
      (native ? '' : row('Input data', `<div class="inline-input-size">${esc(inputSize(data.inputData))}</div>${input}`, 'Complete transaction input, with supported ABI decoding and original byte access.', 'tx-input-row')) +
      row('More details', `<button type="button" class="tx-details-toggle" aria-expanded="true" data-advanced-toggle>− Click to show less</button>`, 'Collapse or expand the additional gas and input details.')) +
    `<p id="txCopyStatus" class="copy-status" role="status"></p><p class="tx-record-note">Daisugi testnet transaction. Test ETH has no monetary value.</p></div>`;
}
export function attachTransactionDetailEvents(container) {
  container.addEventListener('click', async event => {
    const tab = event.target.closest('[data-transfer-view]');
    if (tab) { container.querySelectorAll('[data-transfer-view]').forEach(button => button.setAttribute('aria-pressed', String(button === tab))); container.querySelectorAll('[data-transfer-list]').forEach(list => { list.hidden = list.dataset.transferList !== tab.dataset.transferView; }); return; }
    const toggle = event.target.closest('[data-advanced-toggle]');
    if (toggle) { const panel = toggle.closest('.tx-panel'), collapsed = panel.classList.toggle('tx-collapsed'); toggle.setAttribute('aria-expanded', String(!collapsed)); toggle.textContent = collapsed ? '+ Click to show more' : '− Click to show less'; return; }
    const button = event.target.closest('[data-copy-value]'); if (!button) return;
    const status = document.getElementById('txCopyStatus');
    try { await navigator.clipboard.writeText(button.dataset.copyValue); if (status) status.textContent = 'Copied to clipboard.'; }
    catch { if (status) status.textContent = 'Clipboard access unavailable. Select the value and copy it manually.'; }
  });
  container.addEventListener('change', event => {
    if (!event.target.matches('[data-tx-timezone]')) return;
    const time = event.target.closest('.timestamp-value').querySelector('[data-tx-time]');
    time.textContent = formatTimestamp(time.dataset.txTime, {local: event.target.value === 'local'});
  });
}
