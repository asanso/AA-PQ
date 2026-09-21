const $ = id => document.getElementById(id);
const escape = value => String(value ?? '—').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const short = value => value ? `${value.slice(0,10)}…${value.slice(-6)}` : '—';
const link = (kind, value, full=false) => `<a class="mono" href="#${kind}/${encodeURIComponent(value)}" title="${escape(value)}">${escape(full ? value : short(value))}</a>`;
const eth = value => (Number(value)/1e18).toFixed(6);
let sequence=0;
const walletUrl = new URL(location.href);walletUrl.port='3000';walletUrl.hash='';walletUrl.pathname='/';$('walletLink').href=walletUrl.href;
async function api(path) {const r=await fetch(`/api/${path}`);const data=await r.json();if(!r.ok||data.error)throw new Error(data.error||'Request failed');return data;}
const empty = message => `<div class="empty">${escape(message)}</div>`;
function opRows(ops) {return ops.map(op=>`<div class="row"><span class="symbol">AA</span><div>${link('op',op.userOpHash)}<small>Account ${link('address',op.sender)} · Block <a href="#block/${op.blockNumber}">${op.blockNumber}</a></small></div><span class="tag ${op.success?'':'fail'}">${op.success?'AA confirmed':'AA reverted'}</span></div>`).join('')||empty('No confirmed UserOperations yet.');}
function blocksRows(blocks){return blocks.map(b=>`<div class="row"><span class="symbol">Bk</span><div><a href="#block/${b.number}">${b.number}</a><small>${new Date(b.timestamp*1000).toLocaleString()}</small></div><span class="tag">${b.transactionCount} txns</span></div>`).join('');}
const card = (title,body,more='') => `<section class="card"><div class="card-heading"><h2>${escape(title)}</h2>${more}</div>${body}</section>`;
function details(title,fields){return card(title,`<div class="info"><dl>${fields.map(([key,value])=>`<dt>${escape(key)}</dt><dd>${value}</dd>`).join('')}</dl></div>`);}
function walletsRows(wallets){return wallets.map(w=>`<div class="row"><span class="symbol">AA</span><div>${link('address',w.sender)}<small>Deployed in block <a href="#block/${w.blockNumber}">${w.blockNumber}</a> · ${link('tx',w.transactionHash)}</small></div><span class="tag">Smart account</span></div>`).join('')||empty('No AA deployments yet.');}
async function render(){
  const request=++sequence;const route=location.hash.slice(1);const [kind,id]=route.split('/');
  $('status').textContent='Reading on-chain data…';
  try {
    let html='';let message='Live chain data · refreshes every 10 seconds';
    if (!id) {
      const data=await api('overview');
      message=`Indexed through block ${data.indexedTo} · EntryPoint ${data.entryPoint}`;
      if (kind==='operations') html=card('Latest 20 confirmed UserOperations',opRows(data.operations));
      else if(kind==='blocks') html=card('Latest 12 blocks',blocksRows(data.blocks));
      else if(kind==='wallets') html=card('Latest 100 AA wallet deployments',walletsRows(data.wallets));
      else html=`<div class="stats">${[['Latest block',data.indexedTo],['UserOperations',data.operationCount],['AA wallets',data.walletCount],['Chain ID',data.chainId]].map(([name,value])=>`<div class="card stat"><small>${name}</small><strong>${value}</strong></div>`).join('')}</div><div class="columns">${card('Latest blocks',blocksRows(data.blocks.slice(0,6)),'<a href="#blocks">View blocks →</a>')}${card('Latest UserOperations',opRows(data.operations.slice(0,6)),'<a href="#operations">View operations →</a>')}</div>${card('AA verification',`<p class="note">AA labels come from UserOperationEvent logs emitted by the configured EntryPoint—not from transaction names or browser history. Faucet funding is an ordinary ETH transfer. Wallet sends use the bundler → EntryPoint → smart account path.</p>`)}`;
    } else if(kind==='block') {
      const b=await api(`block/${id}`);
      html=details(`Block #${b.number}`,[['Hash',`<span class="mono">${escape(b.hash)}</span>`],['Timestamp',escape(new Date(b.timestamp*1000).toLocaleString())],['Gas used / limit',`${b.gasUsed} / ${b.gasLimit}`]])+card('Transactions',b.transactions.map(tx=>`<div class="row">${link('tx',tx,true)}</div>`).join('')||empty('This block is empty.'));
    } else if(kind==='tx') {
      const tx=await api(`tx/${id}`);
      html=details('Transaction',[['Hash',escape(tx.hash)],['Status',escape(tx.status)],['Transaction type',tx.isAaBundle?'<span class="tag">ERC-4337 AA bundle</span>':'Ordinary Ethereum transaction (not a confirmed AA bundle)'],['From / bundler',link('address',tx.from,true)],['To',tx.to?link('address',tx.to,true):'Contract creation'],['Outer ETH value',`${tx.value} ETH`],['Block',`<a href="#block/${tx.blockNumber}">${tx.blockNumber??'Pending'}</a>`],['Gas used',escape(tx.gasUsed)],['Method selector',escape(tx.selector)]])+card('EntryPoint UserOperations',opRows(tx.events.filter(e=>e.type==='UserOperationEvent')));
    } else if(kind==='op') {
      const op=await api(`op/${id}`);
      const signature = op.signature == null
        ? '<p class="note">Signature unavailable: the enclosing transaction could not be decoded as a supported EntryPoint bundle.</p>'
        : `<p class="note">Full UserOperation signature from the bundle calldata · ${(op.signature.length-2)/2} bytes. These bytes alone do not identify the account’s signature scheme.</p><pre class="signature mono">${escape(op.signature)}</pre>`;
      html=details('UserOperation',[['UserOperation hash',escape(op.userOpHash)],['Smart account sender',link('address',op.sender,true)],['Execution',op.success?'Succeeded':'Reverted'],['Nonce',escape(op.nonce)],['Bundler transaction',link('tx',op.transactionHash,true)],['Block',`<a href="#block/${op.blockNumber}">${op.blockNumber}</a>`],['Actual gas cost',`${eth(op.actualGasCost)} ETH`],['Actual gas used',escape(op.actualGasUsed)],['Paymaster',op.paymaster==='0x0000000000000000000000000000000000000000'?'None — account pays gas':escape(op.paymaster)]]);
      html += card('Signature (hex)',signature);
    } else if(kind==='address') {
      const a=await api(`address/${id}`);
      html=details('Address',[['Address',escape(a.address)],['Account type',escape(a.type)],['ETH balance',`${escape(a.balance)} ETH`],...(a.deployment?[['Deployment transaction',link('tx',a.deployment.transactionHash,true)]]:[])])+card('Latest 100 UserOperations from this account',opRows(a.operations));
    } else throw new Error('Unknown explorer page');
    if(request!==sequence)return;
    $('content').innerHTML=(id?'<a class="back" href="#">← Back to explorer</a>':'')+html;
    $('status').textContent=message;
  } catch(error){if(request!==sequence)return;$('status').textContent=error.message;$('content').innerHTML=empty('No results. Check the address, hash, or block number.');}
}
$('searchForm').onsubmit=async event=>{
  event.preventDefault();const q=$('search').value.trim();
  if(/^\d{1,12}$/.test(q))location.hash=`block/${q}`;
  else if(/^0x[\da-fA-F]{40}$/.test(q))location.hash=`address/${q}`;
  else if(/^0x[\da-fA-F]{64}$/.test(q)){
    try{await api(`tx/${q}`);location.hash=`tx/${q}`;}catch{location.hash=`op/${q}`;}
  }else $('status').textContent='Enter a valid address, transaction/UserOperation hash, or block number.';
};
window.addEventListener('hashchange',()=>{render();window.scrollTo(0,0);});
render();setInterval(render,10000);
