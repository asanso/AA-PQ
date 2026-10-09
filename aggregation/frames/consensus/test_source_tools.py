"""Check that source preparation refuses incompatible or locally edited inputs."""
import importlib.util
from pathlib import Path
import shutil
import sys
import tempfile
import unittest


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


apply_module = load("transport_apply", "apply.py")
native_module = load("transport_native", "prepare-native.py")


class SourcePreparationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for name in apply_module.EXPORTS:
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(lighthouse / name, target)
        (self.root / "beacon_node/execution_layer/src/engine_api").mkdir()

    def snapshot(self):
        return {str(p.relative_to(self.root)): p.read_bytes() for p in self.root.rglob("*") if p.is_file()}

    def test_second_application_is_idempotent(self):
        apply_module.apply(self.root)
        first = self.snapshot()
        apply_module.apply(self.root)
        self.assertEqual(first, self.snapshot())

    def test_wrong_upstream_refuses_all_writes(self):
        path = self.root / "beacon_node/execution_layer/src/lib.rs"
        path.write_bytes(path.read_bytes() + b"// unrelated edit\n")
        before = self.snapshot()
        with self.assertRaises(ValueError):
            apply_module.apply(self.root)
        self.assertEqual(before, self.snapshot())

    def test_existing_module_edit_is_preserved(self):
        path = self.root / apply_module.MODULES["aggregate_json.rs"]
        path.write_text("// existing user work\n", encoding="utf-8")
        before = self.snapshot()
        with self.assertRaises(ValueError):
            apply_module.apply(self.root)
        self.assertEqual(before, self.snapshot())

    def test_native_test_generation_requires_exact_base(self):
        base = self.root / "NativeBlockProductionTests.cs"
        base.write_text("// wrong revision\n", encoding="utf-8")
        with self.assertRaises(ValueError):
            native_module.assemble(base, Path(__file__).resolve().parent.parent)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python3 test_source_tools.py PRISTINE_LIGHTHOUSE_SOURCE")
    lighthouse = Path(sys.argv.pop()).resolve()
    unittest.main()
