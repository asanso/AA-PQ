"""Check the pinned one-hop proof against independently derived wallet claims."""
import argparse
import copy
import hashlib
import json
from pathlib import Path
import subprocess
import time

parser = argparse.ArgumentParser()
parser.add_argument('--binary', type=Path, required=True)
parser.add_argument('--fixtures', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
args.output.mkdir()
source = json.loads((args.fixtures/'wallet-input.json').read_text())
expected = json.loads((args.fixtures/'expected.json').read_text())
records = []
proof = args.output/'one-hop.bin'

def run(name, action, request, proof_file=proof, accepted=True):
    input_file = args.output/(name+'.json')
    input_file.write_text(json.dumps(request)+'\n')
    started = time.monotonic()
    result = subprocess.run([str(args.binary), action, str(input_file), str(proof_file)],
        capture_output=True, text=True, timeout=180)
    (args.output/(name+'.log')).write_text(result.stdout+result.stderr)
    if accepted:
        assert result.returncode == 0, f'{name}: {result.stderr[-600:]}'
        parsed = json.loads(result.stdout.strip().splitlines()[-1])
        assert parsed['accepted'] is True
    else:
        assert result.returncode == 1 and 'Rejected:' in result.stderr, f'{name}: unexpected failure or acceptance'
        parsed = None
    records.append({'name': name, 'accepted': accepted, 'seconds': time.monotonic()-started, 'result': parsed})
    (args.output/'results.json').write_text(json.dumps(records, indent=2)+'\n')
    print(json.dumps(records[-1]), flush=True)
    return parsed

assert run('independent-commitment', 'hash', source)['blockDepsHash'] == expected['oneHopHash']
run('original-wallet-signatures', 'signatures', source)
run('real-one-hop-proof', 'prove', source)
public = copy.deepcopy(source)
for claim in public['claims']:
    del claim['signature']
run('independent-proof-verification', 'verify', public)
for field in ['message', 'publicKey']:
    changed = copy.deepcopy(public)
    value = bytearray.fromhex(changed['claims'][0][field][2:])
    value[0] ^= 1
    changed['claims'][0][field] = '0x'+value.hex()
    run('changed-'+field, 'verify', changed, accepted=False)
missing = copy.deepcopy(public)
missing['claims'].pop()
run('missing-claim', 'verify', missing, accepted=False)
reversed_claims = copy.deepcopy(public)
reversed_claims['claims'].reverse()
run('reordered-claims', 'verify', reversed_claims)
duplicated = copy.deepcopy(public)
duplicated['claims'].append(copy.deepcopy(duplicated['claims'][0]))
run('duplicate-declaration', 'verify', duplicated)
raw = proof.read_bytes()
for name, modified in [('corrupt', raw[:-1]+bytes([raw[-1]^1])), ('truncated', raw[:-1]), ('trailing', raw+b'\x00'), ('empty', b'')]:
    candidate = args.output/(name+'.bin')
    candidate.write_bytes(modified)
    run(name+'-proof', 'verify', public, candidate, accepted=False)
bad_signature = copy.deepcopy(source)
value = bytearray.fromhex(bad_signature['claims'][0]['signature'][2:])
value[100] ^= 1
bad_signature['claims'][0]['signature'] = '0x'+value.hex()
run('bad-wallet-signature', 'signatures', bad_signature, accepted=False)
(args.output/'summary.json').write_text(json.dumps({'checksPassed': len(records), 'proofBytes':len(raw),
    'proofSha256':hashlib.sha256(raw).hexdigest(), 'blockDepsHash':expected['oneHopHash']}, indent=2)+'\n')
