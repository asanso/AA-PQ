"""Apply the reviewed adaptive overlay to a private client checkout. Never activates a node."""
import argparse, hashlib, json
from pathlib import Path

def apply(source, package, check_only=False):
    source = source.resolve()
    package = package.resolve()
    if not source.is_dir(): raise ValueError('Source must be an existing private checkout')
    manifest = json.loads((package / 'manifest.json').read_text())
    pending = []
    for name, record in manifest['files'].items():
        target = (source / name).resolve()
        payload = (package / 'files' / name).resolve()
        if target == source or not target.is_relative_to(source): raise ValueError('Path outside source')
        if not payload.is_relative_to(package / 'files'): raise ValueError('Path outside overlay')
        content = payload.read_bytes()
        if hashlib.sha256(content).hexdigest() != record['after']: raise ValueError('Overlay integrity failure: ' + name)
        current = hashlib.sha256(target.read_bytes()).hexdigest() if target.is_file() else None
        if current not in (record['before'], record['after']): raise ValueError('Unexpected source, no files written: ' + name)
        if current != record['after']: pending.append((target, content))
    if not check_only:
        for target, content in pending:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
    return len(pending)

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('--component', choices=['client', 'leanvm'], default='client')
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    package = Path(__file__).resolve().parent / ('overlay' if args.component == 'client' else 'native/leanvm-overlay')
    print(json.dumps({'files': apply(args.source, package, args.check), 'checkOnly': args.check, 'activated': False}))
