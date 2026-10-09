"""Exercise the unmodified native ABI with retained NiceTry SPHINCS-G signatures."""
import argparse
import ctypes as c
import hashlib
import json
from pathlib import Path
import struct
import time

parser = argparse.ArgumentParser()
parser.add_argument('--library', type=Path, required=True)
parser.add_argument('--fixtures', type=Path, required=True)
parser.add_argument('--one-hop-proof', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
args.output.mkdir()
source = json.loads((args.fixtures/'wallet-input.json').read_text())
expected = json.loads((args.fixtures/'expected.json').read_text())
lib = c.CDLL(str(args.library))
ptr, size, integer = c.c_void_p, c.c_size_t, c.c_int
lib.nlean_abi_version.restype = c.c_uint32
lib.nlean_aggregated_vk.argtypes = [ptr]
lib.nlean_aggregated_vk.restype = integer
lib.nlean_verify_leansphincs.argtypes = [ptr, ptr, ptr, size]
lib.nlean_verify_leansphincs.restype = integer
lib.nlean_verify_recursive.argtypes = [ptr, ptr, size, ptr, size]
lib.nlean_verify_recursive.restype = integer
lib.nlean_prove_recursive.argtypes = [ptr, ptr, size, ptr, size, c.POINTER(ptr), c.POINTER(size)]
lib.nlean_prove_recursive.restype = integer
lib.nlean_free.argtypes = [ptr, size]
lib.nlean_free.restype = None
decode = lambda value: bytes.fromhex(value.removeprefix('0x'))
records = []
key = c.create_string_buffer(32)

def check(name, actual, required):
    assert actual == required, f'{name}: expected {required}, received {actual}'
    records.append({'name':name, 'result':actual})
    (args.output/'checks.json').write_text(json.dumps(records, indent=2)+'\n')
    print(json.dumps(records[-1]), flush=True)

check('native-abi', lib.nlean_abi_version(), 5)
check('guest-key-read', lib.nlean_aggregated_vk(key), 1)
check('pinned-guest-key', key.raw.hex(), '9370d760abb55fdf02acc7e8d40688c425815c3d25a2aea3c030b2ae1ab51ace')
direct = []
for index, (claim, dependency) in enumerate(zip(source['claims'], expected['dependencies'])):
    message, public_key = decode(claim['message']), decode(dependency['publicKeyHash'])
    witness = decode(claim['publicKey'])+decode(claim['signature'])
    check(f'wallet-signature-{index}', lib.nlean_verify_leansphincs(message, public_key, witness, len(witness)), 1)
    check(f'changed-message-{index}', lib.nlean_verify_leansphincs(bytes(32), public_key, witness, len(witness)), 0)
    check(f'changed-key-{index}', lib.nlean_verify_leansphincs(message, bytes(32), witness, len(witness)), 0)
    damaged = bytearray(witness)
    damaged[132] ^= 1
    check(f'changed-signature-{index}', lib.nlean_verify_leansphincs(message, public_key, bytes(damaged), len(damaged)), 0)
    direct.append(decode(dependency['triple'])+struct.pack('<I',len(witness))+witness)
request = struct.pack('<I',len(direct))+b''.join(direct)+bytes(8)
commitment = decode(expected['nethermindHash'])
result_ptr, result_len = ptr(), size()
started = time.monotonic()
accepted = lib.nlean_prove_recursive(commitment, key, 32, request, len(request), c.byref(result_ptr), c.byref(result_len))
prove_ms = (time.monotonic()-started)*1000
check('real-wallet-aggregate', accepted, 1)
assert result_ptr.value and 0 < result_len.value <= 8*1024*1024
try:
    proof = c.string_at(result_ptr, result_len.value)
finally:
    lib.nlean_free(result_ptr, result_len)
(args.output/'nethermind.bin').write_bytes(proof)
(args.output/'guest-key.bin').write_bytes(key.raw)
(args.output/'commitment.bin').write_bytes(commitment)
started = time.monotonic()
check('verify-wallet-aggregate', lib.nlean_verify_recursive(commitment, key, 32, proof, len(proof)), 1)
verify_ms = (time.monotonic()-started)*1000
for name, digest, guest, value in [
    ('changed-block-deps',bytes(32),key.raw,proof),
    ('changed-guest',commitment,bytes(32),proof),
    ('one-hop-hash-mismatch',decode(expected['oneHopHash']),key.raw,proof),
    ('one-hop-proof-mismatch',commitment,key.raw,args.one_hop_proof.read_bytes()),
    ('truncated',commitment,key.raw,proof[:-1]),
    ('trailing',commitment,key.raw,proof+b'\0'),
    ('corrupt',commitment,key.raw,proof[:-1]+bytes([proof[-1]^1])),
    ('empty',commitment,key.raw,b'')]:
    check(name, lib.nlean_verify_recursive(digest,guest,32,value,len(value)),0)
report = {'checksPassed':len(records),'proofBytes':len(proof),'proveMs':prove_ms,'warmVerifyMs':verify_ms,
          'proofSha256':hashlib.sha256(proof).hexdigest(),'librarySha256':hashlib.sha256(args.library.read_bytes()).hexdigest(),
          'scope':'Real upstream native cryptography; not wallet transaction authorization or block execution.'}
(args.output/'summary.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report),flush=True)
