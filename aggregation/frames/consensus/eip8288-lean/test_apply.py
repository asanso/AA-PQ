"""Exercise apply.py on a synthetic upstream archive and patch series built with Git."""
import gzip
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("client_patches", Path(__file__).with_name("apply.py"))
patches = importlib.util.module_from_spec(spec)
spec.loader.exec_module(patches)


def git(cwd: Path, *arguments: str) -> str:
    environment = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    environment.update(GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t", GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@t")
    command = ["git", "-c", "core.autocrlf=false", "-c", "core.excludesFile=/dev/null", "-c", "commit.gpgsign=false",
               *arguments]
    return subprocess.run(command, cwd=cwd, env=environment, check=True, capture_output=True).stdout.decode().strip()


class PatchSeriesTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        upstream = self.root / "upstream"
        (upstream / "nested/dir").mkdir(parents=True)
        (upstream / "README").write_bytes(b"pinned\n")
        (upstream / "macros.rs").write_bytes(b"line one\r\nline two\r\n")
        (upstream / "data.bin").write_bytes(bytes(range(256)))
        (upstream / "nested/dir/remove.rs").write_bytes(b"removed later\n")
        (upstream / "tool.sh").write_bytes(b"#!/bin/sh\n")
        (upstream / "tool.sh").chmod(0o755)
        (upstream / "link").symlink_to("README")
        git(upstream, "init", "-q")
        git(upstream, "add", "-A")
        git(upstream, "commit", "-qm", "upstream")
        self.revision = git(upstream, "rev-parse", "HEAD")
        pristine = git(upstream, "rev-parse", "HEAD^{tree}")
        tar = subprocess.run(["git", "archive", "--format=tar", f"--prefix=lighthouse-{self.revision}/", "HEAD"],
                             cwd=upstream, check=True, capture_output=True).stdout
        self.archive = self.root / "lighthouse.tar.gz"
        self.archive.write_bytes(gzip.compress(tar, mtime=0))

        (upstream / "macros.rs").write_bytes(b"line one\r\nline 2\r\n")
        (upstream / "added.sh").write_bytes(b"#!/bin/sh\necho added\n")
        (upstream / "added.sh").chmod(0o755)
        git(upstream, "add", "-A")
        git(upstream, "commit", "-qm", "first change")
        (upstream / "data.bin").write_bytes(bytes(reversed(range(256))))
        (upstream / "nested/dir/remove.rs").unlink()
        (upstream / "added.sh").write_bytes(b"#!/bin/sh\necho changed\n")
        git(upstream, "add", "-A")
        git(upstream, "commit", "-qm", "second change")
        self.patched = git(upstream, "rev-parse", "HEAD^{tree}")
        self.patches = self.root / "patches"
        git(upstream, "format-patch", "-q", "--binary", "--full-index", "--zero-commit", "--no-signature",
            "-o", str(self.patches / "lighthouse"), f"{self.revision}..HEAD")
        files = sorted((self.patches / "lighthouse").glob("*.patch"))
        self.lock = {"lighthouse": {"revision": self.revision, "archiveSha256": patches.sha256(self.archive),
                                    "patchSeries": {"pristineTree": pristine, "patchedTree": self.patched,
                                                    "patches": [self.record(f) for f in files]}}}
        self.save()
        self.output = self.root / "work" / "lighthouse"

    def record(self, path: Path) -> dict:
        return {"file": path.name, "sha256": patches.sha256(path)}

    def save(self):
        self.lock_path = self.root / "sources.lock.json"
        self.lock_path.write_text(json.dumps(self.lock))

    def prepare(self, check_only=False, output=None):
        return patches.prepare("lighthouse", self.archive, output or self.output, check_only, self.lock_path, self.patches)

    def assert_refused(self, message, output=None):
        with self.assertRaisesRegex(ValueError, message):
            self.prepare(output=output)
        parent = (output or self.output).parent
        leftovers = [p.name for p in parent.iterdir() if ".staging-" in p.name] if parent.exists() else []
        self.assertEqual(leftovers, [])

    def test_tree_hash_matches_git_for_modes_symlinks_line_endings_and_binary_contents(self):
        extracted = patches.extract(self.archive, self.root, f"lighthouse-{self.revision}")
        self.assertEqual(patches.tree_hash(extracted), self.lock["lighthouse"]["patchSeries"]["pristineTree"])
        (extracted / "empty").mkdir()
        self.assertEqual(patches.tree_hash(extracted), self.lock["lighthouse"]["patchSeries"]["pristineTree"])

    def test_creates_the_patched_tree_then_treats_it_as_done(self):
        self.assertEqual(self.prepare(), "patched")
        self.assertEqual(patches.tree_hash(self.output), self.patched)
        self.assertTrue(os.access(self.output / "added.sh", os.X_OK))
        self.assertEqual((self.output / "macros.rs").read_bytes(), b"line one\r\nline 2\r\n")
        self.assertEqual(self.prepare(), "already-patched")

    def test_check_creates_nothing(self):
        self.assertEqual(self.prepare(check_only=True), "checked")
        self.assertEqual(list(self.output.parent.iterdir()), [])

    def test_applies_inside_another_git_repository(self):
        repository = self.root / "repository"
        repository.mkdir()
        git(repository, "init", "-q")
        output = repository / "sources" / "lighthouse"
        self.assertEqual(self.prepare(output=output), "patched")
        self.assertEqual(patches.tree_hash(output), self.patched)

    def test_another_archive_is_refused(self):
        self.lock["lighthouse"]["archiveSha256"] = "0" * 64
        self.save()
        self.assert_refused("Source archive differs")
        self.assertFalse(self.output.exists())

    def test_a_modified_patch_is_refused(self):
        first = sorted((self.patches / "lighthouse").glob("*.patch"))[0]
        first.write_bytes(first.read_bytes().replace(b"line 2", b"line 3"))
        self.assert_refused("Patch differs")

    def test_an_unlisted_patch_is_refused(self):
        (self.patches / "lighthouse" / "9999-extra.patch").write_bytes(b"")
        self.assert_refused("not listed")

    def test_a_patch_outside_the_tree_or_into_git_is_refused(self):
        series = list(self.lock["lighthouse"]["patchSeries"]["patches"])
        for target in ("../escape", ".git/config", "nested/.git/config"):
            with self.subTest(target):
                escape = self.patches / "lighthouse" / "0003-escape.patch"
                escape.write_bytes(f"diff --git a/{target} b/{target}\nnew file mode 100644\n--- /dev/null\n"
                                   f"+++ b/{target}\n@@ -0,0 +1 @@\n+escaped\n".encode())
                self.lock["lighthouse"]["patchSeries"]["patches"] = series + [self.record(escape)]
                self.save()
                self.assert_refused("does not apply")
                self.assertFalse((self.root / "work" / "escape").exists())
                self.assertFalse(self.output.exists())

    def test_user_git_configuration_does_not_change_the_result(self):
        home = self.root / "home"
        home.mkdir()
        (home / ".gitconfig").write_text("[core]\n\tautocrlf = true\n\tsymlinks = false\n[apply]\n\twhitespace = fix\n")
        previous = os.environ.get("HOME")
        os.environ["HOME"] = str(home)
        try:
            self.assertEqual(self.prepare(), "patched")
        finally:
            os.environ["HOME"] = previous
        self.assertEqual(patches.tree_hash(self.output), self.patched)

    def test_a_failing_patch_leaves_nothing(self):
        series = self.lock["lighthouse"]["patchSeries"]["patches"]
        series.insert(0, series.pop())
        self.save()
        self.assert_refused("does not apply")
        self.assertFalse(self.output.exists())

    def test_an_unexpected_result_is_not_published(self):
        self.lock["lighthouse"]["patchSeries"]["patchedTree"] = "0" * 40
        self.save()
        self.assert_refused("Patched tree differs")
        self.assertFalse(self.output.exists())

    def test_an_existing_different_output_is_left_unchanged(self):
        self.output.mkdir(parents=True)
        (self.output / "user.rs").write_bytes(b"local work")
        self.assert_refused("left unchanged")
        self.assertEqual([p.name for p in self.output.iterdir()], ["user.rs"])

    def test_an_escaping_archive_member_is_refused(self):
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w:gz") as tar:
            member = tarfile.TarInfo(f"lighthouse-{self.revision}/../../evil")
            member.size = 4
            tar.addfile(member, io.BytesIO(b"evil"))
        self.archive.write_bytes(buffer.getvalue())
        self.lock["lighthouse"]["archiveSha256"] = hashlib.sha256(buffer.getvalue()).hexdigest()
        self.save()
        self.assert_refused("Unsafe path")
        self.assertFalse((self.root / "evil").exists())


if __name__ == "__main__":
    unittest.main()
