"""Check the packaged Lighthouse patch series against sources.lock.json, without the upstream source."""
import importlib.util
import json
from pathlib import Path
import re
import unittest

spec = importlib.util.spec_from_file_location("client_patches", Path(__file__).with_name("apply.py"))
patches = importlib.util.module_from_spec(spec)
spec.loader.exec_module(patches)

PACKAGE = Path(__file__).resolve().parent


class PackagedSeriesTests(unittest.TestCase):
    def setUp(self):
        self.lighthouse = json.loads((PACKAGE / "sources.lock.json").read_text(encoding="utf-8"))["lighthouse"]
        self.series = self.lighthouse["patchSeries"]

    def test_hashes_are_well_formed(self):
        self.assertRegex(self.lighthouse["revision"], r"^[0-9a-f]{40}$")
        self.assertRegex(self.lighthouse["archiveSha256"], r"^[0-9a-f]{64}$")
        for tree in (self.series["pristineTree"], self.series["patchedTree"]):
            self.assertRegex(tree, r"^[0-9a-f]{40}$")

    def test_every_patch_matches_the_lock_and_none_is_unlisted(self):
        files = patches.load_series(self.lighthouse, PACKAGE / "patches" / "lighthouse")
        self.assertEqual([f.name for f in files], sorted(f.name for f in files))

    def test_provenance_covers_each_patch_once_in_order(self):
        provenance = self.series["provenance"]
        listed = provenance["inherited"]["patches"] + provenance["eip8288Lean"]["patches"]
        self.assertEqual(listed, [record["file"] for record in self.series["patches"]])
        self.assertEqual(len(provenance["eip8288Lean"]["originalCommits"]), len(provenance["eip8288Lean"]["patches"]))

    def test_patches_carry_no_commit_ids_or_tool_signature(self):
        for record in self.series["patches"]:
            with self.subTest(record["file"]):
                content = (PACKAGE / "patches" / "lighthouse" / record["file"]).read_bytes()
                self.assertTrue(content.startswith(b"From 0000000000000000000000000000000000000000 "))
                self.assertIsNone(re.search(rb"\n-- \n\d+\.\d+", content))


if __name__ == "__main__":
    unittest.main()
