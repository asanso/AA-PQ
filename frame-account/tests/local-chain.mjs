// Shared test helpers: compile with the pinned Solidity settings and run a loopback Anvil.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import solc from 'solc';
import { JsonRpcProvider } from 'ethers';

/** Compiles contracts/<name>.sol for each name with Solidity 0.8.28, via IR, optimizer 200, Cancun. */
export function compile(names) {
  const sources = Object.fromEntries(names.map(name =>
    [`${name}.sol`, { content: readFileSync(new URL(`../contracts/${name}.sol`, import.meta.url), 'utf8') }]));
  assert.match(solc.version(), /^0\.8\.28\+/);
  const compiled = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources, settings: {
    optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: 'cancun',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } }
  } })));
  assert.deepEqual((compiled.errors || []).filter(error => error.severity === 'error'), []);
  return name => compiled.contracts[`${name}.sol`][name];
}

/** Starts Anvil on a free loopback port; returns { provider, stop }. ANVIL may name a non-Linux Anvil 1.7.1 binary. */
export async function startAnvil() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const processHandle = spawn(process.env.ANVIL || new URL('../node_modules/@foundry-rs/anvil-linux-amd64/bin/anvil', import.meta.url).pathname,
    ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '31337', '--hardfork', 'cancun', '--silent'],
    { stdio: ['ignore', 'ignore', 'pipe'] });
  let failed;
  processHandle.on('error', error => { failed = error; });
  processHandle.on('exit', code => { if (code) failed = Error(`Anvil exited: ${code}`); });
  const url = `http://127.0.0.1:${port}`;
  for (let retry = 0; retry < 40; retry++) {
    if (failed) throw failed;
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) });
      if ((await response.json()).result === '0x7a69') break;
    }
    catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  const provider = new JsonRpcProvider(url, undefined, { cacheTimeout: -1, batchMaxCount: 1 });
  assert.match(await provider.send('web3_clientVersion', []), /anvil/i);
  const stop = async () => {
    provider.destroy();
    if (processHandle.exitCode === null) {
      await new Promise(resolve => { processHandle.once('exit', resolve); processHandle.kill('SIGTERM'); });
    }
  };
  return { provider, stop };
}
