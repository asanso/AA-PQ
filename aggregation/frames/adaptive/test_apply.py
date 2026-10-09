"""Overlay integrity and atomic preflight checks; no client process is started."""
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from apply import apply

class OverlayTests(unittest.TestCase):
    def test_checks_every_input_before_writing(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);source=root/'source';package=root/'package'
            source.mkdir();(package/'files').mkdir(parents=True)
            for name in ['a','b']:
                (source/name).write_bytes(b'old');(package/'files'/name).write_bytes(b'new')
            record={'before':hashlib.sha256(b'old').hexdigest(),'after':hashlib.sha256(b'new').hexdigest()}
            (package/'manifest.json').write_text(json.dumps({'files':{'a':record,'b':record}}))
            self.assertEqual(apply(source,package,True),2)
            self.assertEqual((source/'a').read_bytes(),b'old')
            (source/'b').write_bytes(b'custom')
            with self.assertRaises(ValueError):apply(source,package)
            self.assertEqual((source/'a').read_bytes(),b'old')
            (source/'b').write_bytes(b'old')
            self.assertEqual(apply(source,package),2)
            self.assertEqual(apply(source,package),0)

    def test_rejects_traversal_and_corrupted_payloads(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);source=root/'source';package=root/'package'
            source.mkdir();(package/'files').mkdir(parents=True)
            record={'before':None,'after':hashlib.sha256(b'new').hexdigest()}
            (package/'manifest.json').write_text(json.dumps({'files':{'../outside':record}}))
            with self.assertRaises(ValueError):apply(source,package)
            (package/'files'/'a').write_bytes(b'bad')
            (package/'manifest.json').write_text(json.dumps({'files':{'a':record}}))
            with self.assertRaises(ValueError):apply(source,package)
            self.assertFalse((source/'a').exists())

if __name__ == '__main__': unittest.main()
