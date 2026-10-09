"""Build the adapter offline against an existing, pinned leanVM source tree."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import resource
import shutil
import subprocess
import time

parser = argparse.ArgumentParser()
parser.add_argument('--source', type=Path, required=True)
parser.add_argument('--work', type=Path, required=True)
parser.add_argument('--upstream', type=Path, required=True)
parser.add_argument('--manifest', type=Path, required=True)
parser.add_argument('--tool-root', type=Path, required=True)
parser.add_argument('--seed-target', type=Path)
args = parser.parse_args()
args.source = args.source.resolve(strict=True)
args.upstream = args.upstream.resolve(strict=True)
args.work = args.work.resolve()
if args.work.exists():
    raise SystemExit('Build directory already exists; use a new directory to preserve evidence.')

manifest = json.loads(args.manifest.read_text())
for item in manifest:
    candidate = (args.upstream / item['Path']).resolve(strict=True)
    if not candidate.is_relative_to(args.upstream):
        raise SystemExit('Manifest path escapes the pinned source tree.')
    if hashlib.sha256(candidate.read_bytes()).hexdigest() != item['Sha256']:
        raise SystemExit(f'Pinned source mismatch: {item["Path"]}')

args.work.mkdir(parents=True)
shutil.copytree(args.source / 'prover', args.work / 'prover', ignore=shutil.ignore_patterns('target'))
(args.work / 'leanvm').symlink_to(args.upstream, target_is_directory=True)
if args.seed_target:
    # Ordinary copies preserve the prior cache, binaries and build metadata.
    shutil.copytree(args.seed_target, args.work / 'prover/target', symlinks=True)

env = {**os.environ, 'PATH': str(args.tool_root / 'cargo/bin') + ':' + os.environ['PATH'],
       'CARGO_HOME': str(args.tool_root / 'cargo'), 'RUSTUP_HOME': str(args.tool_root / 'rustup'),
       'CARGO_BUILD_JOBS': '1', 'LEANVM_NUM_THREADS': '2', 'RAYON_NUM_THREADS': '2',
       'RUSTFLAGS': '-C target-cpu=haswell'}
os.nice(15)
os.sched_setaffinity(0, set(sorted(os.sched_getaffinity(0))[:2]))
resource.setrlimit(resource.RLIMIT_AS, (16 * 1024**3, 16 * 1024**3))
started = time.monotonic()
with (args.work / 'build.log').open('w') as log:
    result = subprocess.run([str(args.tool_root / 'cargo/bin/cargo'), 'build', '--release', '--locked', '--offline'],
                            cwd=args.work / 'prover', env=env, stdout=log, stderr=subprocess.STDOUT, timeout=1200)
report = {'exitCode': result.returncode, 'seconds': time.monotonic() - started,
          'pinnedSourceFilesChecked': len(manifest), 'cpuWorkers': 2, 'addressSpaceLimitGiB': 16}
(args.work / 'build-result.json').write_text(json.dumps(report, indent=2) + '\n')
print((args.work / 'build.log').read_text()[-5500:])
print(json.dumps(report), flush=True)
raise SystemExit(result.returncode)
