"""Prepare private native tests without changing client runtime configuration."""
import argparse
import importlib.util
from pathlib import Path


def prepare(base: Path, output: Path) -> int:
    root = Path(__file__).resolve().parent
    parent = root.parent
    spec = importlib.util.spec_from_file_location("component_native", parent / "prepare-native.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    content = module.assemble(base, parent.parent)
    anchor = "public class DaisugiPragueTransportTests"
    if content.count(anchor) != 1:
        raise ValueError("Unexpected base test class")
    content = content.replace(anchor, "public partial class DaisugiPragueTransportTests")
    files = {"DaisugiPragueTransportTests.cs": content.encode("utf-8")}
    files.update({p.name: p.read_bytes() for p in (root / "tests").glob("*.cs")})
    if len(files) != 5:
        raise ValueError("Expected the complete reviewed native test set")
    for name, data in files.items():
        path = output / name
        if path.exists() and path.read_bytes() != data:
            raise ValueError(f"Conflicting test source; no files written: {name}")
    output.mkdir(parents=True, exist_ok=True)
    for name, data in files.items():
        (output / name).write_bytes(data)
    return len(files)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("base", type=Path, help="Pinned unmodified NativeBlockProductionTests.cs")
    parser.add_argument("output", type=Path, help="Private Nethermind test project directory")
    args = parser.parse_args()
    print(f"Prepared {prepare(args.base, args.output)} private test sources. No runtime activation.")
