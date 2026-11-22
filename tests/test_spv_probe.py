import struct
import unittest
from spv_probe import probe


class SpvProbeTest(unittest.TestCase):
    config = {"type_script": {"code_hash": "0x" + "11" * 32,
                              "hash_type": "type", "args": "0x" + "22" * 32 + "0200"}}

    def test_active_client_not_largest_height(self):
        def cell(client, tip):
            data = bytes([client]) + bytes(32) + struct.pack("<II", 100, tip) + bytes(72)
            return {"output_data": "0x" + data.hex()}

        def rpc(method, params):
            self.assertEqual(method, "get_cells")
            self.assertEqual(params[0]["script_search_mode"], "exact")
            return {"objects": [cell(0, 180), {"output_data": "0x01"}, cell(1, 160)]}

        out = probe("mainnet", self.config, rpc, 200)
        self.assertEqual(out["state"], "syncing")
        self.assertEqual(out["progress"], 0.6)
        self.assertEqual(out["metrics"][0]["value"], 160)

    def test_missing_cells(self):
        out = probe("testnet3", self.config, lambda *_: {"objects": []}, None)
        self.assertEqual(out["state"], "degraded")

    def test_without_config(self):
        self.assertEqual(probe("mainnet", {}, None, None)["state"], "unknown")
