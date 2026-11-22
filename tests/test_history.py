import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

import monitor
from history_store import HistoryStore, RETENTION_MINUTES, WINDOWS, availability
from test_monitor import http_fixture, result


class HistoryStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.db = Path(self.temp.name) / "availability.sqlite3"
        self.start = 60_000_000

    def test_actual_samples_persist_across_object_restart_and_gap(self):
        store = HistoryStore(self.db)
        self.assertEqual(store.observe({}, timestamp=self.start), {})
        store.observe({"mainnet-btc": True, "mainnet-ckb": False}, timestamp=self.start)
        before_restart = store.observe({"mainnet-btc": False}, timestamp=self.start + 1)
        self.assertEqual(before_restart["mainnet-btc"], availability(((1, 2), (1, 2))))
        reopened = HistoryStore(self.db)
        restored = reopened.observe({}, timestamp=self.start + 3 * 3600)
        self.assertEqual(restored, before_restart)
        after_restart = reopened.observe({"mainnet-btc": True}, timestamp=self.start + 4 * 3600)
        self.assertEqual(after_restart["mainnet-btc"], availability(((2, 3), (2, 3))))
        self.assertEqual(after_restart["mainnet-ckb"], availability(((0, 1), (0, 1))))

    def test_rolling_windows_expire_and_delete_old_rows(self):
        store = HistoryStore(self.db)
        store.observe({"testnet3-spv": True}, timestamp=self.start)
        one_day_later = store.observe({"testnet3-spv": False}, timestamp=self.start + WINDOWS[0])
        self.assertEqual(one_day_later["testnet3-spv"], availability(((0, 1), (1, 2))))
        one_week_later = store.observe({}, timestamp=self.start + WINDOWS[1])
        self.assertEqual(one_week_later["testnet3-spv"], availability(((0, 0), (0, 1))))
        none = store.observe({}, timestamp=self.start + (RETENTION_MINUTES + 1440) * 60)
        self.assertEqual(none, {})
        with closing(sqlite3.connect(self.db)) as conn:
            rows, = conn.execute("SELECT count(*) FROM availability_by_minute").fetchone()
        self.assertEqual(rows, 0)

    def test_db_failure_visible_does_not_block_and_recovers(self):
        bad_path = Path(self.temp.name) / "not-created" / "private.sqlite3"
        def handler(_server, payload):
            return result(payload, {
                "chain": "main", "blocks": 1, "headers": 1, "initialblockdownload": False,
            })
        with http_fixture(handler) as url:
            config = monitor.Config({"mainnet": {"btc": monitor.Endpoint(url)}, "testnet3": {}})
            daemon = monitor.Monitor(config, history=HistoryStore(bad_path))
            self.assertIn("historyError", daemon.snapshot)
            unavailable = daemon.poll()
            self.assertEqual(unavailable["services"][0]["state"], "synced")
            self.assertEqual(unavailable["services"][0]["availability"], availability())
            self.assertNotIn(str(bad_path), unavailable["historyError"])
            bad_path.parent.mkdir()
            recovered = daemon.poll()
        self.assertNotIn("historyError", recovered)
        self.assertEqual(recovered["services"][0]["availability"], availability(((1, 1), (1, 1))))

    def test_availability_tracks_primary_probe_not_sync_or_optional_detail(self):
        def handler(server, payload):
            if server.path.endswith("/blockbook/api/"):
                return 200, {"blockbook": {"bestHeight": 0, "inSync": False, "inSyncMempool": False},
                             "backend": {"error": "synthetic optional comparison failure"}}, {}
            method = payload["method"]
            if method == "getblockchaininfo":
                if server.path.startswith("/testnet3/"):
                    return 401, {}, {}
                return result(payload, {
                    "chain": "main", "blocks": 2, "headers": 10, "initialblockdownload": True,
                })
            if method == "sync_state":
                return result(payload, {"tip_number": "0x1", "ibd": False})
            if method == "get_indexer_tip":
                return 200, {"jsonrpc":"2.0", "id":1, "error":{"code":-32601}}, {}
            if method == "getTxProof":
                code = -32601 if server.path.startswith("/testnet3/") else -32602
                return 200, {"jsonrpc":"2.0", "id":1, "error":{"code":code}}, {}
            self.fail("unexpected RPC method")
        with http_fixture(handler) as url:
            config = monitor.Config({
                "mainnet": {kind: monitor.Endpoint(f"{url}/mainnet/{kind}") for kind in ("btc", "ckb", "spv", "blockbook")},
                "testnet3": {kind: monitor.Endpoint(f"{url}/testnet3/{kind}") for kind in ("btc", "spv")},
            })
            def spv_hook(*_):
                raise ValueError("synthetic invalid optional SPV detail")
            daemon = monitor.Monitor(config, spv_hook, history=HistoryStore(self.db))
            by_id = {row["id"]: row for row in daemon.poll()["services"]}

        expected_available = {
            "mainnet-btc": True, "mainnet-ckb": True, "mainnet-spv": True, "mainnet-blockbook": True,
            "testnet3-btc": False, "testnet3-spv": False,
        }
        self.assertEqual(set(by_id), set(expected_available))
        self.assertEqual(by_id["mainnet-btc"]["state"], "syncing")
        self.assertEqual(by_id["mainnet-ckb"]["state"], "degraded")
        self.assertEqual(by_id["mainnet-blockbook"]["state"], "degraded")
        self.assertEqual(by_id["mainnet-spv"]["state"], "degraded")
        for service, online in expected_available.items():
            value = availability(((int(online), 1),) * 2)
            self.assertEqual(by_id[service]["availability"], value, service)

    def test_generic_http_card_records_availability_without_chain_sync(self):
        reached = []
        def handler(server, payload):
            reached.append(server.path)
            self.assertIsNone(payload)
            self.assertIsNone(server.headers.get("Authorization"))
            if server.path == "/health":
                return 204, {}, {}
            return 307, {}, {"Location": "/must-not-follow"}
        with http_fixture(handler) as url:
            config_path = Path(self.temp.name) / "monitor.toml"
            probe = '[[networks.mainnet.http]]\nid="asset-api"\nlabel="BTC Asset API"\n'
            config_path.write_text(probe + f'url="{url}/health"\n', encoding="utf-8")
            config = monitor.load_config(config_path)
            self.assertFalse(config.history_path.exists())
            daemon = monitor.Monitor(config, history=HistoryStore(self.db))
            first, = daemon.poll()["services"]
            config_path.write_text(probe + f'url="{url}/redirect"\n', encoding="utf-8")
            daemon = monitor.Monitor(monitor.load_config(config_path), history=HistoryStore(self.db))
            second, = daemon.poll()["services"]
            config_path.write_text((probe + f'url="{url}/health"\n') * 2, encoding="utf-8")
            with self.assertRaises(monitor.ConfigError):
                monitor.load_config(config_path)
        self.assertEqual(reached, ["/health", "/redirect"])
        self.assertEqual(first["id"], "mainnet-http:asset-api")
        self.assertEqual(first["state"], "online")
        self.assertEqual(second["state"], "degraded")
        self.assertEqual(second["availability"], availability(((1, 2),) * 2))


if __name__ == "__main__":
    unittest.main()
