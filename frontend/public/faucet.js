import {site} from '/routes.js';
import {getAddress, isAddress} from '/ethers.js';

const form = document.getElementById('faucetForm');
const addressInput = document.getElementById('faucetAddress');
const sendButton = document.getElementById('faucetSend');
const status = document.getElementById('faucetStatus');
const result = document.getElementById('faucetResult');
const hash = document.getElementById('faucetHash');
const txLink = document.getElementById('faucetTxLink');
let pending = false;

function showStatus(message, kind = '') {
  status.textContent = message;
  status.className = 'wallet-status' + (kind ? ' ' + kind : '');
}

addressInput.addEventListener('input', () => {
  addressInput.removeAttribute('aria-invalid');
  result.hidden = true;
  hash.textContent = '';
  showStatus('');
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (pending || sendButton.disabled) return;
  result.hidden = true;
  hash.textContent = '';
  const value = addressInput.value.trim();
  if (!isAddress(value)) {
    addressInput.setAttribute('aria-invalid', 'true');
    showStatus('Enter a valid Ethereum address (0x followed by 40 hexadecimal characters, with a valid checksum if mixed case).', 'error');
    addressInput.focus();
    return;
  }
  const address = getAddress(value);
  addressInput.value = address;
  addressInput.removeAttribute('aria-invalid');
  pending = true;
  addressInput.disabled = sendButton.disabled = true;
  form.setAttribute('aria-busy', 'true');
  sendButton.textContent = 'Sending…';
  showStatus('Checking the faucet network…');
  let submitted = false;
  let outcomeKnown = false;
  try {
    // The faucet validates the server's Daisugi network before submitting.
    const configResponse = await fetch('/api/config', {cache: 'no-store'});
    if (!configResponse.ok) throw new Error('The faucet network is unavailable. Try again later.');
    const config = await configResponse.json();
    if (Number(config.chainId) !== 1337) throw new Error('This faucet is only available on Daisugi (chain 1337).');
    showStatus('Submitting 1 test ETH to ' + address + '…');
    submitted = true;
    const response = await fetch('/api/faucet', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({address, amount: '1'})
    });
    const data = await response.json();
    if (!response.ok) {
      // Input rejection is definitive; server/network errors may follow broadcast.
      outcomeKnown = response.status >= 400 && response.status < 500;
      throw new Error(typeof data.error === 'string' ? data.error : 'The faucet request failed.');
    }
    if (typeof data.hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(data.hash)) {
      throw new Error('The faucet did not return a valid transaction hash.');
    }
    outcomeKnown = true;
    hash.textContent = data.hash;
    if (txLink) txLink.href = site.href({page:'explorer',kind:'tx',id:data.hash});
    result.hidden = false;
    showStatus('Transaction submitted: 1 test ETH to ' + address + '. Waiting for network confirmation.', 'success');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to contact the faucet.';
    showStatus(message + (submitted && !outcomeKnown ? ' Check the recipient balance or explorer before sending another request; the transaction may already have been broadcast.' : ''), 'error');
  } finally {
    pending = false;
    addressInput.disabled = sendButton.disabled = false;
    form.removeAttribute('aria-busy');
    sendButton.textContent = 'Send 1 test ETH';
  }
});
