"""Check that activation preparation preserves genesis and rejects ambiguous schedules."""
import copy
import unittest
from prepare_activation import proposal


class ActivationTests(unittest.TestCase):
    def setUp(self):
        self.genesis = {"config": {"chainId": 1337, "eip8141PrototypeTime": 1000, "pragueTime": 0},
                        "alloc": {"public-address": {"balance": "0x10"}}, "timestamp": "0x0"}
        self.beacon = {"ELECTRA_FORK_EPOCH": "0", "ELECTRA_FORK_VERSION": "0x05000038",
                       "SECONDS_PER_SLOT": "2", "SLOTS_PER_EPOCH": "32"}

    def make(self, **options):
        return proposal(self.genesis, self.beacon, options.get("genesis_time", 1000),
                        options.get("epoch", 4), options.get("version", "0xd0010203"),
                        options.get("current_epoch", 2),
                        preserve_native_wallet=options.get("preserve_native_wallet", False))

    def test_preserves_all_prior_data(self):
        before = copy.deepcopy((self.genesis, self.beacon))
        result = self.make()
        restored = copy.deepcopy(result["executionGenesis"])
        self.assertEqual(restored["config"].pop("eip8288PrototypeTime"), 1256)
        self.assertEqual(restored, self.genesis)
        self.assertEqual(before, (self.genesis, self.beacon))
        self.assertEqual(result["beaconConfig"]["MAX_PAYLOAD_SIZE"], "20971520")
        self.assertFalse(result["installed"])

    def test_compatibility_is_explicit_and_does_not_change_historical_configuration(self):
        strict = self.make()
        self.assertNotIn("daisugiLegacyFrames", strict["executionGenesis"]["config"])
        compatible = self.make(preserve_native_wallet=True)
        self.assertTrue(compatible["legacyFrameCompatibility"])
        self.assertEqual(compatible["requiredFrameTxMaxVerifyGas"], 500000)
        restored = copy.deepcopy(compatible["executionGenesis"])
        restored["config"].pop("eip8288PrototypeTime")
        self.assertTrue(restored["config"].pop("daisugiLegacyFrames"))
        self.assertEqual(restored, self.genesis)
        self.assertFalse(compatible["installed"])

    def test_requires_future_epoch(self):
        with self.assertRaises(ValueError): self.make(epoch=2)

    def test_rejects_version_collision(self):
        with self.assertRaises(ValueError): self.make(version="0x05000038")

    def test_rejects_other_consensus_branch(self):
        self.beacon["FULU_FORK_EPOCH"] = "10"
        with self.assertRaises(ValueError): self.make()

    def test_rejects_existing_activation(self):
        self.genesis["config"]["eip8288PrototypeTime"] = 1200
        with self.assertRaises(ValueError): self.make()

    def test_rejects_wrong_chain_and_slot_duration(self):
        self.genesis["config"]["chainId"] = 1
        with self.assertRaises(ValueError): self.make()
        self.genesis["config"]["chainId"] = 1337
        self.beacon["SECONDS_PER_SLOT"] = "12"
        with self.assertRaises(ValueError): self.make()


if __name__ == "__main__":
    unittest.main()
