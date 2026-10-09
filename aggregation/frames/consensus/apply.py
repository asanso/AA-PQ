"""Add inactive transport modules to an exact private Lighthouse source snapshot."""
import hashlib
from pathlib import Path
import argparse

EXPORTS = {
    "consensus/types/src/execution/mod.rs": (
        "mod aggregate_payload;\npub use aggregate_payload::*;\n",
        "7ea991b174f13d9e805ee7a0c7a836d1e5c74feb09a18a9e80039e8c6b8d51b9"),
    "beacon_node/execution_layer/src/engine_api.rs": (
        "pub mod aggregate_json;\n",
        "640fd86cff588ccb8cd3b2ea6e2507952b8f967ed77da7a89fafab8dd8d4c285"),
    "beacon_node/execution_layer/src/lib.rs": (
        "pub mod aggregate_block_hash;\n",
        "80f98825c8751f0096be90ad7bc53e4128f3a747fea783dc781d16bd8fe5919e"),
}
MODULES = {
    "aggregate_payload.rs": "consensus/types/src/execution/aggregate_payload.rs",
    "aggregate_json.rs": "beacon_node/execution_layer/src/engine_api/aggregate_json.rs",
    "aggregate_block_hash.rs": "beacon_node/execution_layer/src/aggregate_block_hash.rs",
}


def apply(upstream: Path) -> None:
    """Validate every input before writing; never overwrite unrelated source edits."""
    source = Path(__file__).resolve().parent
    writes = {}
    for relative, (addition, expected) in EXPORTS.items():
        path = upstream / relative
        existing = path.read_bytes()
        suffix = ("\n" + addition).encode()
        original = existing[:-len(suffix)] if existing.endswith(suffix) else existing
        if hashlib.sha256(original).hexdigest() != expected:
            raise ValueError(f"Unexpected upstream source: {relative}")
        writes[path] = original + suffix
    for name, relative in MODULES.items():
        path = upstream / relative
        replacement = (source / name).read_bytes()
        if path.exists() and path.read_bytes() != replacement:
            raise ValueError(f"Existing module differs; review it before updating: {relative}")
        writes[path] = replacement
    for path, content in writes.items():
        if not path.exists() or path.read_bytes() != content:
            path.write_bytes(content)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("upstream", type=Path, help="Private source snapshot at the documented Lighthouse revision")
    args = parser.parse_args()
    apply(args.upstream.resolve())
    print("Added inactive transport modules; fork schedule and live Engine selection are unchanged.")
