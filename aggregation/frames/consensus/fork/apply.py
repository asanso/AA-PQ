"""Apply a pinned client overlay to a private source snapshot after validating all inputs."""
import argparse
import hashlib
import json
from pathlib import Path


def sha256(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def checked_path(root: Path, name: str) -> Path:
    path = (root / name).resolve()
    if not path.is_relative_to(root.resolve()) or path == root.resolve():
        raise ValueError(f"Path escapes the source directory: {name}")
    return path


def apply(target: Path, package: Path, check_only: bool = False) -> int:
    target = target.resolve()
    package = package.resolve()
    if not target.is_dir():
        raise ValueError("Target must be an existing private upstream source snapshot")
    manifest = json.loads((package / "manifest.json").read_text(encoding="utf-8"))
    for name, expected in manifest["anchors"].items():
        if sha256(checked_path(target, name).read_bytes()) != expected:
            raise ValueError(f"Pinned upstream anchor differs: {name}")
    writes = {}
    for name, record in manifest["files"].items():
        path = checked_path(target, name)
        content = checked_path(package / "files", name).read_bytes()
        if sha256(content) != record["after"]:
            raise ValueError(f"Overlay content differs from its manifest: {name}")
        current = sha256(path.read_bytes()) if path.is_file() else None
        if current not in (record["before"], record["after"]):
            raise ValueError(f"Conflicting source edit; no files written: {name}")
        if current != record["after"]:
            writes[path] = content
    if not check_only:
        for path, content in writes.items():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
    return len(writes)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("component", choices=("lighthouse", "nethermind"))
    parser.add_argument("target", type=Path)
    parser.add_argument("--check", action="store_true", help="Validate without writing")
    arguments = parser.parse_args()
    package = Path(__file__).resolve().parent / "overlays" / arguments.component
    count = apply(arguments.target, package, arguments.check)
    print(json.dumps({"component": arguments.component, "files": count,
                      "checkOnly": arguments.check, "activated": False}))
