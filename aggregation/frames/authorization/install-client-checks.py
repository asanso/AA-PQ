"""Install the account checks into a disposable, pinned Nethermind source tree."""
import argparse
import hashlib
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--nethermind", type=Path, required=True)
args = parser.parse_args()
target = args.nethermind / "src/Nethermind/Nethermind.Crypto.LeanFfi.Test/NativeBlockProductionTests.cs"
expected = "d64211c3418ce1d1b8e8defb545a345118c417d9ec2ca86dfcc06cb75bf4fd12"
if hashlib.sha256(target.read_bytes()).hexdigest() != expected:
    raise SystemExit("Refusing to overwrite a modified or unrecognized upstream test file")
source = target.read_text(encoding="utf-8")
anchor = "    private sealed class CountingNativeVerifier : ILeanProofVerifier"
if source.count(anchor) != 1 or source.count("using Autofac;") != 1:
    raise SystemExit("The pinned test-file structure does not match")
fragment = Path(__file__).with_name("NativeAuthorizationChecks.cs.fragment").read_text(encoding="utf-8")
source = source.replace("using Autofac;", "using Autofac;\nusing Nethermind.Evm;\nusing Nethermind.Evm.State;")
source = source.replace(anchor, fragment + anchor)
target.write_text(source, encoding="utf-8", newline="\n")
print("Installed authorization tests; production client source is unchanged")
