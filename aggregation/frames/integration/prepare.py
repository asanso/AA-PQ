"""Prepare pinned upstream sources for offline development checks on Linux."""
import argparse
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import shutil
import tarfile
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument('--workspace', type=Path, required=True)
args = parser.parse_args()
source = Path(__file__).resolve().parent
root = args.workspace.resolve()
lock = json.loads((source / 'sources.lock.json').read_text())
if root.exists():
    raise SystemExit('Use a new private workspace; existing directories are preserved.')
root.mkdir(parents=True)
records = []
for name, specification in [('nethermind', lock['nethermind']),
                            ('leanvm-block-deps', lock['oneHopReference'])]:
    repository, revision = specification['repository'], specification['revision']
    request = urllib.request.Request(
        f'https://codeload.github.com/{repository}/tar.gz/{revision}',
        headers={'User-Agent': 'Daisugi-development-checks'})
    with urllib.request.urlopen(request, timeout=120) as response:
        archive = response.read(160 * 1024**2 + 1)
    digest = hashlib.sha256(archive).hexdigest()
    if len(archive) > 160 * 1024**2 or digest != specification['archiveSha256']:
        raise SystemExit(f'{name}: source archive size or SHA-256 mismatch')
    destination = root / 'upstream' / name
    with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as package:
        entries = package.getmembers()
        if sum(entry.size for entry in entries) > 768 * 1024**2:
            raise SystemExit('Source archive exceeds the extraction limit')
        for entry in entries:
            parts = PurePosixPath(entry.name).parts
            if len(parts) < 2 or not entry.isfile():
                continue
            target = (destination / Path(*parts[1:])).resolve()
            if not target.is_relative_to(destination.resolve()):
                raise SystemExit('Source archive contains an unsafe path')
            target.parent.mkdir(parents=True, exist_ok=True)
            with package.extractfile(entry) as content:
                target.write_bytes(content.read())
    records.append({'name': name, 'revision': revision, 'archiveSha256': digest})

build = root / 'build'
build.mkdir()
shutil.copytree(source / 'one-hop', build / 'one-hop',
                ignore=shutil.ignore_patterns('target'))
(build / 'leanvm').symlink_to(root / 'upstream/leanvm-block-deps', target_is_directory=True)
test = root / 'upstream/nethermind/src/Nethermind/Nethermind.Crypto.LeanFfi.Test/NativeBlockValidationTests.cs'
original = test.read_text()
anchor = '    private static (Block Block, BlockHeader Parent) BlockWithNativeProof(bool tamper)'
if original.count(anchor) != 1 or 'Daisugi_wallet_claims' in original:
    raise SystemExit('The pinned upstream test fixture does not match the expected insertion point')
(root / 'NativeBlockValidationTests.original.cs').write_text(original)
test.write_text(original.replace(anchor, (source / 'DaisugiWalletBlockProofChecks.cs.fragment').read_text() + anchor))
(root / 'source-snapshots.json').write_text(json.dumps(records, indent=2) + '\n')
print(json.dumps({'workspace': str(root), 'sources': records}))
