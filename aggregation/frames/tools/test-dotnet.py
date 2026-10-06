"""Compile and run the independent .NET verifier in an offline SDK container."""
import argparse
import json
from pathlib import Path
import subprocess
import time

parser = argparse.ArgumentParser()
parser.add_argument('--work', type=Path, required=True)
parser.add_argument('--image', required=True)
args = parser.parse_args()
root = args.work.resolve(strict=True)
if not args.image.startswith('sha256:'):
    raise SystemExit('Use the immutable, locally available SDK image ID.')
if (root / 'dotnet-result.json').exists():
    raise SystemExit('Result already exists; preserve it and select a new run directory.')
for item in ['build/prover/target/release/libdaisugi_frame_aggregation.so', 'results/parent-four.bin', 'independent-expected.json']:
    if not (root / item).is_file():
        raise SystemExit(f'Missing test input: {item}')
script = '''set -eu
dotnet build /study/aggregation-frames/dotnet/FrameAggregationProbe.csproj -c Release --configfile /study/aggregation-frames/dotnet/NuGet.Config -o /study/dotnet-output -p:BaseIntermediateOutputPath=/study/dotnet-obj/
dotnet /study/dotnet-output/FrameAggregationProbe.dll /study/build/prover/target/release/libdaisugi_frame_aggregation.so /study/results/parent-four.bin /study/independent-expected.json
'''
command = ['sudo', '-n', 'docker', 'run', '--rm', '--network', 'none', '--cpus', '2', '--memory', '4g', '--pids-limit', '512',
           '--ulimit', 'core=0', '-e', 'DOTNET_PROCESSOR_COUNT=2', '-e', 'LEANVM_NUM_THREADS=2', '-e', 'RAYON_NUM_THREADS=2',
           '-e', 'DOTNET_CLI_TELEMETRY_OPTOUT=1', '-v', str(root) + ':/study', '--entrypoint', 'sh', args.image, '-c', script]
started = time.monotonic()
process = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=240)
(root / 'dotnet.log').write_text(process.stdout)
report = {'exitCode': process.returncode, 'seconds': time.monotonic() - started, 'image': args.image}
if process.returncode == 0:
    report['result'] = json.loads(process.stdout.strip().splitlines()[-1])
(root / 'dotnet-result.json').write_text(json.dumps(report, indent=2) + '\n')
print(process.stdout[-3500:])
print(json.dumps(report), flush=True)
raise SystemExit(process.returncode)
