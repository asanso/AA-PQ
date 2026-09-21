import {Wallet, isAddress, ZeroAddress, parseEther} from '/ethers.js';
const $ = id => document.getElementById(id);
const storageKey = 'aa-pq-testnet-owner-v1';
const explorerUrl = new URL(location.href);
explorerUrl.port = '3001'; explorerUrl.pathname = '/'; explorerUrl.hash = '';
$('explorerLink').href = explorerUrl.href;
let wallet, sender, deployed = false, busy = false, history = [];
let currentView = 'wallet';
const walletPanels = [...document.querySelector('main').children].filter(el => !['welcome', 'sendPanel', 'settings'].includes(el.id) && el.tagName !== 'FOOTER');
function setView(view = 'wallet') {
  currentView = ['send', 'settings'].includes(view) ? view : 'wallet';
  for (const panel of walletPanels) panel.hidden = currentView !== 'wallet';
  $('sendPanel').hidden = currentView !== 'send' || !deployed;
  $('settings').hidden = currentView !== 'settings' || !deployed;
  document.querySelectorAll('.nav-links a').forEach((link, i) => {
    const selected = ['wallet', 'send', 'settings'][i] === currentView;
    link.classList.toggle('active', selected);
    if (selected) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  });
}
function navigate(view) {
  if (!deployed) return;
  location.hash = view === 'wallet' ? 'wallet' : view;
  setView(view);
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', () => setView(location.hash.slice(1)));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const short = address => `${address.slice(0, 8)}…${address.slice(-6)}`;
function status(message, error = false) {
  for (const id of ['aaStatus','setupStatus','sendStatus']) $(id).classList.remove('success');
  $('aaStatus').textContent = message;
  $('aaStatus').classList.toggle('error', error);
  $('setupStatus').textContent = message;
  $('setupStatus').classList.toggle('error', error);
  $('sendStatus').textContent = message;
  $('sendStatus').classList.toggle('error', error);
}
async function post(path, data) {
  const response = await fetch(path, {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(data)});
  const result = await response.json();
  if (!response.ok || result.error) throw new Error(result.error?.message || result.error || 'Request failed');
  return result;
}
async function rpc(path, method, params) {
  return (await post(path, {jsonrpc:'2.0', id:Date.now(), method, params})).result;
}
function controls() {
  document.body.classList.toggle('onboarding', !deployed);
  $('welcome').hidden = deployed;
  $('createAa').hidden = deployed;
  $('intro').hidden = deployed;
  $('backupAa').disabled = !wallet;
  $('fundAa').disabled = busy || !sender;
  $('openSend').disabled = busy || !deployed;
  $('send').disabled = busy || !deployed;
  $('copyAddress').disabled = !sender;
  setView(deployed ? location.hash.slice(1) : 'wallet');
}
function renderHistory() {
  if (!history.length) return;
  $('activity').replaceChildren();
  for (const entry of history.slice(0, 10)) {
    const row = document.createElement('div'); row.className = 'activity-row';
    const icon = document.createElement('span'); icon.className = 'icon blue'; icon.textContent = entry.kind === 'Received test ETH' ? '↓' : '↑';
    const info = document.createElement('div');
    const title = document.createElement('strong'); title.textContent = entry.kind;
    const detail = document.createElement('small'); detail.textContent = `${entry.amount ? entry.amount + ' ETH · ' : ''}${new Date(entry.time).toLocaleString()}`;
    const hash = document.createElement('a'); hash.className = 'activity-hash'; hash.textContent = entry.hash;
    hash.href = `${explorerUrl.href}#tx/${encodeURIComponent(entry.hash)}`; hash.target = '_blank'; hash.rel = 'noopener';
    const result = document.createElement('span'); result.className = 'result'; result.textContent = 'Confirmed';
    info.append(title, detail, hash); row.append(icon, info, result); $('activity').append(row);
  }
}
function record(kind, hash, amount) {
  history.unshift({kind, hash, amount, time:Date.now()});
  history = history.slice(0, 30);
  try {localStorage.setItem(`aa-pq-activity-${wallet.address}`, JSON.stringify(history));} catch {}
  renderHistory();
}
async function refresh() {
  const state = await post('/api/aa/prepare', {owner:wallet.address});
  sender = state.sender; deployed = state.deployed;
  $('aaAddress').textContent = short(sender);
  $('fullAddress').textContent = sender;
  $('ownerAddress').textContent = wallet.address;
  $('balance').textContent = $('assetBalance').textContent = Number(state.balance).toFixed(4);
  controls();
  return state;
}
async function fund() {
  const tx = await post('/api/faucet', {address:sender, amount:'1'});
  for (let i = 0; i < 60; i++) {
    const receipt = await rpc('/rpc', 'eth_getTransactionReceipt', [tx.hash]);
    if (receipt) {
      if (receipt.status !== '0x1') throw new Error('Funding transaction failed');
      record('Received test ETH', tx.hash, '1'); return;
    }
    await delay(1000);
  }
  throw new Error(`Funding is still pending. Transaction: ${tx.hash}`);
}
async function submit(state) {
  const cfg = await (await fetch('/api/config')).json();
  state.userOperation.signature = wallet.signingKey.sign(state.hash).serialized;
  status('Submitting your signed UserOperation…');
  const hash = await rpc('/bundler', 'eth_sendUserOperation', [state.userOperation, cfg.entryPoint]);
  status('Waiting for on-chain confirmation…');
  for (let i = 0; i < 90; i++) {
    const receipt = await rpc('/bundler', 'eth_getUserOperationReceipt', [hash]);
    if (receipt) {
      if (!receipt.success) throw new Error('The UserOperation reverted. No transfer was completed; network fees may apply.');
      return receipt.receipt.transactionHash;
    }
    await delay(1000);
  }
  throw new Error(`Still pending. Do not resend until this UserOperation is resolved: ${hash}`);
}
async function run(action) {
  if (busy) return;
  busy = true; controls();
  try {await action();} catch (error) {status(error.message, true);}
  finally {busy = false; controls();}
}
$('fundAa').onclick = () => run(async () => {
  status('Adding 1 test ETH to your AA wallet…');
  await fund(); await refresh(); status('Received 1 test ETH.');
});
function openSend() {
  if (!deployed) {status('Create your AA wallet to start sending.'); $('createAa').focus(); return;}
  navigate('send');
  $('sendTo').focus();
  if (!deployed) status('Create your AA wallet before sending ETH.');
}
$('openSend').onclick = openSend;
$('navSend').onclick = event => {event.preventDefault(); openSend();};
$('navSettings').onclick = event => {event.preventDefault(); navigate('settings');};
document.querySelector('.nav-links a').onclick = event => {event.preventDefault(); navigate('wallet');};
document.querySelector('.brand').onclick = event => {event.preventDefault(); navigate('wallet');};
$('closeSend').onclick = () => navigate('wallet');
$('closeSuccess').onclick = () => $('sendSuccess').close();
$('sendSuccess').addEventListener('close', () => $('openSend').focus());
$('sendForm').onsubmit = event => {
  event.preventDefault();
  run(async () => {
    if (!deployed) throw new Error('Create your AA wallet first.');
    const recipient = $('sendTo').value.trim(), amount = $('sendAmount').value.trim();
    if (!isAddress(recipient) || recipient === ZeroAddress) throw new Error('Enter a valid recipient address.');
    if (!/^\d{1,12}(\.\d{1,18})?$/.test(amount) || parseEther(amount) <= 0n) throw new Error('Enter a positive ETH amount with at most 18 decimal places.');
    status('Preparing your AA transfer…');
    const state = await post('/api/aa/prepare', {owner:wallet.address, recipient, amount});
    if (parseEther(state.balance) < parseEther(amount) + 1200000000000000n) throw new Error('Insufficient ETH for this transfer and network fees. Get test ETH or reduce the amount.');
    const hash = await submit(state);
    record('Sent ETH via AA', hash, amount);
    // Confirmation is final even if a subsequent balance refresh is unavailable.
    let refreshed = true;
    try {await refresh();} catch {refreshed = false;}
    status(`Sent ${amount} ETH from your AA wallet.${refreshed ? '' : ' Balance refresh is temporarily unavailable.'}`);
    for (const id of ['aaStatus','sendStatus']) $(id).classList.add('success');
    $('sendForm').reset();
    navigate('wallet');
    $('successMessage').textContent = `${amount} ETH sent to ${short(recipient)}.`;
    $('successReceipt').href = `${explorerUrl.href}#tx/${hash}`;
    $('sendSuccess').showModal();
  });
};
$('backupAa').onclick = () => {
  const blob = new Blob([JSON.stringify({network:'AA PQ testnet', chainId:1337, owner:wallet.address, privateKey:wallet.privateKey, smartAccount:sender}, null, 2)], {type:'application/json'});
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = 'aa-pq-testnet-wallet.json'; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
$('settingsBackup').onclick = () => $('backupAa').click();
$('copyAddress').onclick = async () => {
  try {
    if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(sender);
    else {
      const input = document.createElement('textarea'); input.value = sender;
      input.style.position = 'fixed'; input.style.opacity = '0'; document.body.append(input); input.select();
      const copied = document.execCommand('copy'); input.remove();
      if (!copied) throw new Error('Copy unavailable. Select the address under Wallet details.');
    }
    status('Smart account address copied.');
  } catch(error) {status(error.message, true);}
};
async function network() {
  try {
    const entries = await rpc('/bundler', 'eth_supportedEntryPoints', []);
    await rpc('/rpc', 'eth_blockNumber', []);
    if (!entries?.length) throw new Error('Bundler unavailable');
    $('networkStatus').textContent = 'Testnet online'; $('networkDot').className = 'online';
  } catch {$('networkStatus').textContent = 'Testnet unavailable'; $('networkDot').className = '';}
}
await network();
try {
  const saved = localStorage.getItem(storageKey);
  if (saved) {
    wallet = new Wallet(saved);
    try {const savedHistory = JSON.parse(localStorage.getItem(`aa-pq-activity-${wallet.address}`) || '[]'); if (Array.isArray(savedHistory)) history = savedHistory;} catch {}
    renderHistory();
    await refresh();
    status(deployed ? 'Your AA wallet is ready.' : 'This browser’s previous wallet was not deployed. Use NiceTry to create a new wallet.');
  } else {status('Ready when you are.');}
} catch(error) {status(`Unable to restore wallet: ${error.message}`, true);}
controls();
setInterval(() => {network(); if (wallet && !busy) refresh().catch(() => {});}, 15000);
