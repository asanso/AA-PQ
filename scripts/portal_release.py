#!/usr/bin/env python3
"""Package committed portal source and install a verified release on Linux."""

import argparse
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import tarfile
import tempfile
import time
import urllib.parse
import urllib.request

SHA = re.compile(r"[0-9a-f]{40}")
DIGEST = re.compile(r"[0-9a-f]{64}")
MAX_BYTES = 32 * 1024 * 1024
MAX_FILES = 2000
REQUIRED = {
    "frontend/server.mjs", "frontend/package.json", "frontend/package-lock.json",
    "frontend/public/index.html", "explorer/server.mjs", "explorer/package.json",
    "explorer/package-lock.json",
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def allowed_path(name):
    parts = PurePosixPath(name).parts
    return (
        bool(parts) and not name.startswith("/") and "\\" not in name
        and all(p not in ("", ".", "..", "node_modules", ".git", ".preview")
                and not p.startswith(".env") for p in parts)
        and str(PurePosixPath(name)) == name
        and (parts[0] in ("frontend", "explorer", "licenses")
             or name == "THIRD_PARTY.md")
        and name != "frontend/public/release.json"
    )


def create_archive(files, revision, tree, output):
    require(SHA.fullmatch(revision) and SHA.fullmatch(tree), "Invalid source identity")
    require(REQUIRED <= files.keys(), "Required runtime files are missing")
    require(all(allowed_path(p) for p in files), "Unexpected runtime path")
    require(len(files) < MAX_FILES and sum(map(len, files.values())) < MAX_BYTES,
            "Release exceeds size limits")
    payload = dict(files)
    public = {"commit": revision, "sourceTree": tree}
    payload["frontend/public/release.json"] = (json.dumps(public, sort_keys=True) + "\n").encode()
    manifest = {
        "format": 1, "commit": revision, "sourceTree": tree,
        "files": {p: digest(data) for p, data in sorted(payload.items())},
    }
    payload["RELEASE.json"] = (json.dumps(manifest, sort_keys=True) + "\n").encode()
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(output, "w:gz") as archive:
        for name, data in sorted(payload.items()):
            info = tarfile.TarInfo(name)
            info.size, info.mode, info.mtime = len(data), 0o644, 0
            archive.addfile(info, io.BytesIO(data))
    return manifest


def package_commit(output):
    def git(*args):
        return subprocess.check_output(["git", *args])
    revision = git("rev-parse", "HEAD").decode().strip()
    tree = git("rev-parse", "HEAD^{tree}").decode().strip()
    entries = git("ls-tree", "-r", "-z", "HEAD", "--",
                  "frontend", "explorer", "licenses", "THIRD_PARTY.md")
    files = {}
    for entry in entries.split(b"\0"):
        if not entry:
            continue
        metadata, name = entry.split(b"\t", 1)
        mode, kind, oid = metadata.decode().split()
        require(mode in ("100644", "100755") and kind == "blob",
                "Symlinks and submodules are not release inputs")
        path = name.decode()
        require(allowed_path(path), "Unexpected committed runtime path: " + path)
        files[path] = git("cat-file", "blob", oid)
    return create_archive(files, revision, tree, output)


def inspect_archive(archive_path, revision, expected_digest):
    require(SHA.fullmatch(revision), "Invalid commit")
    require(DIGEST.fullmatch(expected_digest), "Invalid archive digest")
    archive_path = Path(archive_path)
    require(not archive_path.is_symlink() and archive_path.is_file(), "Invalid archive file")
    require(archive_path.stat().st_size <= MAX_BYTES, "Archive exceeds size limit")
    require(digest(archive_path.read_bytes()) == expected_digest, "Archive checksum mismatch")
    contents = {}
    total = 0
    with tarfile.open(archive_path, "r:gz") as archive:
        for member in archive:
            require(member.isfile() and member.name not in contents,
                    "Release must contain unique regular files")
            require(member.name in ("RELEASE.json", "frontend/public/release.json")
                    or allowed_path(member.name), "Unexpected archive path")
            total += member.size
            require(member.size >= 0 and total <= MAX_BYTES and len(contents) < MAX_FILES,
                    "Expanded release exceeds size limits")
            contents[member.name] = archive.extractfile(member).read()
    manifest = json.loads(contents.pop("RELEASE.json"))
    require(manifest.get("format") == 1 and manifest.get("commit") == revision,
            "Release identity mismatch")
    require(SHA.fullmatch(manifest.get("sourceTree", "")), "Invalid source tree")
    require(REQUIRED <= contents.keys(), "Required runtime files are missing")
    require(manifest.get("files") == {p: digest(data) for p, data in contents.items()},
            "Release manifest does not match its files")
    require(json.loads(contents["frontend/public/release.json"]) ==
            {"commit": revision, "sourceTree": manifest["sourceTree"]},
            "Public release identity mismatch")
    return manifest, contents


def read_config(path, environment):
    path = Path(path)
    require(path.is_file() and not path.is_symlink(), "Deployment configuration is missing")
    require(path.stat().st_uid == os.geteuid() and path.stat().st_mode & 0o077 == 0,
            "Deployment configuration must be owned by this user with mode 0600")
    config = json.loads(path.read_text())
    require(config.get("environment") == environment, "Configuration environment mismatch")
    root = Path(config["root"])
    require(root.is_absolute() and root.is_dir() and not root.is_symlink(),
            "Deployment root must be an existing absolute directory")
    require(root.resolve() == root and root not in (Path("/"), Path.home()),
            "Unsafe deployment root")
    require(root.stat().st_uid == os.geteuid(), "Deployment root must be owned by this user")
    for key in ("node", "npm_cli"):
        require(Path(config[key]).is_absolute() and Path(config[key]).is_file(),
                "Missing configured runtime: " + key)
    units = config["services"]
    require(isinstance(units, list) and units and all(
        re.fullmatch(r"daisugi-[a-z0-9-]+\.service", unit) for unit in units),
        "Expected dedicated Daisugi user services")
    checks = config["health_checks"]
    require(isinstance(checks, list) and checks and
            any(c.get("kind") == "release" for c in checks), "Release health check is required")
    for check in checks:
        url = urllib.parse.urlsplit(check["url"])
        require(url.scheme == "http" and url.hostname == "127.0.0.1"
                and not url.username and not url.password and not url.fragment,
                "Health checks must use loopback HTTP")
        require(check.get("kind") in ("release", "chain", "json"), "Unknown health check kind")
    return config


def set_current(root, target):
    temporary = root / (".current-" + os.urandom(8).hex())
    try:
        temporary.symlink_to(target)
        os.replace(temporary, root / "current")
    finally:
        temporary.unlink(missing_ok=True)


def previous_release(root):
    current = root / "current"
    require(not current.exists() or current.is_symlink(), "Current path must be a symlink")
    if not current.is_symlink():
        return None
    previous = current.resolve(strict=True)
    require(previous.parent == root / "releases" and SHA.fullmatch(previous.name),
            "Current release points outside the release directory")
    return previous


def restart(config):
    subprocess.run(["systemctl", "--user", "restart", *config["services"]],
                   check=True, timeout=90)


def health(config, revision):
    last_error = None
    for attempt in range(12):
        try:
            for check in config["health_checks"]:
                request = urllib.request.Request(check["url"], headers={"Cache-Control": "no-cache"})
                with urllib.request.urlopen(request, timeout=3) as response:
                    require(response.status == 200, "Health endpoint did not return HTTP 200")
                    data = json.loads(response.read(1024 * 1024))
                if check["kind"] == "release":
                    require(data.get("commit") == revision, "Running release does not match")
                elif check["kind"] == "chain":
                    require(data.get("chainId") == 1337, "Unexpected chain")
            return
        except (OSError, ValueError) as error:
            last_error = error
            if attempt < 11:
                time.sleep(1)
    raise RuntimeError("Release health checks failed") from last_error


def activate(config, release):
    root = Path(config["root"])
    previous = previous_release(root)
    set_current(root, release)
    try:
        restart(config)
        health(config, release.name)
    except Exception as deployment_error:
        try:
            if previous is not None:
                set_current(root, previous)
                restart(config)
                health(config, previous.name)
            else:
                subprocess.run(["systemctl", "--user", "stop", *config["services"]],
                               check=True, timeout=90)
                (root / "current").unlink()
        except Exception as rollback_error:
            raise RuntimeError("Deployment and rollback failed; operator intervention required") from rollback_error
        raise RuntimeError("Deployment failed; previous state restored") from deployment_error


def install(config, archive_path, revision, expected_digest):
    import fcntl
    root = Path(config["root"])
    require(not (root / ".deploy.lock").is_symlink(), "Invalid deployment lock")
    with (root / ".deploy.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        previous_release(root)
        manifest, contents = inspect_archive(archive_path, revision, expected_digest)
        releases = root / "releases"
        require(not releases.is_symlink(), "Release directory must not be a symlink")
        releases.mkdir(mode=0o700, exist_ok=True)
        release = releases / revision
        require(not release.is_symlink(), "Invalid existing release")
        if release.exists():
            require((release / "RELEASE.json").read_text() == json.dumps(manifest, sort_keys=True) + "\n",
                    "Existing release has a different manifest")
            for name, expected in manifest["files"].items():
                file = release / name
                require(file.resolve().is_relative_to(release) and not file.is_symlink()
                        and digest(file.read_bytes()) == expected, "Existing release was modified")
        else:
            temporary = Path(tempfile.mkdtemp(prefix=".prepare-", dir=releases))
            try:
                for name, data in contents.items():
                    destination = temporary / name
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    destination.write_bytes(data)
                (temporary / "RELEASE.json").write_text(json.dumps(manifest, sort_keys=True) + "\n")
                runtime_env = {**os.environ, "PATH": str(Path(config["node"]).parent) + os.pathsep + os.environ.get("PATH", "")}
                for package in ("frontend", "explorer"):
                    subprocess.run(
                        [config["node"], config["npm_cli"], "ci", "--prefix", str(temporary / package),
                         "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
                        check=True, timeout=180, env=runtime_env)
                os.rename(temporary, release)
            finally:
                if temporary.exists():
                    shutil.rmtree(temporary)
        activate(config, release)
        print(json.dumps({"environment": config["environment"], "commit": revision,
                          "sourceTree": manifest["sourceTree"], "status": "healthy"}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    pack = sub.add_parser("package", help="Package runtime files from the current Git commit")
    pack.add_argument("output", type=Path)
    deploy = sub.add_parser("deploy", help="Install an uploaded release using protected host configuration")
    deploy.add_argument("environment", choices=("staging", "production"))
    deploy.add_argument("commit")
    deploy.add_argument("sha256")
    args = parser.parse_args()
    if args.command == "package":
        manifest = package_commit(args.output)
        print(json.dumps({"commit": manifest["commit"], "sha256": digest(args.output.read_bytes())}))
    else:
        require(SHA.fullmatch(args.commit), "Invalid commit")
        require(DIGEST.fullmatch(args.sha256), "Invalid archive digest")
        config = read_config(Path.home() / ".config/daisugi" / (args.environment + ".json"), args.environment)
        incoming = Path.home() / "portal-incoming"
        require(incoming.resolve() == incoming and incoming.is_dir(), "Invalid incoming directory")
        install(config, incoming / (args.commit + ".tar.gz"), args.commit, args.sha256)


if __name__ == "__main__":
    main()
