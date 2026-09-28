"""Run native account tests in the pinned, disposable Nethermind SDK image."""
import json
import subprocess
import tempfile
from pathlib import Path

root = Path(__file__).resolve().parents[1]
image = 'sha256:e0ff25f71951ea1c42f278b1b5ca65aec6d6fa17d8ddf338e98e57a4f9142dad'
fixture = root / 'tests/fixtures/native-frame.json'
data = json.loads(fixture.read_text())
assert data['verifierCodeHash'] == '0x7ab53ba1ae0d906f2d144cb673fb481e04d58b22ec72a8a0ec37cc66079f3417'
actual = subprocess.check_output(['docker', 'image', 'inspect', 'aa-pq-nethermind:verify500k-build',
                                  '--format', '{{.Id}}'], text=True).strip()
assert actual == image, 'Pinned Nethermind SDK image mismatch'
# Restore/build may download the pinned test dependencies. Test execution below
# runs separately without network access, RPC targets or shared state.
with tempfile.TemporaryDirectory(prefix='daisugi-native-tests-') as temporary:
    identity = Path(temporary)/'image-id'
    subprocess.run(['docker', 'build', '--pull=false', '--progress=plain', '--iidfile', str(identity),
                    '-f', str(root/'scripts/NativeTests.Dockerfile'), str(root/'tests')], check=True)
    test_image = identity.read_text().strip()
# No host network, RPC endpoint, chain database, keys or Docker socket is mounted.
command = ['docker', 'run', '--rm', '--network', 'none', '--cpus', '2', '--memory', '8g',
           '--pids-limit', '2048', '-e', 'DOTNET_PROCESSOR_COUNT=2',
           '-e', 'DAISUGI_FRAME_FIXTURE=/native-frame.json',
           '-v', str(fixture) + ':/native-frame.json:ro',
           test_image]
raise SystemExit(subprocess.run(command, check=False).returncode)
