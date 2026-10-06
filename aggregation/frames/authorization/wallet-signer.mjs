import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import vm from 'node:vm';

export const moduleSha256 = '117d793ce26f1a7fe152ce23884a03cd07663758b044d397f72eff5b901584ce';

export async function loadWalletSigner(filename, { getBytes, keccak256 }) {
  const original = await readFile(filename, 'utf8');
  if (createHash('sha256').update(original).digest('hex') !== moduleSha256) {
    throw Error('The original NiceTry 2.1.3 signing module does not match');
  }
  const context = vm.createContext({ TextEncoder, performance, console: { log() {} } },
    { codeGeneration: { strings: false, wasm: false } });
  const primitives = {
    ii: () => false, am: value => Buffer.from(value).toString('hex'), h: getBytes,
    ij: value => getBytes(keccak256(value)),
    ik: (...values) => new Uint8Array(Buffer.concat(values.map(value => Buffer.from(value)))),
    il: value => new Uint8Array([value >>> 24 & 255, value >>> 16 & 255, value >>> 8 & 255, value & 255]),
    im: () => { throw Error('Batch acceleration is disabled'); },
    io: () => { throw Error('Batch acceleration is disabled'); },
  };
  const shim = new vm.SyntheticModule(Object.keys(primitives), function () {
    for (const [name, value] of Object.entries(primitives)) this.setExport(name, value);
  }, { context });
  const networks = new vm.SyntheticModule([], function () {}, { context });
  const module = new vm.SourceTextModule(original, { context, identifier: 'original-nicetry-sphincs.js' });
  await module.link(specifier => {
    if (specifier === './password-strength.js') return shim;
    if (specifier === './networks.js') return networks;
    throw Error(`Unexpected signing-module dependency: ${specifier}`);
  });
  await module.evaluate({ timeout: 2000 });
  return module.namespace;
}
