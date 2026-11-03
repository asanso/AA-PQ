"""Verify the packaged Lighthouse overlay against its manifest and the source lock, without the upstream source."""
import importlib.util
import json
from pathlib import Path
import re
import unittest

spec = importlib.util.spec_from_file_location("client_overlay", Path(__file__).with_name("apply.py"))
overlay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(overlay)

PACKAGE = Path(__file__).resolve().parent
OVERLAY = PACKAGE / "overlays" / "lighthouse"
SHA256 = re.compile(r"[0-9a-f]{64}")


class PackagedOverlayTests(unittest.TestCase):
    def setUp(self):
        self.manifest = json.loads((OVERLAY / "manifest.json").read_text(encoding="utf-8"))
        self.lock = json.loads((PACKAGE / "sources.lock.json").read_text(encoding="utf-8"))

    def test_manifest_pins_the_locked_revision(self):
        self.assertEqual(self.manifest["revision"], self.lock["lighthouse"]["revision"])

    def test_hashes_are_well_formed(self):
        self.assertTrue(self.manifest["anchors"])
        for name, expected in self.manifest["anchors"].items():
            self.assertRegex(expected, SHA256, name)
        for name, record in self.manifest["files"].items():
            self.assertRegex(record["after"], SHA256, name)
            if record["before"] is not None:
                self.assertRegex(record["before"], SHA256, name)

    def test_every_packaged_file_matches_its_manifest_hash(self):
        files = OVERLAY / "files"
        for name, record in self.manifest["files"].items():
            with self.subTest(name):
                self.assertEqual(overlay.sha256(overlay.checked_path(files, name).read_bytes()), record["after"])

    def test_no_file_is_packaged_without_a_manifest_entry(self):
        files = OVERLAY / "files"
        packaged = {path.relative_to(files).as_posix() for path in files.rglob("*") if path.is_file()}
        self.assertEqual(packaged, set(self.manifest["files"]))


if __name__ == "__main__":
    unittest.main()
