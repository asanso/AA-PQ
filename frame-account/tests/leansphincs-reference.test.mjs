import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { getBytes, keccak256 } from 'ethers';
import { createLeanSphincs, parseVector, SIGNATURE_LEN } from './leansphincs-reference.mjs';

const vectors = new URL('fixtures/leansphincs-ethlib/', import.meta.url);
const sums = readFileSync(new URL('SHA256SUMS', vectors), 'utf8').split('\n').filter(line => line && !line.startsWith('#'))
  .map(line => { const [hash, path] = line.split(/\s+/); return { hash, path: path.replace(/^\.\//, '') }; });
const verify = createLeanSphincs(bytes => getBytes(keccak256(bytes)));

test('the vendored EthLib vectors match their SHA256SUMS', () => {
  assert.equal(readFileSync(new URL('COMMIT', vectors), 'utf8').trim(), 'a2a9e655f965dbadf33b3acfbc645696078fc75d');
  assert.ok(sums.length >= 30);
  for (const { hash, path } of sums)
    assert.equal(createHash('sha256').update(readFileSync(new URL(path, vectors))).digest('hex'), hash, path);
});

test('the reference verifier gives every EthLib verify output', () => {
  const cases = sums.filter(({ path }) => path.startsWith('verify/'));
  assert.equal(cases.length, 26);
  for (const { path } of cases) {
    const { input, output } = parseVector(readFileSync(new URL(path, vectors), 'utf8'));
    assert.equal(verify(getBytes(input.public_key), getBytes(input.message), getBytes(input.signature)), output, path);
  }
});

test('the reference verifier accepts the EthLib sign outputs under the key_gen public keys', () => {
  const read = path => parseVector(readFileSync(new URL(path, vectors), 'utf8'));
  for (const name of ['known_answer', 'zero_seed']) {
    const sign = read(`sign/sign_${name}/data.yaml`), key = read(`key_gen/key_gen_${name}/data.yaml`);
    assert.equal(sign.input.seed, key.input.seed);
    assert.equal(getBytes(sign.output).length, SIGNATURE_LEN);
    assert.equal(verify(getBytes(key.output), getBytes(sign.input.message), getBytes(sign.output)), true, name);
  }
});
