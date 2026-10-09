"""Exercise real leaf proofs, recursive composition and independent verification.

Input fixtures are public signatures from the earlier wallet test. This runner
does not sign, fund, submit transactions or create a chain.
"""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import resource
import subprocess
import time

parser = argparse.ArgumentParser()
parser.add_argument('--binary', type=Path, required=True)
parser.add_argument('--fixtures', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
args.binary = args.binary.resolve(strict=True)
args.fixtures = args.fixtures.resolve(strict=True)
args.output = args.output.resolve()
args.output.mkdir(parents=True, exist_ok=False)
os.nice(15)
os.sched_setaffinity(0, set(sorted(os.sched_getaffinity(0))[:2]))
resource.setrlimit(resource.RLIMIT_AS, (16 * 1024**3, 16 * 1024**3))
env = {**os.environ, 'LEANVM_NUM_THREADS': '2', 'RAYON_NUM_THREADS': '2'}
scheme = 'daisugi-frame-case7-sphincs-g-v0'
source = json.loads(args.fixtures.read_text())
raw_claims = source['claims'][:4]
claims = [{k: v for k, v in claim.items() if k != 'signature'} for claim in raw_claims]
checks = []

def request(items, **extra):
    return {'schemaVersion': 1, 'scheme': scheme, 'claims': items, **extra}

def mutate(value, index=0):
    raw = bytearray.fromhex(value[2:])
    raw[index] ^= 1
    return '0x' + raw.hex()

def run(name, action, value, error=None):
    source_path = args.output / f'{name}-request.json'
    destination = args.output / f'{name}-output.json'
    source_path.write_text(json.dumps(value))
    started = time.monotonic()
    timed_out = False
    with (args.output / f'{name}.log').open('w') as log:
        process = subprocess.Popen([str(args.binary), action, str(source_path), str(destination)],
                                   env=env, stdout=log, stderr=subprocess.STDOUT)
        peak_rss = 0
        while process.poll() is None:
            try:
                for line in Path(f'/proc/{process.pid}/status').read_text().splitlines():
                    if line.startswith(('VmRSS:', 'VmHWM:')):
                        peak_rss = max(peak_rss, int(line.split()[1]))
            except FileNotFoundError:
                pass
            if time.monotonic() - started > 600:
                timed_out = True
                process.kill()
                process.wait()
                break
            time.sleep(0.04)
    log_text = (args.output / f'{name}.log').read_text()
    # Crashes, resource failures and timeouts are never counted as rejections.
    passed = not timed_out and ((process.returncode == 0 and error is None) or
        (process.returncode == 1 and error is not None and error in log_text))
    record = {'name': name, 'action': action, 'exitCode': process.returncode,
              'expectedError': error, 'passed': passed, 'seconds': time.monotonic() - started,
              'sampledPeakRssKiB': peak_rss}
    result = None
    if process.returncode == 0:
        result = json.loads(destination.read_text())
        record['result'] = {k: v for k, v in result.items() if k != 'proof'}
        if 'proof' in result:
            binary = bytes.fromhex(result['proof'][2:])
            (args.output / f'{name}.bin').write_bytes(binary)
            record['proofSha256'] = hashlib.sha256(binary).hexdigest()
    else:
        record['error'] = log_text[-1800:]
    checks.append(record)
    (args.output / 'progress.json').write_text(json.dumps(checks, indent=2) + '\n')
    print(json.dumps(record), flush=True)
    if not passed:
        raise RuntimeError(f'Unexpected result: {name}')
    return result

run('individual-signatures', 'verify-signatures', request(raw_claims))
leaf_a = run('leaf-a', 'prove', request(raw_claims[:2]))
leaf_b = run('leaf-b', 'prove', request(raw_claims[2:]))
run('peer-leaf-a', 'verify', request(claims[:2], proof=leaf_a['proof']))
run('peer-leaf-b', 'verify', request(claims[2:], proof=leaf_b['proof']))
children = [{'claims': claims[:2], 'proof': leaf_a['proof']}, {'claims': claims[2:], 'proof': leaf_b['proof']}]
parent = run('parent-four', 'compose', request(claims, children=children))
run('peer-parent-four', 'verify', request(claims, proof=parent['proof']))
run('peer-parent-reordered', 'verify', request(list(reversed(claims)), proof=parent['proof']))

# The second level receives only proofs; overlapping claims are deduplicated and
# claims 1 and 3 are deliberately pruned from the proven statement.
selected = [claims[0], claims[2]]
grandchildren = [{'claims': claims, 'proof': parent['proof']}, children[0]]
pruned = run('recursive-overlap-pruned', 'compose', request(selected, children=grandchildren))
run('peer-recursive-pruned', 'verify', request(selected, proof=pruned['proof']))
run('pruned-is-not-full', 'verify', request(claims, proof=pruned['proof']), 'Proof claims do not match')
run('full-is-not-pruned', 'verify', request(selected, proof=parent['proof']), 'Proof claims do not match')

for key in ['message', 'pkSeed', 'pkRoot']:
    changed = copy.deepcopy(claims)
    changed[0][key] = mutate(changed[0][key])
    run(f'changed-{key}', 'verify', request(changed, proof=parent['proof']), 'Proof claims do not match')
run('missing-claim', 'verify', request(claims[:-1], proof=parent['proof']), 'Proof claims do not match')
run('duplicate-claim', 'verify', request(claims + [claims[0]], proof=parent['proof']), 'Duplicate key/message')
for name, proof, error in [
    ('corrupted-proof', mutate(parent['proof'], -1), 'Proof verification failed'),
    ('truncated-proof', parent['proof'][:-32], 'Malformed proof'),
    ('trailing-proof', parent['proof'] + '00', 'Malformed proof'),
    ('empty-proof', '0x', 'Proof size is outside'),
]:
    run(name, 'verify', request(claims, proof=proof), error)
wrong_child = copy.deepcopy(children)
wrong_child[0]['claims'][0]['message'] = mutate(wrong_child[0]['claims'][0]['message'])
run('false-child-claims', 'compose', request(claims, children=wrong_child), 'Proof claims do not match')
corrupt_child = copy.deepcopy(children)
corrupt_child[0]['proof'] = mutate(corrupt_child[0]['proof'], -1)
run('corrupted-child', 'compose', request(claims, children=corrupt_child), 'Proof verification failed')
missing_child = [children[0]]
run('uncovered-selection', 'compose', request(claims, children=missing_child), 'Selected claims are not covered')
run('no-children', 'compose', request(claims), 'Composition requires')
run('too-many-children', 'compose', request(claims, children=children * 3), 'Composition requires')
run('raw-signatures-in-composition', 'compose', request(raw_claims, children=children), 'does not accept raw signatures')
invalid = copy.deepcopy(raw_claims)
invalid[0]['signature'] = mutate(invalid[0]['signature'])
run('invalid-signature', 'prove', request(invalid), 'Invalid individual signature')
run('wrong-profile', 'verify', {**request(claims, proof=parent['proof']), 'scheme': 'unsupported'}, 'Unsupported request version')
report = {'checksPassed': len(checks), 'checks': checks,
          'fixtureSha256': hashlib.sha256(args.fixtures.read_bytes()).hexdigest(),
          'binarySha256': hashlib.sha256(args.binary.read_bytes()).hexdigest(),
          'cpuWorkers': 2, 'addressSpaceLimitGiB': 16,
          'scope': 'Real SPHINCS-G recursive proof composition and cold-process verification only; no dependency frames, mempool networking, client integration or live transactions.'}
(args.output / 'result.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'checksPassed': len(checks), 'result': str(args.output / 'result.json')}), flush=True)
