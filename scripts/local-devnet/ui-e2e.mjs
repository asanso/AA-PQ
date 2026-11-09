// Real-browser end-to-end test: the unpacked NiceTry extension in an isolated Chromium profile, the AA-PQ portal and
// explorer pages, a local daisugi-devnet run. Every on-chain claim is checked against the execution node.
// Usage: node scripts/local-devnet/ui-e2e.mjs <devnet run dir> <extension dir> [wrong-network extension dir]
// Env: CHROMIUM (default /usr/bin/chromium), EL_RPC (default http://127.0.0.1:28545), PORTAL_RPC (default http://127.0.0.1:3004/rpc).
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const repo = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const [run, extension, wrongExtension] = process.argv.slice(2).map(p => p && resolve(p));
if (!extension) throw Error('Usage: ui-e2e.mjs <devnet run dir> <extension dir> [wrong-network extension dir]');
const e = createRequire(join(repo, 'frontend/package.json'))('ethers');
const { decodeBlockProof } = await import(join(repo, 'explorer/aggregation-proof.mjs'));
const wallet = JSON.parse(readFileSync(join(run, 'aa-pq/wallet-profile.json'), 'utf8'));
const EL = process.env.EL_RPC ?? 'http://127.0.0.1:28545';
const ORIGIN = 'https://daisugi.test:8443';
const PASSWORD = 'Devnet-Only-' + e.hexlify(e.randomBytes(6)) + '!';
// daisugi.test resolves to this host, and only the run's own self-signed certificate is trusted.
const SPKI = readFileSync(join(run, 'aa-pq/tls/spki.txt'), 'utf8').trim();
const BROWSER_ARGS = ['--no-first-run', '--host-resolver-rules=MAP daisugi.test 127.0.0.1', `--ignore-certificate-errors-spki-list=${SPKI}`];
const results = { chainId: wallet.chainId, factory: wallet.factory, checks: [] };
const ok = (name, detail = '') => { results.checks.push(name); console.log('PASS', name, detail); };
const node = async (method, params = []) => {
  const body = await (await fetch(EL, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
  if (body.error) throw Error(body.error.message);
  return body.result;
};

async function launch(ext) {
  const profile = mkdtempSync(join(tmpdir(), 'nicetry-e2e-'));
  let ctx;
  const close = async () => { await ctx?.close(); rmSync(profile, { recursive: true, force: true }); };
  try {
    ctx = await chromium.launchPersistentContext(profile, { executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium',
      // HEADED=1 shows the window; SLOW_MO=<ms> slows each browser action so a person can follow it.
      headless: false, viewport: { width: 420, height: 720 }, slowMo: Number(process.env.SLOW_MO ?? 0),
      args: [...(process.env.HEADED === '1' ? [] : ['--headless=new']), `--disable-extensions-except=${ext}`, `--load-extension=${ext}`, ...BROWSER_ARGS] });
    let [worker] = ctx.serviceWorkers();
    worker ??= await ctx.waitForEvent('serviceworker', { timeout: 20000 });
    return { ctx, id: new URL(worker.url()).host, close };
  } catch (error) { await close(); throw error; }
}
const text = async page => (await page.innerText('body')).replace(/\s*\n+\s*/g, ' | ');
// Extension pages forbid eval, so waits poll the rendered text from Node.
async function waitText(page, pattern, timeout = 60000) {
  for (const end = Date.now() + timeout; Date.now() < end; await page.waitForTimeout(500)) {
    const shown = await text(page);
    if (pattern.test(shown)) return shown;
  }
  throw Error('timed out waiting for ' + pattern + ': ' + (await text(page)).slice(0, 300));
}
// The dashboard's transaction list is a collapsible section.
async function openHistory(page) {
  await page.getByText('TOTAL BALANCE').waitFor({ timeout: 60000 });
  if (!/LAST 30 DAYS/.test(await text(page))) await page.getByRole('button', { name: 'Transactions' }).first().click();
}
const button = (page, name) => page.getByRole('button', { name, exact: false }).first();

async function onboard({ ctx, id }) {
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${id}/onboarding.html`);
  await page.getByText('CREATE NEW WALLET').click();
  await page.getByText('ERC-4337', { exact: true }).click();
  const aaDisabled = await button(page, 'Continue').isDisabled();
  const aaNote = await text(page);
  await page.getByText('Aggregated frames', { exact: true }).click();
  assert.equal(await button(page, 'Continue').isDisabled(), false);
  await button(page, 'Continue').click();
  await page.fill('input[placeholder="Enter password"]', PASSWORD);
  await page.fill('input[placeholder="Confirm Password"]', PASSWORD);
  await page.locator('input[type=checkbox]').check();
  await button(page, 'Create new wallet').click();
  await button(page, 'Reveal and backup').click();
  await button(page, 'Backup seed phrase').click({ timeout: 30000 }); // enabled after the backup countdown
  await page.getByText('OPEN WALLET').waitFor({ timeout: 60000 });
  await page.close();
  return { aaDisabled, aaNote };
}
async function popup({ ctx, id }, prepare = async () => {}) {
  const page = await ctx.newPage();
  await prepare(page);
  await page.goto(`chrome-extension://${id}/popup.html`);
  const unlock = page.locator('input[type=password]'), dashboard = page.getByText('TOTAL BALANCE');
  await unlock.or(dashboard).first().waitFor({ timeout: 60000 });
  if (await unlock.isVisible()) {
    await unlock.fill(PASSWORD);
    await button(page, 'Unlock').click();
  }
  await dashboard.waitFor({ timeout: 60000 });
  return page;
}
async function address(page) {
  await button(page, 'Receive').click();
  await page.getByText('YOUR ADDRESS').waitFor({ timeout: 30000 });
  const value = (await waitText(page, /0x[0-9a-fA-F]{40}/)).match(/0x[0-9a-fA-F]{40}/)[0];
  await page.goBack();
  return e.getAddress(value);
}
async function balanceShown(page, minimum) {
  for (let i = 0; i < 30; i++) {
    await page.reload();
    await page.getByText('TOTAL BALANCE').waitFor({ timeout: 60000 });
    await page.waitForTimeout(2000);
    const shown = Number((await text(page)).match(/TOTAL BALANCE \| ([0-9.]+)/)?.[1] ?? 'NaN');
    if (shown >= minimum) return shown;
  }
  throw Error('balance never reached ' + minimum);
}
async function send(page, to, amount) {
  await button(page, 'Send').click();
  await page.getByText(/[0-9.]+ ETH/).first().click();
  await button(page, 'Confirm').click();
  await page.fill('input[placeholder="Ex. 0x71C7…976F"]', to);
  await page.fill('input[placeholder="Ex. 0.0425"]', amount);
  await button(page, 'Confirm').click();
  await page.getByText('Confirm transaction').waitFor({ timeout: 60000 });
  const review = await waitText(page, /NONCE \| \d+ \|[\s\S]*Maximum/);
  await button(page, 'Confirm').click();
  return review;
}
async function frameTransactions(sender, fromBlock) {
  const head = Number(await node('eth_blockNumber')), found = [];
  for (let n = fromBlock; n <= head; n++) {
    const block = await node('eth_getBlockByNumber', ['0x' + n.toString(16), true]);
    for (const tx of block.transactions) if (tx.type === '0x6' && e.getAddress(tx.sender ?? tx.from) === sender) found.push({ tx, block });
  }
  return found;
}
async function verifyOnNode(sender, fromBlock, count, frames) {
  for (let i = 0; i < 60; i++) {
    const found = await frameTransactions(sender, fromBlock);
    if (found.length >= count) {
      const { tx, block } = found[count - 1];
      const receipt = await node('eth_getTransactionReceipt', [tx.hash]);
      assert.equal(Number(receipt.status), 1);
      assert.equal(receipt.frameReceipts.length, frames);
      assert.ok(receipt.frameReceipts.every(f => Number(f.status) === 1));
      const proof = decodeBlockProof(await node('debug_getRawBlock', [block.number]), block.hash, tx.hash, 'eip8288-lean');
      assert.equal(proof.status, 'available'); assert.equal(proof.commitmentMatches, true); assert.equal(proof.transactionCovered, true);
      return { hash: tx.hash, block: Number(block.number), gasUsed: Number(receipt.gasUsed), frames, proofBytes: proof.proofBytes };
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  throw Error(`transaction ${count} from ${sender} not found`);
}
async function portal(ctx, path) {
  const page = await ctx.newPage();
  await page.goto(ORIGIN + path);
  return page;
}
async function explorerShows(ctx, record, sender) {
  const page = await portal(ctx, '/explorer/tx/' + record.hash);
  await page.getByText(`${record.frames}/${record.frames} frames succeeded`).waitFor({ timeout: 60000 });
  const shown = await text(page);
  for (const expected of [record.hash, sender, record.gasUsed.toLocaleString('en-US'), record.proofBytes.toLocaleString('en-US') + ' bytes'])
    assert.ok(shown.includes(expected), `explorer page lacks ${expected}`);
  assert.ok(await page.locator(`a[href$="/block/${record.block}"]`).count() > 0, 'explorer page lacks the block link');
  await page.close();
}

const startBlock = Number(await node('eth_blockNumber'));
const recipient = e.Wallet.createRandom().address;
const browser = await launch(extension);
try {
  // Onboarding and network identity.
  const { aaDisabled, aaNote } = await onboard(browser);
  assert.equal(aaDisabled, true); assert.match(aaNote, /ERC-4337 is not deployed on this network/);
  ok('ERC-4337 setup is unavailable on this network');
  let page = await popup(browser);
  assert.match(await text(page), /SPHINCS-G · AGGREGATED FRAMES/);
  const sender = await address(page);
  ok('onboarding created an aggregated-frames account', sender);
  assert.equal(await node('eth_chainId'), '0x' + wallet.chainId.toString(16));

  // Funding through the portal faucet page.
  const faucet = await portal(browser.ctx, '/faucet');
  await faucet.waitForTimeout(1500);
  assert.deepEqual(await faucet.locator('[data-chain-id]').allInnerTexts(), Array(3).fill(String(wallet.chainId)));
  await faucet.fill('#faucetAddress', sender);
  await faucet.click('#faucetSend');
  await faucet.waitForSelector('#faucetResult:not([hidden])', { timeout: 60000 });
  ok('portal faucet page funded the account', await faucet.innerText('#faucetHash'));
  await faucet.close();
  await balanceShown(page, 1);
  ok('extension shows the funded balance');

  // Account creation (4 frames) from the extension UI.
  let review = await send(page, recipient, '0.01');
  assert.match(review, /NONCE \| 0/);
  const first = await verifyOnNode(sender, startBlock, 1, 4);
  const code = await node('eth_getCode', [sender, 'latest']);
  // EIP-1167 clone of the lean implementation followed by the account's key hash.
  assert.match(code.toLowerCase(), new RegExp('^0x363d3d373d3d3d363d73' + wallet.implementation.slice(2).toLowerCase() + '5af43d82803e903d91602b57fd5bf3[0-9a-f]{64}$'));
  ok('extension UI sent the 4-frame account creation; node confirms status, frames and body proof', JSON.stringify(first));

  // Transfer from the deployed account (3 frames).
  page = await popup(browser);
  review = await send(page, recipient, '0.02');
  assert.match(review, /NONCE \| 2/);
  const second = await verifyOnNode(sender, startBlock, 2, 3);
  assert.equal(await node('eth_getBalance', [recipient, 'latest']), e.toQuantity(e.parseEther('0.03')));
  ok('extension UI sent the 3-frame transfer; node confirms status, frames, body proof and recipient balance', JSON.stringify(second));

  // The portal explorer shows what the node holds.
  await explorerShows(browser.ctx, first, sender);
  await explorerShows(browser.ctx, second, sender);
  ok('portal explorer pages match the node for both transactions');

  // Refresh: a reloaded popup shows the node's balance and both sends.
  page = await popup(browser);
  const listed = record => `${record.hash.slice(0, 6)}…${record.hash.slice(-4)}`;
  const nodeBalance = Number(e.formatEther(await node('eth_getBalance', [sender, 'latest']))).toFixed(6);
  await openHistory(page);
  await waitText(page, new RegExp(`TOTAL BALANCE \\| ${nodeBalance}[\\s\\S]*${listed(second)}[\\s\\S]*${listed(first)}`));
  ok('reloaded popup matches the node balance and history', nodeBalance);

  // A gateway that refuses the wallet before submission (here: aggregation disabled on the endpoint). The client's
  // pre-send probe fails, the UI shows TRANSACTION FAILED, nothing is broadcast and the next send works.
  const refuse = methods => async route => {
    if (methods.some(method => route.request().postData()?.includes(`"${method}"`)))
      return route.fulfill({ status: 400, contentType: 'application/json',
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Native aggregation is not enabled on this endpoint.' } }) });
    return route.continue();
  };
  let nonce = await node('eth_getTransactionCount', [sender, 'pending']);
  await page.route('**/rpc', refuse(['eth_getProofWrapper', 'eth_sendProofWrapper']));
  await send(page, recipient, '0.03');
  await waitText(page, /TRANSACTION FAILED/i);
  assert.equal(await node('eth_getTransactionCount', [sender, 'pending']), nonce);
  await page.unroute('**/rpc');
  ok('a gateway refusing aggregation shows TRANSACTION FAILED and broadcasts nothing');
  page = await popup(browser);
  await send(page, recipient, '0.03');
  const third = await verifyOnNode(sender, startBlock, 3, 3);
  ok('the next send after that failure succeeds', third.hash);

  // The gateway refuses the submission itself with a JSON-RPC error: a definite rejection. The UI reports it,
  // nothing is broadcast, and the wallet is not blocked.
  const credited = async () => e.formatEther(BigInt(await node('eth_getBalance', [recipient, 'latest'])));
  page = await popup(browser);
  nonce = await node('eth_getTransactionCount', [sender, 'pending']);
  await page.route('**/rpc', refuse(['eth_sendProofWrapper']));
  await send(page, recipient, '0.04');
  await waitText(page, /TRANSACTION FAILED[\s\S]*rejected this transaction/i);
  assert.equal(await node('eth_getTransactionCount', [sender, 'pending']), nonce);
  await page.unroute('**/rpc');
  page = await popup(browser);
  await send(page, recipient, '0.04');
  const fourth = await verifyOnNode(sender, startBlock, 4, 3);
  assert.equal(await credited(), '0.1');
  ok('a rejected submission shows TRANSACTION FAILED, broadcasts nothing and leaves the wallet usable', fourth.hash);

  // Ambiguous outcome, actually broadcast: the gateway forwards the wrapper but its reply is lost. The wallet keeps the
  // hash, finds the receipt and resolves the send; the transfer happens exactly once.
  page = await popup(browser);
  await page.route('**/rpc', async route => {
    if (!route.request().postData()?.includes('"eth_sendProofWrapper"')) return route.continue();
    // route.fetch runs in Node, outside the browser's daisugi.test mapping: forward to the portal behind the HTTPS front.
    await route.fetch({ url: process.env.PORTAL_RPC ?? 'http://127.0.0.1:3004/rpc' });
    return route.fulfill({ status: 502, contentType: 'text/plain', body: 'Bad Gateway' });
  });
  await send(page, recipient, '0.05');
  const fifth = await verifyOnNode(sender, startBlock, 5, 3);
  await page.unroute('**/rpc');
  page = await popup(browser);
  await openHistory(page);
  assert.doesNotMatch(await waitText(page, new RegExp(`${listed(fifth)}`)), /Pending confirmation/i);
  assert.equal(await credited(), '0.15');
  ok('a lost reply after broadcast resolves from the receipt, once', fifth.hash);

  // Ambiguous outcome, never broadcast: the request fails in transit. The wallet re-sends the identical signed
  // wrapper; it is included once, and nothing else is sent for that nonce.
  page = await popup(browser);
  let dropped = 0;
  await page.route('**/rpc', async route => {
    if (route.request().postData()?.includes('"eth_sendProofWrapper"') && dropped++ === 0) return route.abort('failed');
    return route.continue();
  });
  await send(page, recipient, '0.06');
  const sixth = await verifyOnNode(sender, startBlock, 6, 3);
  await page.unroute('**/rpc');
  // The re-send may come from this page or any other open wallet page polling the journal; it is the identical
  // wrapper, and the nonce lets it be included only once.
  assert.ok(dropped >= 1, 'the first submission was not dropped');
  assert.equal((await frameTransactions(sender, startBlock)).length, 6);
  assert.equal(await credited(), '0.21');
  ok('a submission lost in transit is re-sent as the same bytes and included once', sixth.hash);

  // An unreachable RPC shows the balance as unavailable, not as zero.
  page = await popup(browser, offline => offline.route('**/rpc', route => route.abort('connectionrefused')));
  const shownOffline = await waitText(page, /Balance unavailable/);
  assert.match(shownOffline, /TOTAL BALANCE \| — \|/);
  assert.doesNotMatch(shownOffline, /TOTAL BALANCE \| 0\.000000/);
  await page.close();
  ok('an unreachable RPC shows the balance as unavailable');
  results.sends = [first, second, third, fourth, fifth, sixth];
} finally {
  await browser.close();
}

// Wrong network: an extension built for another chain ID refuses to prepare a transaction on this RPC.
if (wrongExtension) {
  const wrong = await launch(wrongExtension);
  try {
    await onboard(wrong);
    const page = await popup(wrong);
    const sender = await address(page);
    const faucet = await portal(wrong.ctx, '/faucet');
    await faucet.fill('#faucetAddress', sender);
    await faucet.click('#faucetSend');
    await faucet.waitForSelector('#faucetResult:not([hidden])', { timeout: 60000 });
    await faucet.close();
    await balanceShown(page, 1);
    const nonce = await node('eth_getTransactionCount', [sender, 'pending']);
    await send(page, recipient, '0.01');
    await waitText(page, /Unexpected network/);
    assert.equal(await node('eth_getTransactionCount', [sender, 'pending']), nonce);
    ok('an extension built for another chain refuses to prepare: Unexpected network');
  } finally {
    await wrong.close();
  }
}
console.log(JSON.stringify(results, null, 2));
