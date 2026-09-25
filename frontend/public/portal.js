import {site} from '/routes.js';
import {formatUnits, isAddress} from '/ethers.js';
import './faucet.js';
import {renderTransactionDetails,attachTransactionDetailEvents} from './transaction-view.js';
import {renderTimestamp} from './timestamp.js';
import {renderInputPanel as dataPanel,clearInputPanels,attachInputPanelEvents} from './input-data.js';

const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const hashPattern = /^0x[0-9a-fA-F]{64}$/;
const short = (value, size = 8) => String(value).length > size * 2 + 3 ? String(value).slice(0,size + 2) + '…' + String(value).slice(-size) : String(value);
const integer = value => /^\d+$/.test(String(value)) ? BigInt(value).toLocaleString('en-US') : '—';
const mono = value => `<span class="mono">${esc(value ?? '—')}</span>`;
const empty = message => `<p class="empty-state">${esc(message)}</p>`;
const age = timestamp => {
  if (!Number.isFinite(Number(timestamp))) return '—';
  const seconds = Math.max(0, Math.floor(Date.now()/1000 - Number(timestamp)));
  return seconds < 60 ? `${seconds}s ago` : seconds < 3600 ? `${Math.floor(seconds/60)}m ago` : seconds < 86400 ? `${Math.floor(seconds/3600)}h ago` : `${Math.floor(seconds/86400)}d ago`;
};
function units(value, decimals = 18) {
  try {return formatUnits(BigInt(value), decimals);} catch {return '—';}
}
function validId(type, value) {
  return type === 'address' ? isAddress(value) : type === 'block' ? /^\d{1,12}$/.test(String(value)) : ['tx','op'].includes(type) && hashPattern.test(value);
}
function link(type, value, label) {
  if (!validId(type, value)) return mono(value);
  return `<a class="mono" href="${esc(site.href({page:'explorer',kind:type,id:value}))}" title="${esc(value)}">${esc(label ?? (type === 'block' ? integer(value) : short(value)))}</a>`;
}
const outcome = success => typeof success === 'boolean' ? `<span class="status-text${success ? '' : ' fail'}">${success ? 'Success' : 'Reverted'}</span>` : '<span class="subtle">Unknown</span>';
const frameOutcome = tx => tx.status !== 'Success' ? esc(tx.status) : !tx.resultsComplete ? 'Results incomplete' :
  tx.frameStatuses.every(status=>status==='Success') ? '<span class="status-text">All frames succeeded</span>' : '<span class="status-text fail">Frame failure / skip</span>';
function frameCoverage(index) {
  if (!index || index.count == null) return index?.message || 'Native frame index is unavailable.';
  return `Coverage: blocks ${integer(index.indexedFrom)}–${integer(index.indexedTo)}. ` +
    (index.status === 'complete' ? 'Indexed from frame activation.' : 'Historical indexing or tip synchronization is in progress; this count is partial.') + (index.message ? ' '+index.message : '');
}
let page = 'explorer', sub = '', routeVersion = 0, refreshing = false;
let overview = null, network = null, explorerError = '', networkError = '';

