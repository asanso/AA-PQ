"""Copy only public genesis code and an encoded block into a fresh receiver workspace."""
import argparse
import json
from pathlib import Path
import shutil

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--source", type=Path, required=True)
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()
fixtures = json.loads((args.source / "fixtures/authorization.json").read_text(encoding="utf-8"))
public_state = {"fixtures": [{"runtime": item["runtime"],
    "transaction": {"sender": item["transaction"]["sender"]}} for item in fixtures["fixtures"]]}
block = args.source / "accepted-block.rlp"
if not block.is_file() or len(public_state["fixtures"]) != 2:
    raise SystemExit("A successful two-account producer run is required")
args.output.mkdir(parents=True, exist_ok=False)
(args.output / "fixtures").mkdir()
(args.output / "fixtures/authorization.json").write_text(
    json.dumps(public_state, indent=2) + "\n", encoding="utf-8")
shutil.copyfile(block, args.output / "accepted-block.rlp")
print("Prepared a receiver workspace without raw signature witnesses or signing keys")
