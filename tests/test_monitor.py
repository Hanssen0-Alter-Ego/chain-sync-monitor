import base64
import json
import os
import tempfile
import threading
import unittest
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import urlopen

import monitor

STATIC_DIR = Path(monitor.__file__).parent / "static"


@contextmanager
def http_fixture(callback):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            self.respond(None)

        def do_POST(self):
            length = int(self.headers.get("Content-Length", "0"))
            self.respond(json.loads(self.rfile.read(length)))

        def respond(self, request):
            status, body, headers = callback(self, request)
            output = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(output)))
            for k, v in headers.items():
                self.send_header(k, v)
            self.end_headers()
            try:
                self.wfile.write(output)
            except BrokenPipeError:
                pass

    with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
        thread.start()
        try:
            yield f"http://127.0.0.1:{server.server_port}"
        finally:
            server.shutdown()
            thread.join()


def result(payload, data):
    return 200, {"jsonrpc": "2.0", "id": payload["id"], "result": data}, {}


class MonitorTests(unittest.TestCase):
    def test_toml_credentials_from_environment_and_file(self):
        with tempfile.TemporaryDirectory() as workdir:
            root = Path(workdir)
            (root / "password.txt").write_text("synthetic:file-secret\n", encoding="utf-8")
            (root / "startup.toml").write_text(
                '[monitor]\ninterval_seconds=2\n'
                '[networks.testnet3.btc]\nurl="http://127.0.0.1:18332"\n'
                'username_env="MONITOR_TEST_USER"\npassword_file="password.txt"\n', encoding="utf-8"
            )
            with patch.dict(os.environ, {"MONITOR_TEST_USER": "fixture-user"}):
                config = monitor.load_config(root / "startup.toml")
            self.assertEqual(config.host, "127.0.0.1")
            self.assertEqual(config.interval_seconds, 2)
            endpoint = config.endpoints["testnet3"]["btc"]
            self.assertEqual(base64.b64decode(endpoint.authorization[6:]), b"fixture-user:synthetic:file-secret")
            self.assertNotIn("file-secret", repr(endpoint))
            self.assertNotIn(endpoint.authorization, repr(config))

    def test_config_rejects_embedded_secrets_and_empty_query_or_fragment(self):
        for url in ("http://example.test:1/?", "http://example.test/#", "http://user:secret@example.test/"):
            with self.subTest(url=url), tempfile.TemporaryDirectory() as workdir:
                config = Path(workdir) / "monitor.toml"
                config.write_text(f'[networks.mainnet.ckb]\nurl="{url}"\n', encoding="utf-8")
                with self.assertRaises(monitor.ConfigError) as error:
                    monitor.load_config(config)
                self.assertNotIn("user:secret", str(error.exception))

    def test_rpc_redirect_is_not_followed_even_with_basic_auth(self):
        observed = []
        def sink(handler, request):
            observed.append((handler.path, handler.headers.get("Authorization")))
            return 200, {"id": 1, "result": None}, {}
        with http_fixture(sink) as target:
            def source(handler, request):
                observed.append((handler.path, handler.headers.get("Authorization")))
                return 307, {}, {"Location": target + "/should-not-be-called"}
            with http_fixture(source) as url:
                endpoint = monitor.Endpoint(url + "/core", "Basic Zml4dHVyZTpmaXh0dXJl")
                with self.assertRaisesRegex(monitor.ProbeError, "重定向"):
                    monitor.rpc(endpoint, 2, "getblockchaininfo", [], bitcoin=True)
        self.assertEqual(observed, [("/core", "Basic Zml4dHVyZTpmaXh0dXJl")])

    def test_btc_testnet3_warmup_wrong_network_and_progress(self):
        replies = [
            (500, {"id": 1, "result": None, "error": {"code": -28, "message": "do not render"}}, {}),
            (200, {"id": 1, "result": {"chain": "testnet4"}}, {}),
            (200, {"id": 1, "result": {
                "chain": "test", "blocks": 6, "headers": 10, "initialblockdownload": False, "verificationprogress": 0.3,
            }}, {}),
            (200, {"id": 1, "result": {
                "chain": "testnet3", "blocks": 10, "headers": 10, "initialblockdownload": False,
            }}, {}),
        ]
        def handler(server, payload):
            self.assertEqual(payload["method"], "getblockchaininfo")
            return replies.pop(0)
        with http_fixture(handler) as url:
            endpoint = monitor.Endpoint(url)
            warm, no_tip = monitor.probe_bitcoin("testnet3", endpoint, 2)
            self.assertIsNone(no_tip)
            self.assertEqual(warm["state"], "syncing")
            wrong, no_tip = monitor.probe_bitcoin("testnet3", endpoint, 2)
            self.assertIsNone(no_tip)
            self.assertEqual(wrong["state"], "degraded")
            active, tip = monitor.probe_bitcoin("testnet3", endpoint, 2)
            self.assertEqual(active["state"], "syncing")
            self.assertEqual(active["progress"], 0.3)
            self.assertEqual(tip.height, 6)
            ready, tip = monitor.probe_bitcoin("testnet3", endpoint, 2)
            self.assertEqual(ready["state"], "synced")
            self.assertTrue(tip.synced)

    def test_ckb_uses_node_and_indexer_evidence(self):
        fields = {
            "ibd": False, "tip_number": "0x64", "best_known_block_number": "0x65",
            "unverified_tip_number": "0x65", "inflight_blocks_count": "0x10",
        }
        indexer = {"block_number": "0x61"}
        def handler(_server, payload):
            self.assertIn(payload["method"], {"sync_state", "get_indexer_tip"})
            return result(payload, fields if payload["method"] == "sync_state" else indexer)
        with http_fixture(handler) as url:
            active, available = monitor.probe_ckb(monitor.Endpoint(url), 2)
        self.assertEqual(active["state"], "syncing")
        self.assertTrue(available)
        self.assertEqual([row["value"] for row in active["metrics"]], [100, 101, 101, 16, 97, 3])

    def test_blockbook_no_progress_without_reference_and_no_false_synced(self):
        info = {"blockbook": {"bestHeight": 99, "inSync": True, "inSyncMempool": True}}
        no_reference, _ = monitor.probe_blockbook("mainnet", info, None)
        self.assertEqual(no_reference["state"], "unknown")
        tip = monitor.BitcoinTip(100, 100, None, True)
        lagging, _ = monitor.probe_blockbook("mainnet", info, tip)
        self.assertEqual(lagging["state"], "syncing")
        self.assertEqual(lagging["progress"], 0.99)
        info["blockbook"]["bestHeight"] = 100
        info["blockbook"]["inSyncMempool"] = False
        mempool, _ = monitor.probe_blockbook("mainnet", info, tip)
        self.assertEqual(mempool["state"], "syncing")
        info["blockbook"]["inSyncMempool"] = True
        ready, _ = monitor.probe_blockbook("mainnet", info, tip)
        self.assertEqual(ready["state"], "synced")

    def test_all_services_and_spv_hook_on_two_networks(self):
        observed = []
        def handler(server, payload):
            observed.append((server.path, payload and payload["method"]))
            if server.path.endswith("/api/"):
                return 200, {"blockbook": {"bestHeight": 100, "inSync": True, "inSyncMempool": True}}, {}
            if server.path.endswith("/api/v1/statistics/network"):
                return 200, {"syncStatus": {"syncedBlock": 100, "tipBlock": 100, "isSyncing": False}}, {}
            method = payload["method"]
            if method == "getblockchaininfo":
                chain = "main" if server.path.startswith("/mainnet") else "test"
                return result(payload, {"chain": chain, "blocks": 100, "headers": 100, "initialblockdownload": False})
            if method == "sync_state":
                return result(payload, {"tip_number": "0x64", "ibd": False})
            if method == "get_indexer_tip":
                return result(payload, {"block_number": "0x64"})
            if method == "getTxProof":
                self.assertEqual(payload["params"], [])
                return 200, {
                    "jsonrpc": "2.0", "id": 1, "error": {"code": -32602, "message": "no tx list"},
                }, {}
            if method == "get_cells":
                return result(payload, {"objects": []})
            self.fail("Unexpected RPC method")
        hooks = []
        def hook(network, config, ckb_rpc, btc_tip):
            hooks.append((network, config["anchor"], btc_tip))
            self.assertEqual(ckb_rpc("get_cells", [])["objects"], [])
            return {"state": "syncing", "metrics": [monitor.metric("SPV verified height", 90)], "progress": 0.9}
        with http_fixture(handler) as url:
            endpoints = {
                network: {
                    kind: monitor.Endpoint(
                        f"{url}/{network}/{kind}" + ("/api/v1/statistics/network" if kind == "ckbadger" else ""),
                        options={"anchor": "fixture"},
                    )
                    for kind in monitor.LABELS
                } for network in monitor.NETWORKS
            }
            daemon = monitor.Monitor(monitor.Config(endpoints, timeout_seconds=2), hook)
            self.assertIsNone(daemon.snapshot["updatedAt"])
            snapshot = daemon.poll()
        self.assertEqual(len(snapshot["services"]), 10)
        self.assertEqual({r["state"] for r in snapshot["services"] if r["kind"] != "spv"}, {"synced"})
        self.assertEqual({r["state"] for r in snapshot["services"] if r["kind"] == "spv"}, {"syncing"})
        self.assertEqual({r["progress"] for r in snapshot["services"] if r["kind"] == "spv"}, {0.9})
        self.assertEqual(set(hooks), {("mainnet", "fixture", 100), ("testnet3", "fixture", 100)})
        self.assertEqual(len(observed), 14)

    def test_ckbadger_warmup_is_not_counted_as_available(self):
        def handler(server, payload):
            error = "initializing" if server.path == "/warmup" else "upstream unavailable"
            return 503, {"error": error}, {}

        daemon = monitor.Monitor(monitor.Config({net: {} for net in monitor.NETWORKS}))
        with http_fixture(handler) as url:
            observed = daemon._base_probe("mainnet", "ckbadger", monitor.Endpoint(url + "/warmup"))
            self.assertEqual(observed.value["state"], "syncing")
            self.assertFalse(observed.available)
            with self.assertRaisesRegex(monitor.ProbeError, "HTTP 503"):
                daemon._base_probe("mainnet", "ckbadger", monitor.Endpoint(url + "/failure"))

    def test_spv_matching_an_unsynced_core_is_not_reported_synced(self):
        endpoint = monitor.Endpoint("http://127.0.0.1:1")
        endpoints = {"mainnet": {"ckb": endpoint, "spv": endpoint}, "testnet3": {}}
        hook = lambda *_: monitor.reading("synced", progress=1.0)
        daemon = monitor.Monitor(monitor.Config(endpoints), hook)
        result = daemon._spv_onchain("mainnet", endpoint, monitor.reading("unknown"),
                                     monitor.BitcoinTip(100, 101, None, False))
        self.assertEqual(result["state"], "unknown")
        self.assertNotIn("progress", result)

    def test_dashboard_only_serves_snapshot_no_browser_selected_upstream(self):
        daemon = monitor.Monitor(monitor.Config({net: {} for net in monitor.NETWORKS}))
        with ThreadingHTTPServer(("127.0.0.1", 0), monitor.handler_for(daemon, STATIC_DIR)) as server:
            worker = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
            worker.start()
            base = f"http://127.0.0.1:{server.server_port}"
            try:
                with urlopen(base + "/api/status", timeout=2) as response:
                    self.assertEqual(response.headers["Cache-Control"], "no-store")
                    snapshot = json.load(response)
                    self.assertIsNone(snapshot["updatedAt"])
                    self.assertEqual(snapshot["services"], [])
                with self.assertRaises(HTTPError) as failure:
                    urlopen(base + "/api/status?url=http://example.test", timeout=2)
                self.assertEqual(failure.exception.code, 404)
            finally:
                server.shutdown()
                worker.join()


if __name__ == "__main__":
    unittest.main()