async function api(path) {
  const response = await fetch(path, {cache:'no-store', signal:AbortSignal.timeout(15000)});
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(data.error || 'The service is currently unavailable.');
  return data;
}
function markLinks(selector, attribute, value) {
  document.querySelectorAll(selector).forEach(item => {
    const active = item.getAttribute(attribute) === value;
    item.classList.toggle('active', active);
    if (active) item.setAttribute('aria-current','page'); else item.removeAttribute('aria-current');
  });
}
function row(symbol, main, secondary, meta) {
  return `<div class="activity-row"><span class="row-symbol" aria-hidden="true">${symbol}</span><div class="row-main">${main}<small>${secondary}</small></div><div class="row-meta">${meta}</div></div>`;
}
function showOverview() {
  $('metricBlock').textContent = network ? integer(network.blockNumber) : '—';
  $('metricBlock').href = site.href(network ? {page:'explorer',kind:'block',id:network.blockNumber} : {page:'explorer'});
  $('metricBlockAge').textContent = network ? age(network.blockTimestamp) : 'RPC unavailable';
  const fee = network?.baseFeePerGas;
  const feeInWei = fee != null && /^\d+$/.test(fee) && BigInt(fee) < 1000000000n;
  $('metricFee').textContent = fee != null ? feeInWei ? integer(fee) : units(fee,9) : '—';
  $('metricFeeUnit').textContent = 'Current block · ' + (feeInWei || fee == null ? 'Wei' : 'Gwei');
  $('metricOps').textContent = overview ? integer(overview.operationCount) : '—';
  const frames = overview?.nativeFrames;
  $('metricFrames').textContent = frames?.count == null ? '—' : integer(frames.count);
  $('frameIndexStatus').textContent = frames?.status === 'complete' ? 'Type 0x06 · native transactions' : 'Partial index · see coverage below';
  $('frameCoverage').textContent = frameCoverage(frames);
  $('latestFrames').innerHTML = frames?.transactions?.slice(0,5).map(tx=>row('Fr',link('tx',tx.hash),'From '+link('address',tx.from,short(tx.from,5))+'<br>'+renderTimestamp(tx.timestamp,{compact:true}),`${integer(tx.frameCount)} frames<br>${frameOutcome(tx)}`)).join('') || empty(frames?.count != null ? 'No native frame transactions in the indexed range.' : 'Native frame data is unavailable.');
  $('overviewError').hidden = !explorerError && !networkError;
  $('overviewError').textContent = [networkError && 'Network: ' + networkError, explorerError && 'Explorer: ' + explorerError].filter(Boolean).join(' ');
  $('activityStatus').textContent = !overview ? 'Explorer unavailable' : overview.entryPointIndex?.message ||
    (overview.indexedTo < 0 ? 'ERC-4337 index is warming up…' : 'ERC-4337 indexed through block ' + integer(overview.indexedTo));
  $('latestBlocks').innerHTML = overview?.blocks?.slice(0,5).map(block => row('Bk',link('block',block.number),esc(age(block.timestamp)),`${integer(block.transactionCount)} txns`)).join('') || empty(overview ? 'No blocks indexed yet.' : 'Block data is unavailable.');
  $('latestOperations').innerHTML = overview?.operations?.slice(0,5).map(op => row('Op',link('op',op.userOpHash),'From ' + link('address',op.sender,short(op.sender,5)) + '<br>' + renderTimestamp(op.timestamp,{compact:true}),outcome(op.success))).join('') || empty(overview ? 'No UserOperations indexed yet.' : 'UserOperation data is unavailable.');
}
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const results = await Promise.allSettled([api('/api/network'),api('/api/explorer/overview')]);
    if (results[0].status === 'fulfilled' && Number(results[0].value.chainId) === 1337) {network = results[0].value; networkError = '';}
    else {network = null; networkError = results[0].reason?.message || 'Unexpected chain. Daisugi requires chain 1337.';}
    if (results[1].status === 'fulfilled' && Number(results[1].value.chainId) === 1337) {overview = results[1].value; explorerError = '';}
    else {overview = null; explorerError = results[1].reason?.message || 'The explorer is not connected to Daisugi.';}
    showOverview();
  } finally {refreshing = false;}
}
function table(title, caption, headings, rows, noRows) {
  return `<section class="panel"><div class="table-heading"><h2>${esc(title)}</h2><span>${esc(caption)}</span></div>${rows.length ? '<div class="table-scroll"><table class="data-table"><thead><tr>' + headings.map(h=>'<th scope="col">'+esc(h)+'</th>').join('') + '</tr></thead><tbody>' + rows.map(cells=>'<tr>'+cells.map(cell=>'<td>'+cell+'</td>').join('')+'</tr>').join('') + '</tbody></table></div>' : empty(noRows)}</section>`;
}
function detail(title, fields, extra='') {
  return `<a class="back-link" href="${esc(site.href({page:'explorer'}))}">← Back to explorer</a><section class="panel detail-panel"><div class="panel-heading"><h2>${esc(title)}</h2><span class="tag">Daisugi · 1337</span></div><dl class="definition-list">${fields.map(([key,value])=>'<dt>'+esc(key)+'</dt><dd>'+value+'</dd>').join('')}</dl>${extra}</section>`;
}
function operationRows(operations) {
  return table('UserOperations','Events associated with this record',['Hash','Sender','Block','Timestamp (UTC)','Result'],operations.map(o=>[link('op',o.userOpHash),link('address',o.sender),link('block',o.blockNumber),renderTimestamp(o.timestamp,{compact:true}),outcome(o.success)]),'No UserOperation events indexed for this record.');
}
function frameRows(index) {
  return table('Native frame transactions',frameCoverage(index),['Hash','Sender','Block','Timestamp (UTC)','Frame execution'],(index?.transactions || []).map(tx=>[link('tx',tx.hash),link('address',tx.from),link('block',tx.blockNumber),renderTimestamp(tx.timestamp,{compact:true}),frameOutcome(tx)]),'No matching transactions in the indexed range.');
}
const isHexData = value => typeof value === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(value);
function dataSize(value) {
  return isHexData(value) ? `${integer((value.length-2)/2)} bytes · ${integer((value.length-2)*4)} bits` : 'Unavailable';
}
function transactionInputPanel(data, enclosing = false) {
  return dataPanel({id:'transactionInput',title:enclosing ? 'Enclosing transaction input data' : 'Transaction input data',value:data.inputData,decoded:data.inputDecoded,error:data.inputDataError,selector:true,creation:data.inputIsContractCreation,
    description:data.inputIsContractCreation ? 'Complete contract creation bytecode and constructor arguments submitted in this transaction.' : enclosing ? 'Complete input of the transaction containing this UserOperation, including every operation encoded in the bundle.' : 'Complete input submitted to the destination address, including the function selector and encoded arguments when present.'});
}
function renderDetail(kind, data) {
  clearInputPanels();
  const section=document.querySelector('[data-page="record"]');section.classList.add('show-record');
  section.classList.toggle('show-native-record',kind==='tx' && (Number(data.transactionDetails?.type ?? data.type)===6 || !!data.nativeFrame));
  section.querySelector('.page-heading h1').textContent=kind==='tx'?'Transaction details':kind==='op'?'UserOperation details':kind==='address'?'Address details':'Block details';
  section.querySelector('.page-heading p:not(.eyebrow)').textContent='On-chain records from Daisugi.';
  if (kind === 'block') return detail('Block ' + integer(data.number),[['Block number',mono(integer(data.number))],['Block hash',mono(data.hash)],['Timestamp',renderTimestamp(data.timestamp)],['Transactions',integer(data.transactionCount)],['Gas used',mono(integer(data.gasUsed))],['Gas limit',mono(integer(data.gasLimit))]]) + table('Transactions','Included in this block',['Transaction hash','Timestamp (UTC)'],(data.transactions || []).map(tx=>[link('tx',typeof tx === 'string' ? tx : tx.hash,typeof tx === 'string' ? tx : tx.hash),renderTimestamp(data.timestamp,{compact:true})]),'This block contains no transactions.');
  if (kind === 'address') return detail('Address', [['Address',mono(data.address)],['Balance',esc(data.balance) + ' ETH'],['Account type',esc(data.type)],['ERC-4337 deployment',data.deployment ? link('tx',data.deployment.transactionHash) : '<span class="subtle">No indexed EntryPoint deployment</span>']]) + frameRows(data.nativeFrames) + operationRows(data.operations || []);
  if (kind === 'op') {
    return detail('UserOperation', [['UserOperation hash',mono(data.userOpHash)],['Sender',link('address',data.sender,data.sender)],['Transaction',link('tx',data.transactionHash,data.transactionHash)],['Block',link('block',data.blockNumber)],['Timestamp',renderTimestamp(data.timestamp ?? data.transactionDetails?.timestamp)],['Result',outcome(data.success)],['Nonce',mono(data.nonce)],['Actual gas used',mono(integer(data.actualGasUsed))],['Actual gas cost',esc(units(data.actualGasCost)) + ' ETH'],['Paymaster',link('address',data.paymaster,data.paymaster)],['Signature size',dataSize(data.signature)],['Call data size',dataSize(data.operationCallData)]])
      + dataPanel({id:'operationSignature',title:'Signature data',value:data.signature,description:'Signature submitted for this UserOperation. Byte and bit counts describe its encoded length, not its security strength.'})
      + dataPanel({id:'operationCallData',title:'UserOperation call data',value:data.operationCallData,decoded:data.operationCallDecoded,selector:true,description:'The exact callData field passed to the smart account for this operation, extracted from the EntryPoint bundle.',error:data.inputDataError || 'The operation could not be uniquely decoded from a supported EntryPoint call. Its enclosing transaction input is shown below when available.'})
      + transactionInputPanel(data,true);
  }
  return renderTransactionDetails(data)
    + (data.events?.length ? operationRows(data.events.filter(e=>e.type === 'UserOperationEvent')) : '');
}
async function loadDetail(kind, id) {
  const version = routeVersion;
  $('explorerContent').innerHTML = empty('Loading record…');
  $('explorerStatus').textContent = '';
  if (!validId(kind === 'hash' ? 'tx' : kind,id)) {$('explorerContent').innerHTML = empty('Enter a valid address, block number or transaction / UserOperation hash.'); return;}
  try {
    let data, actualKind = kind;
    if (kind === 'hash') {
      try {data = await api('/api/explorer/tx/' + id); actualKind = 'tx';}
      catch {data = await api('/api/explorer/op/' + id); actualKind = 'op';}
    } else data = await api('/api/explorer/' + kind + '/' + id);
    if (version !== routeVersion) return;
    $('explorerContent').innerHTML = renderDetail(actualKind,data);
    $('explorerStatus').textContent = actualKind==='tx' && (Number(data.transactionDetails?.type ?? data.type)===6 || data.nativeFrame)
      ? '' : 'Read from Daisugi. Transaction inclusion, individual frame execution and UserOperation execution are separate results.';
  } catch(error) {
    if (version !== routeVersion) return;
    $('explorerContent').innerHTML = '<div class="inline-notice error" role="status">' + esc(error.message) + ' Check the identifier and try again.</div>';
  }
}
function rewriteLinks() {
  document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    const value = anchor.getAttribute('href');
    if (value === '#main') return;
    const route = site.resolve(new URL(value, location.href).href);
    if (route) anchor.href = site.href(route);
  });
}
function route() {
  const next = site.resolve(location.href);
  if (!next) return;
  const target = new URL(site.href(next));
  if (target.origin !== location.origin) { location.replace(target.href); return; }
  if (location.href !== target.href && location.hash !== '#main') history.replaceState(null,'',target.href);
  page = next.page;
  sub = next.kind || next.topic || '';
  routeVersion++;
  const record = page === 'explorer' && Boolean(next.kind);
  document.querySelectorAll('[data-page]').forEach(section => {section.hidden = section.dataset.page !== (record ? 'record' : page);});
  markLinks('[data-nav]','data-nav',page);
  $('mainNav').classList.remove('open'); $('menuToggle').setAttribute('aria-expanded','false');
  document.title = 'Daisugi — ' + ({explorer:'Explorer',faucet:'Testnet Faucet',overview:'Overview'})[page];
  if (record) void loadDetail(next.kind,next.id);
  if (page === 'overview' && next.topic) {
    const faq = [...document.querySelectorAll('[data-faq]')].find(item=>item.dataset.faq === next.topic);
    if (faq) {faq.open = true; requestAnimationFrame(()=>{if (page === 'overview') faq.scrollIntoView({block:'start',behavior:'instant'});});}
  } else if (location.hash === '#main') $('main').focus();
  else window.scrollTo({top:0,behavior:'instant'});
  if (page === 'explorer') void refresh();
}
function navigate(target) {
  const url = new URL(target,location.href);
  if (url.origin !== location.origin) { location.assign(url.href); return; }
  if (url.href !== location.href) history.pushState(null,'',url.href);
  route();
}
document.addEventListener('click',event=>{
  if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
  const anchor=event.target.closest('a[href]');
  if (!anchor || anchor.hasAttribute('download') || (anchor.target && anchor.target !== '_self') || anchor.getAttribute('href') === '#main') return;
  const url=new URL(anchor.href,location.href);
  if (url.origin !== location.origin) return;
  const next=site.resolve(url.href);
  if (!next) return;
  event.preventDefault();
  navigate(site.href(next));
});
rewriteLinks();
for (const name of ['overview','explorer']) {
  $(name + 'Search').addEventListener('submit',event=>{
    event.preventDefault();
    const form = event.currentTarget;
    const value = form.elements.query.value.trim(), kind = form.elements.kind.value;
    const type = kind === 'auto' ? isAddress(value) ? 'address' : /^\d{1,12}$/.test(value) ? 'block' : hashPattern.test(value) ? 'hash' : '' : kind;
    if (!validId(type === 'hash' ? 'tx' : type,value)) {$(name+'SearchStatus').textContent = 'Enter a valid address, a 64-character transaction / UserOperation hash, or a block number.'; return;}
    $(name+'SearchStatus').textContent = '';
    navigate(site.href({page:'explorer',kind:type,id:value}));
  });
}
attachInputPanelEvents($('explorerContent'));
attachTransactionDetailEvents($('explorerContent'));
$('menuToggle').addEventListener('click',()=>{$('menuToggle').setAttribute('aria-expanded',String($('mainNav').classList.toggle('open')));});
$('explorerRefresh').addEventListener('click',async()=>{await refresh(); if (page === 'explorer') route();});
window.addEventListener('hashchange',route);
window.addEventListener('popstate',route);
window.addEventListener('focus',()=>{if (!document.hidden && page === 'explorer') void refresh();});
document.addEventListener('visibilitychange',()=>{if (!document.hidden && page === 'explorer') void refresh();});
setInterval(()=>{if (!document.hidden && page === 'explorer') void refresh();},15000);

route();
