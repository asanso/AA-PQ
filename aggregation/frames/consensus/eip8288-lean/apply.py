"""Build a patched client source tree from its pinned upstream archive and patch series, verifying every input.

The archive, each patch and the final source tree are checked against sources.lock.json. Patches are applied
with `git apply` in a staging directory next to the output; the output appears only after every check passes,
and an output that already holds the expected tree is left as it is.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import subprocess
import tarfile
import tempfile

PACKAGE = Path(__file__).resolve().parent


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def tree_hash(root: Path) -> str:
    """The Git tree id of a directory without `.git`: blob contents, the executable bit and symlinks, as `git write-tree`."""
    entries = []
    for entry in os.scandir(root):
        name = os.fsencode(entry.name)
        if name == b".git":
            raise ValueError(f"Unexpected .git in the source tree: {entry.path}")
        mode = entry.stat(follow_symlinks=False).st_mode
        if stat.S_ISLNK(mode):
            entries.append((name, b"120000", git_object(b"blob", os.fsencode(os.readlink(entry.path)))))
        elif stat.S_ISDIR(mode):
            subtree = tree_hash(Path(entry.path))
            # Git records no empty directories.
            if subtree != EMPTY_TREE:
                entries.append((name + b"/", b"40000", bytes.fromhex(subtree)))
        elif stat.S_ISREG(mode):
            blob = git_object(b"blob", Path(entry.path).read_bytes())
            entries.append((name, b"100755" if mode & stat.S_IXUSR else b"100644", blob))
        else:
            raise ValueError(f"Unsupported file type in the source tree: {entry.path}")
    # Git orders tree entries by name, with a directory compared as if its name ended in "/".
    entries.sort(key=lambda item: item[0])
    content = b"".join(mode + b" " + name.rstrip(b"/") + b"\0" + object_id for name, mode, object_id in entries)
    return git_object(b"tree", content).hex()


def git_object(kind: bytes, content: bytes) -> bytes:
    return hashlib.sha1(kind + b" " + str(len(content)).encode() + b"\0" + content).digest()


EMPTY_TREE = git_object(b"tree", b"").hex()


def safe_relative(name: str, source: str) -> None:
    path = PurePosixPath(name)
    if not name or path.is_absolute() or ".." in path.parts or path.parts[0] == ".git" or "\\" in name:
        raise ValueError(f"Unsafe path {name!r} in {source}")


def load_series(component: dict, patches: Path) -> list[Path]:
    series = component["patchSeries"]
    files = []
    for record in series["patches"]:
        name = record["file"]
        if "/" in name or "\\" in name or not name.endswith(".patch"):
            raise ValueError(f"Patch names must be plain .patch file names: {name!r}")
        path = patches / name
        if not path.is_file() or sha256(path) != record["sha256"]:
            raise ValueError(f"Patch differs from sources.lock.json: {name}")
        files.append(path)
    unlisted = {p.name for p in patches.glob("*.patch")} - {p.name for p in files}
    if unlisted:
        raise ValueError(f"Patches not listed in sources.lock.json: {sorted(unlisted)}")
    return files


def extract(archive: Path, destination: Path, top: str) -> Path:
    with tarfile.open(archive, "r:gz") as tar:
        members = tar.getmembers()
        for member in members:
            safe_relative(member.name.rstrip("/"), archive.name)
            if PurePosixPath(member.name).parts[0] != top:
                raise ValueError(f"Archive member outside {top}/: {member.name}")
        # The data filter also refuses links that leave the destination and special files.
        tar.extractall(destination, members=members, filter="data")
    return destination / top


def git_apply(source: Path, patch: Path, ceiling: Path) -> None:
    # Without a ceiling, Git run inside another repository would apply paths relative to that repository and
    # silently skip the rest; the ceiling keeps it in plain patch mode in the staging directory.
    # User and system configuration (core.autocrlf, core.symlinks) would change what Git writes.
    environment = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    environment.update(GIT_CEILING_DIRECTORIES=str(ceiling), GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull)
    # git apply is all-or-nothing per patch and refuses paths outside the tree, under .git or through a symlink.
    result = subprocess.run(["git", "apply", "--whitespace=nowarn", str(patch)], cwd=source, env=environment,
                            capture_output=True, text=True)
    if result.returncode:
        raise ValueError(f"{patch.name} does not apply: {result.stderr.strip()}")


def prepare(name: str, archive: Path, output: Path, check_only: bool = False,
            lock_path: Path = PACKAGE / "sources.lock.json", patches_root: Path = PACKAGE / "patches") -> str:
    component = json.loads(lock_path.read_text(encoding="utf-8"))[name]
    series = component["patchSeries"]
    if sha256(archive) != component["archiveSha256"]:
        raise ValueError("Source archive differs from sources.lock.json")
    patches = load_series(component, patches_root / name)
    output = output.absolute()
    if output.exists() or output.is_symlink():
        if output.is_dir() and not output.is_symlink() and tree_hash(output) == series["patchedTree"]:
            return "already-patched"
        raise ValueError(f"{output} exists and is not the expected patched tree; it was left unchanged")
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{output.name}.staging-", dir=output.parent))
    try:
        source = extract(archive, staging, f"{name}-{component['revision']}")
        if tree_hash(source) != series["pristineTree"]:
            raise ValueError("Extracted archive is not the pinned upstream tree")
        for patch in patches:
            git_apply(source, patch, staging)
        if tree_hash(source) != series["patchedTree"]:
            raise ValueError("Patched tree differs from sources.lock.json")
        if check_only:
            return "checked"
        source.rename(output)
        return "patched"
    finally:
        shutil.rmtree(staging, ignore_errors=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("component", choices=("lighthouse",))
    parser.add_argument("archive", type=Path, help="The upstream source archive pinned in sources.lock.json")
    parser.add_argument("output", type=Path, help="The patched source directory to create")
    parser.add_argument("--check", action="store_true", help="Verify everything without creating the output")
    arguments = parser.parse_args()
    status = prepare(arguments.component, arguments.archive, arguments.output, arguments.check)
    print(json.dumps({"component": arguments.component, "status": status, "activated": False}))
