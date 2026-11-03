"""Verify source overlay integrity, path confinement and preservation of local edits."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("client_overlay", Path(__file__).with_name("apply.py"))
overlay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(overlay)


class OverlayTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.target = self.root / "source"
        self.target.mkdir()
        self.package = self.root / "package"
        (self.package / "files").mkdir(parents=True)
        (self.target / "pin").write_bytes(b"pinned")
        (self.target / "existing.rs").write_bytes(b"before")
        self.manifest = {"anchors": {"pin": overlay.sha256(b"pinned")}, "files": {}}
        for name, before in [("existing.rs", b"before"), ("new.rs", None)]:
            content = b"after " + name.encode()
            (self.package / "files" / name).write_bytes(content)
            self.manifest["files"][name] = {"before": overlay.sha256(before) if before else None,
                                           "after": overlay.sha256(content)}
        self.save()

    def save(self):
        (self.package / "manifest.json").write_text(json.dumps(self.manifest))

    def snapshot(self):
        return {p.name: p.read_bytes() for p in self.target.iterdir()}

    def test_apply_is_idempotent(self):
        self.assertEqual(overlay.apply(self.target, self.package), 2)
        self.assertEqual(overlay.apply(self.target, self.package), 0)

    def test_check_does_not_write(self):
        before = self.snapshot()
        self.assertEqual(overlay.apply(self.target, self.package, True), 2)
        self.assertEqual(self.snapshot(), before)

    def test_local_edit_prevents_all_writes(self):
        (self.target / "new.rs").write_bytes(b"user edit")
        before = self.snapshot()
        with self.assertRaises(ValueError):
            overlay.apply(self.target, self.package)
        self.assertEqual(self.snapshot(), before)

    def test_wrong_upstream_prevents_all_writes(self):
        (self.target / "pin").write_bytes(b"different revision")
        before = self.snapshot()
        with self.assertRaises(ValueError):
            overlay.apply(self.target, self.package)
        self.assertEqual(self.snapshot(), before)

    def test_corrupt_overlay_prevents_all_writes(self):
        (self.package / "files/new.rs").write_bytes(b"altered")
        before = self.snapshot()
        with self.assertRaises(ValueError):
            overlay.apply(self.target, self.package)
        self.assertEqual(self.snapshot(), before)

    def test_path_traversal_prevents_all_writes(self):
        self.manifest["files"]["../escape.rs"] = self.manifest["files"].pop("new.rs")
        self.save()
        before = self.snapshot()
        with self.assertRaises(ValueError):
            overlay.apply(self.target, self.package)
        self.assertEqual(self.snapshot(), before)


if __name__ == "__main__":
    unittest.main()
