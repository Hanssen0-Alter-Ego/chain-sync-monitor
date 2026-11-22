#!/usr/bin/env python3
"""Read-only HTTP monitor for two RGB++ infrastructure networks."""
from __future__ import annotations

import argparse
import base64
import http.client
import importlib
import json
import math
import os
import re
import signal
import sys
import threading
import time
import tomllib
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from history_store import HistoryStore, UNAVAILABLE_MESSAGE, availability

from extras_probe import ckbadger, http_probe

NETWORKS = ("mainnet", "testnet3")
LABELS = {
    "btc": "Bitcoin Core",
    "ckb": "CKB 节点与索引器",
    "blockbook": "Blockbook",
    "spv": "Bitcoin SPV 服务",
    "ckbadger": "CKBadger",
}
BTC_CHAINS = {"mainnet": {"main"}, "testnet3": {"test", "testnet3"}}
STATES = {"online", "synced", "syncing", "degraded", "offline", "unknown"}
ASSETS = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
}
MAX_BODY = 2 * 1024 * 1024
MAX_SAFE_INTEGER = 2**53 - 1
BTC_HASH = re.compile(r"[0-9a-fA-F]{64}")
CKB_HASH = re.compile(r"0x[0-9a-fA-F]{64}")


class ConfigError(ValueError):
    pass


class ProbeError(Exception):
    def __init__(self, note: str, state: str = "degraded"):
        self.note = note
        self.state = state
        super().__init__(note)


class RpcError(ProbeError):
    def __init__(self, code: int):
        self.code = code
        super().__init__(f"RPC 返回错误（{code}）。", "unknown" if code == -32601 else "degraded")


@dataclass(frozen=True)
class Endpoint:
    url: str
    authorization: str | None = field(default=None, repr=False)
    options: dict = field(default_factory=dict, repr=False)


@dataclass(frozen=True)
class Config:
    endpoints: dict[str, dict[str, Endpoint]]
    host: str = "127.0.0.1"
    port: int = 8080
    interval_seconds: float = 30
    timeout_seconds: float = 5
    history_path: Path = Path("history.sqlite3")


def object_or_error(value, label: str) -> dict:
    if not isinstance(value, dict):
        raise ConfigError(f"{label} 应是 TOML 表。")
    return value


def bounded_number(value, low: float, high: float) -> bool:
    return type(value) in (int, float) and low <= value <= high


def validate_host(host) -> str:
    if not isinstance(host, str) or not host or any(c.isspace() for c in host):
        raise ConfigError("monitor.host 必须是有效的监听地址。")
    return host


def validate_port(port) -> int:
    if type(port) is not int or not 1 <= port <= 65535:
        raise ConfigError("monitor.port 必须在 1 到 65535 之间。")
    return port


def validate_url(value, label: str) -> str:
    if not isinstance(value, str) or not value or any(c.isspace() or ord(c) < 32 for c in value):
        raise ConfigError(f"{label}.url 必须是 HTTP(S) URL。")
    try:
        parts = urlsplit(value)
        _ = parts.port
        if (
            parts.scheme not in {"http", "https"} or not parts.hostname
            or parts.username is not None or parts.password is not None
            or "?" in value or "#" in value or "\\" in value
        ):
            raise ValueError
    except ValueError:
        raise ConfigError(f"{label}.url 不应包含内嵌凭据、查询参数或片段。") from None
    return value


def credential(table: dict, key: str, config_dir: Path, label: str) -> str | None:
    found = [name for name in (key, key + "_env", key + "_file") if name in table]
    if not found:
        return None
    if len(found) != 1:
        raise ConfigError(f"{label} 的 {key} 只能配置一种凭据来源。")
    name = found[0]
    value = table[name]
    if not isinstance(value, str) or not value or len(value) > 4096:
        raise ConfigError(f"{label}.{name} 必须是非空字符串。")
    if name.endswith("_env"):
        value = os.environ.get(value, "")
    elif name.endswith("_file"):
        try:
            with (config_dir / value).open("r", encoding="utf-8") as stream:
                value = stream.read(4097).rstrip("\r\n")
        except (OSError, UnicodeError, ValueError):
            raise ConfigError(f"无法读取 {label}.{name} 指定的凭据文件。") from None
    if not value or len(value) > 4096 or any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise ConfigError(f"{label}.{name} 未提供有效凭据。")
    return value


def load_config(path: Path) -> Config:
    try:
        with path.open("rb") as stream:
            raw = tomllib.load(stream)
    except (OSError, UnicodeError, tomllib.TOMLDecodeError):
        raise ConfigError("无法读取配置文件，或 TOML 格式无效。") from None

    monitor = object_or_error(raw.get("monitor", {}), "monitor")
    host = validate_host(monitor.get("host", "127.0.0.1"))
    port = validate_port(monitor.get("port", 8080))
    interval = monitor.get("interval_seconds", 30)
    timeout = monitor.get("timeout_seconds", 5)
    if not bounded_number(interval, 1, 3600):
        raise ConfigError("monitor.interval_seconds 必须在 1 到 3600 秒之间。")
    if not bounded_number(timeout, 0.1, 60):
        raise ConfigError("monitor.timeout_seconds 必须在 0.1 到 60 秒之间。")
    history_path = monitor.get("history_path", "history.sqlite3")
    if not isinstance(history_path, str) or not history_path.strip() or "\0" in history_path:
        raise ConfigError("monitor.history_path 必须是非空路径。")

    endpoints: dict[str, dict[str, Endpoint]] = {}
    networks = object_or_error(raw.get("networks", {}), "networks")
    if networks.keys() - set(NETWORKS):
        raise ConfigError("网络名称仅支持 mainnet 和 testnet3。")
    for network in NETWORKS:
        endpoints[network] = {}
        per_network = object_or_error(networks.get(network, {}), f"networks.{network}")
        if per_network.keys() - (LABELS.keys() | {"http"}):
            raise ConfigError(f"networks.{network} 包含不支持的服务。")
        for kind in LABELS:
            if kind not in per_network:
                continue
            label = f"networks.{network}.{kind}"
            table = object_or_error(per_network[kind], label)
            url = validate_url(table.get("url"), label)
            auth = None
            options = {}
            if kind == "btc":
                username = credential(table, "username", path.parent, label)
                password = credential(table, "password", path.parent, label)
                if (username is None) != (password is None):
                    raise ConfigError(f"{label} 的 RPC 用户名与密码必须同时配置。")
                if username is not None:
                    if ":" in username:
                        raise ConfigError(f"{label} 的 RPC 用户名不能包含冒号。")
                    pair = (username + ":" + password).encode("utf-8")
                    auth = "Basic " + base64.b64encode(pair).decode("ascii")
            elif kind == "spv":
                options = {key: value for key, value in table.items() if key != "url"}
            endpoints[network][kind] = Endpoint(url, auth, options)
        probes = per_network.get("http", [])
        if not isinstance(probes, list) or len(probes) > 8:
            raise ConfigError(f"networks.{network}.http 必须是数组，每个网络最多 8 项。")
        for probe in probes:
            label = f"networks.{network}.http"
            table = object_or_error(probe, label)
            ident, display = table.get("id"), table.get("label")
            if not isinstance(ident, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,39}", ident):
                raise ConfigError(f"{label}.id 必须是 1 至 40 个小写字母、数字或连字符。")
            if (not isinstance(display, str) or not 1 <= len(display.strip()) <= 80
                    or any(ord(c) < 32 for c in display)):
                raise ConfigError(f"{label}.label 必须是非空名称。")
            key = "http:" + ident
            if key in endpoints[network]:
                raise ConfigError(f"{label}.id 不可重复。")
            endpoints[network][key] = Endpoint(
                validate_url(table.get("url"), label), options={"label": display.strip()},
            )
    return Config(endpoints, host, port, interval, timeout, path.parent / history_path)


def read_json(
    url: str, timeout: float, payload: dict | None = None, authorization: str | None = None,
    *, extra_statuses: frozenset[int] = frozenset(),
) -> tuple[int, object]:
    """Connect directly (without proxies/redirects) and bound response body size."""
    parts = urlsplit(url)
    connection = (http.client.HTTPSConnection if parts.scheme == "https" else http.client.HTTPConnection)(
        parts.hostname, parts.port, timeout=timeout,
    )
    request_headers = {"Accept": "application/json", "User-Agent": "chain-sync-monitor/1"}
    body = None
    if payload is not None:
        request_headers["Content-Type"] = "application/json"
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    if authorization is not None:
        request_headers["Authorization"] = authorization
    deadline = time.monotonic() + timeout
    try:
        connection.request("POST" if payload is not None else "GET", parts.path or "/", body, request_headers)
        with connection.getresponse() as response:
            status = response.status
            if 300 <= status < 400:
                raise ProbeError("上游返回重定向，未跟随。")
            # Bitcoin Core legacy JSON-RPC may send structured errors with non-200 status.
            if status != 200 and status not in extra_statuses and (payload is None or status not in {400, 404, 500}):
                raise ProbeError(f"上游返回 HTTP {status}。")
            raw = bytearray()
            while len(raw) <= MAX_BODY:
                if time.monotonic() >= deadline:
                    raise TimeoutError
                chunk = response.read1(min(65536, MAX_BODY + 1 - len(raw)))
                if not chunk:
                    break
                raw.extend(chunk)
            if len(raw) > MAX_BODY:
                raise ProbeError("上游响应超过大小限制。")
    except TimeoutError:
        raise ProbeError("上游请求超时。", "offline") from None
    except (OSError, http.client.HTTPException, ValueError):
        raise ProbeError("无法连接上游或读取 HTTP 响应。", "offline") from None
    finally:
        connection.close()

    try:
        return status, json.loads(raw)
    except (ValueError, UnicodeError, RecursionError):
        if status != 200:
            raise ProbeError(f"上游返回 HTTP {status}。") from None
        raise ProbeError("上游没有返回有效的 JSON。") from None


def rpc(endpoint: Endpoint, timeout: float, method: str, params: list, *, bitcoin: bool = False):
    http_status, result = read_json(endpoint.url, timeout, {
        "jsonrpc": "1.0" if bitcoin else "2.0", "method": method, "params": params, "id": 1,
    }, endpoint.authorization)
    if (
        not isinstance(result, dict) or type(result.get("id")) is not int or result["id"] != 1
        or (not bitcoin and result.get("jsonrpc") != "2.0")
    ):
        if http_status != 200:
            raise ProbeError(f"上游返回 HTTP {http_status}。")
        raise ProbeError("上游返回的 RPC 响应格式不匹配。")
    error = result.get("error")
    if isinstance(error, dict) and type(error.get("code")) is int:
        raise RpcError(error["code"])
    if error is not None or "result" not in result or http_status != 200:
        raise ProbeError("上游返回的 RPC 响应格式不匹配。")
    return result["result"]


def nat(value, *, ckb: bool = False) -> int | None:
    if ckb and isinstance(value, str) and re.fullmatch(r"0x[0-9a-fA-F]{1,16}", value):
        value = int(value, 16)
    if type(value) is int and 0 <= value <= MAX_SAFE_INTEGER:
        return value
    return None


def progress_value(value) -> float | None:
    return float(value) if bounded_number(value, 0, 1) else None


def metric(label: str, value: int | float | str, unit: str | None = None) -> dict:
    return {"label": label, "value": value, **({"unit": unit} if unit else {})}


def reading(state: str, metrics=(), *, note: str | None = None, progress: float | None = None) -> dict:
    return {
        "state": state,
        "metrics": list(metrics),
        **({"note": note} if note else {}),
        **({"progress": progress} if progress is not None else {}),
    }


def format_seconds(timestamp: int) -> str | None:
    try:
        return datetime.fromtimestamp(timestamp, timezone.utc).isoformat(timespec="seconds")
    except (OverflowError, ValueError, OSError):
        return None


@dataclass(frozen=True)
class BitcoinTip:
    height: int
    headers: int
    hash: str | None
    synced: bool


def probe_bitcoin(network: str, endpoint: Endpoint, timeout: float) -> tuple[dict, BitcoinTip | None]:
    try:
        info = rpc(endpoint, timeout, "getblockchaininfo", [], bitcoin=True)
    except RpcError as error:
        if error.code == -28:
            return reading("syncing", note="Bitcoin Core 正在启动或加载数据。"), None
        raise
    if not isinstance(info, dict) or not isinstance(info.get("chain"), str):
        raise ProbeError("Bitcoin Core 未返回有效链信息。")
    if info["chain"] not in BTC_CHAINS[network]:
        return reading("degraded", note="Bitcoin Core 返回的网络与配置不符。"), None
    height = nat(info.get("blocks"))
    headers = nat(info.get("headers"))
    ibd = info.get("initialblockdownload")
    if height is None or headers is None or height > headers or type(ibd) is not bool:
        raise ProbeError("Bitcoin Core 未返回有效的区块高度、头高度或 IBD 状态。")

    best = info.get("bestblockhash")
    best = best.lower() if isinstance(best, str) and BTC_HASH.fullmatch(best) else None
    rows = [metric("已验证区块高度", height), metric("区块头高度", headers), metric("落后区块头", headers - height, "块")]
    block_time = nat(info.get("time"))
    if block_time and (stamp := format_seconds(block_time)):
        rows.append(metric("最新区块时间", stamp))
    syncing = ibd or headers > height
    return reading(
        "syncing" if syncing else "synced", rows,
        note="按本节点所见的区块头判断，不代表已核对外部网络高度。",
        progress=progress_value(info.get("verificationprogress")),
    ), BitcoinTip(height, headers, best, not syncing)


def probe_ckb(endpoint: Endpoint, timeout: float) -> tuple[dict, bool]:
    failures = []
    sync = indexer = None
    for method in ("sync_state", "get_indexer_tip"):
        try:
            value = rpc(endpoint, timeout, method, [])
            if method == "sync_state":
                if not isinstance(value, dict) or nat(value.get("tip_number"), ckb=True) is None or type(value.get("ibd")) is not bool:
                    raise ProbeError("同步状态格式不匹配。")
                sync = value
            else:
                if value is not None and (not isinstance(value, dict) or nat(value.get("block_number"), ckb=True) is None):
                    raise ProbeError("索引器高度格式不匹配。")
                indexer = value
        except ProbeError as error:
            failures.append((method, error))

    if len(failures) == 2:
        state = "offline" if all(error.state == "offline" for _, error in failures) else "degraded"
        return reading(state, note=" ".join(f"{method}：{error.note}" for method, error in failures)), False

    rows = []
    height = best = index = None
    ibd = False
    if sync is not None:
        height = nat(sync["tip_number"], ckb=True)
        best = nat(sync.get("best_known_block_number"), ckb=True)
        ibd = sync["ibd"]
        rows.append(metric("节点区块高度", height))
        if best is not None:
            # The best announced peer block can trail the local node.
            rows.append(metric("已知区块高度", best))
        if (unverified := nat(sync.get("unverified_tip_number"), ckb=True)) is not None:
            rows.append(metric("未验证区块高度", unverified))
        if (inflight := nat(sync.get("inflight_blocks_count"), ckb=True)) is not None:
            rows.append(metric("下载中", inflight, "块"))
    if indexer is not None:
        index = nat(indexer["block_number"], ckb=True)
        rows.append(metric("索引器高度", index))
    if height is not None and index is not None:
        rows.append(metric("索引器落后", max(0, height - index), "块"))
        tip_hash, index_hash = sync.get("tip_hash"), indexer.get("block_hash")
        if (
            height == index and isinstance(tip_hash, str) and CKB_HASH.fullmatch(tip_hash)
            and isinstance(index_hash, str) and CKB_HASH.fullmatch(index_hash)
            and tip_hash.lower() != index_hash.lower()
        ):
            return reading("degraded", rows, note="节点和索引器在同一高度报告了不同区块。"), True
    if failures:
        method, error = failures[0]
        return reading("degraded", rows, note=f"{method}：{error.note}"), sync is not None
    if index is None:
        return reading("syncing", rows, note="索引器还没有返回区块高度。"), True
    syncing = ibd or (best is not None and height < best) or index < height
    return reading("syncing" if syncing else "synced", rows), True


def load_blockbook(endpoint: Endpoint, timeout: float) -> dict:
    base = endpoint.url.rstrip("/")
    url = base + "/" if urlsplit(base).path.endswith("/api") else base + "/api/"
    _, result = read_json(url, timeout)
    if not isinstance(result, dict) or not isinstance(result.get("blockbook"), dict):
        raise ProbeError("Blockbook 未返回有效状态。")
    return result


def probe_blockbook(network: str, info: dict, tip: BitcoinTip | None) -> tuple[dict, int | None]:
    book = info["blockbook"]
    backend = info.get("backend")
    backend = backend if isinstance(backend, dict) else {}
    height = nat(book.get("bestHeight"))
    chain_sync, mempool_sync = book.get("inSync"), book.get("inSyncMempool")
    initial_sync = book.get("initialSync") is True
    rows = [metric("索引高度", height)] if height is not None else []
    if type(chain_sync) is bool:
        rows.append(metric("链同步", "是" if chain_sync else "否"))
    if type(mempool_sync) is bool:
        rows.append(metric("内存池同步", "是" if mempool_sync else "否"))

    if isinstance(backend.get("chain"), str) and backend["chain"] not in BTC_CHAINS[network]:
        return reading("degraded", rows, note="Blockbook 后端返回的 Bitcoin 网络与配置不符。"), None
    if backend.get("error"):
        return reading("degraded", rows, note="Blockbook 报告 Bitcoin 后端异常。"), height
    if type(chain_sync) is not bool or type(mempool_sync) is not bool:
        return reading("unknown", rows, note="Blockbook REST 尚未报告足够的同步状态。"), height

    if tip is not None and height is not None:
        rows.append(metric("配置的 Core 高度", tip.height))
        rows.append(metric("落后 Core", max(tip.height - height, 0), "块"))
        backend_height, backend_hash = nat(backend.get("blocks")), backend.get("bestBlockHash")
        if (
            backend_height == tip.height and tip.hash and isinstance(backend_hash, str)
            and BTC_HASH.fullmatch(backend_hash) and backend_hash.lower() != tip.hash
        ):
            return reading("degraded", rows, note="Blockbook 所连节点与配置的 Core 同高度区块哈希不同。"), height
    if initial_sync or not chain_sync or not mempool_sync or (tip is not None and height is not None and height < tip.height):
        return reading(
            "syncing", rows, note="以 Blockbook REST 报告为准；全量索引时高度可能不会持续刷新。",
            progress=min(1, height / tip.headers) if height is not None and tip is not None and tip.headers else None,
        ), height
    if height is None or tip is None or not tip.synced:
        return reading("unknown", rows, note="Blockbook 自报已同步，尚无同步的 Bitcoin Core 高度可核对。"), height
    if height > tip.height:
        return reading("degraded", rows, note="Blockbook 索引高度高于配置的 Core，请核对两者的后端。"), height
    return reading("synced", rows, note="同步标记正常，索引高度与配置的 Core 一致。"), height


def probe_spv_rpc(endpoint: Endpoint, timeout: float) -> tuple[dict, bool]:
    try:
        # Upstream requires three concrete arguments. No txid or proof request is supplied.
        rpc(endpoint, timeout, "getTxProof", [])
    except RpcError as error:
        if error.code == -32602:
            return reading("unknown", [metric("证明 RPC", "在线")], note="仅验证 RPC 可达，不能据此判断链上同步。"), True
        if error.code == -32601:
            return reading("degraded", [metric("RPC", "在线")], note="端点未公开 getTxProof。"), False
        raise
    return reading("unknown", [metric("RPC", "在线")], note="端点已响应，但未按预期拒绝空参数；同步仍未经验证。"), False


def service_record(network: str, key: str, data: dict, endpoint: Endpoint) -> dict:
    kind = "http" if key.startswith("http:") else key
    label = endpoint.options["label"] if kind == "http" else LABELS[kind]
    return {"id": f"{network}-{key}", "label": label, "network": network, "kind": kind, **data}


@dataclass(frozen=True)
class BaseObservation:
    value: object
    available: bool


def safe_probe(work, fallback=None):
    try:
        return work(), None
    except ProbeError as error:
        return fallback, reading(error.state, note=error.note)
    except Exception:
        # Never put a raw exception, upstream body, URL, or credentials into the dashboard.
        return fallback, reading("degraded", note="检查失败，未能取得有效数据。")


class Monitor:
    def __init__(self, config: Config, spv_hook=None, *, history: HistoryStore | None = None):
        self.config = config
        self.spv_hook = spv_hook
        self.history = history
        self.availability = {}
        self.history_error = None
        self._record_availability({})
        self.snapshot = self.build_snapshot(None, {})
        self.stopping = threading.Event()
        self.thread = threading.Thread(target=self.run, name="chain-sync-poller", daemon=True)
        self._book_observations = {}

    def build_snapshot(self, updated, observations: dict) -> dict:
        return {
            "updatedAt": updated,
            "intervalSeconds": self.config.interval_seconds,
            **({"historyError": self.history_error} if self.history_error else {}),
            "services": [
                service_record(network, kind, {
                    **observations.get((network, kind), reading("unknown", note="等待首次检查。")),
                    "availability": self.availability.get(f"{network}-{kind}", availability()),
                }, endpoint)
                for network in NETWORKS for kind, endpoint in self.config.endpoints[network].items()
            ],
        }

    def _record_availability(self, outcomes: dict[str, bool]) -> None:
        if self.history is None:
            return
        try:
            self.availability = self.history.observe(outcomes)
            self.history_error = None
        except RuntimeError:
            # Do not report missing history as downtime; retain live synchronization checks.
            self.availability = {}
            self.history_error = UNAVAILABLE_MESSAGE

    def _spv_onchain(self, net: str, endpoint: Endpoint, live: dict, tip: BitcoinTip | None) -> dict:
        if self.spv_hook is None or live["state"] != "unknown":
            return live
        ckb = self.config.endpoints[net].get("ckb")
        if not isinstance(ckb, Endpoint):
            return {**live, "note": "RPC 在线；请配置 CKB 端点以核对链上 SPV 高度。"}
        def ckb_rpc(method, params):
            return rpc(ckb, self.config.timeout_seconds, method, params)
        result, error = safe_probe(lambda: self.spv_hook(net, endpoint.options, ckb_rpc, tip.height if tip else None))
        if error:
            return {**live, "state": "degraded", "note": f"RPC 在线；链上状态检查未成功。{error['note']}"}
        if not isinstance(result, dict) or result.get("state") not in STATES or not isinstance(result.get("metrics"), list):
            return {**live, "state": "degraded", "note": "链上 SPV 检查未返回有效状态。"}
        if result["state"] == "synced" and (tip is None or not tip.synced):
            return reading(
                "unknown", [*live["metrics"], *result["metrics"]],
                note="尚无已同步的本地 Bitcoin Core 高度可核对；SPV RPC 不提供内部缓存高度。",
            )
        return reading(
            result["state"], [*live["metrics"], *result["metrics"]],
            note=result.get("note") or live.get("note"), progress=progress_value(result.get("progress")),
        )

    def _base_probe(self, network: str, kind: str, endpoint: Endpoint) -> BaseObservation:
        timeout = self.config.timeout_seconds
        if kind == "btc":
            result = probe_bitcoin(network, endpoint, timeout)
            # Bitcoin Core's documented warmup response has no tip, but it proves
            # the expected base application RPC is responding.
            available = result[1] is not None or result[0]["state"] == "syncing"
            return BaseObservation(result, available)
        if kind == "ckb":
            return BaseObservation(*probe_ckb(endpoint, timeout))
        if kind == "blockbook":
            info = load_blockbook(endpoint, timeout)
            status = info["blockbook"]
            backend = info.get("backend")
            chain = backend.get("chain") if isinstance(backend, dict) else None
            available = (
                (chain is None or isinstance(chain, str) and chain in BTC_CHAINS[network])
                and nat(status.get("bestHeight")) is not None
                and type(status.get("inSync")) is bool
                and type(status.get("inSyncMempool")) is bool
            )
            return BaseObservation(info, available)
        if kind == "spv":
            return BaseObservation(*probe_spv_rpc(endpoint, timeout))
        if kind == "ckbadger":
            status, payload = read_json(endpoint.url, timeout, extra_statuses=frozenset({503}))
            if status == 503:
                if isinstance(payload, dict) and payload.get("error") == "initializing":
                    return BaseObservation(reading("syncing", note="CKBadger 正在初始化索引。"), False)
                raise ProbeError("CKBadger 返回 HTTP 503。")
            try:
                return BaseObservation(ckbadger(payload), True)
            except ValueError:
                raise ProbeError("CKBadger 未返回有效的网络同步状态。") from None
        if kind.startswith("http:"):
            try:
                status, ms = http_probe(endpoint.url, timeout)
            except (OSError, http.client.HTTPException, ValueError):
                raise ProbeError("HTTP 探测连接失败或超时。", "offline") from None
            available = 200 <= status < 300
            return BaseObservation(
                reading("online" if available else "degraded",
                        [metric("HTTP 状态", status), metric("响应时间", ms, "ms")],
                        note=None if available else "HTTP 探测要求 2xx，不跟随重定向。"),
                available,
            )
        raise ProbeError("不支持的探测类型。")

    def poll(self) -> dict:
        observations = {}
        with ThreadPoolExecutor(max_workers=8, thread_name_prefix="rpc-probe") as executor:
            jobs = {
                (network, kind): executor.submit(safe_probe, lambda n=network, k=kind, e=endpoint: self._base_probe(n, k, e))
                for network, endpoints in self.config.endpoints.items() for kind, endpoint in endpoints.items()
            }
            results = {key: future.result() for key, future in jobs.items()}
            self._record_availability({
                f"{network}-{kind}": probe is not None and probe.available
                for (network, kind), (probe, _failure) in results.items()
            })
            raw = {
                key: (probe.value if probe is not None else None, failure)
                for key, (probe, failure) in results.items()
            }
            spv_jobs = {}
            for network in NETWORKS:
                value, failure = raw.get((network, "btc"), (None, None))
                tip = None
                if value is not None:
                    observations[network, "btc"], tip = value
                elif failure:
                    observations[network, "btc"] = failure
                for kind in self.config.endpoints[network]:
                    if kind == "btc":
                        continue
                    value, failure = raw.get((network, kind), (None, None))
                    key = network, kind
                    if failure is not None:
                        observations[key] = failure
                        if kind == "blockbook":
                            self._book_observations.pop(network, None)
                    elif value is not None and kind == "blockbook":
                        (result, height), failure = safe_probe(
                            lambda: probe_blockbook(network, value, tip), (None, None),
                        )
                        observations[key] = failure or self._track_blockbook(network, result, height)
                    elif value is not None and kind == "spv":
                        endpoint = self.config.endpoints[network][kind]
                        spv_jobs[key] = executor.submit(self._spv_onchain, network, endpoint, value, tip)
                    elif value is not None:
                        observations[key] = value
            observations.update((key, future.result()) for key, future in spv_jobs.items())
        self.snapshot = self.build_snapshot(datetime.now(timezone.utc).isoformat(timespec="seconds"), observations)
        return self.snapshot

    def _track_blockbook(self, network: str, record: dict, height: int | None) -> dict:
        if height is None or record["state"] != "syncing":
            self._book_observations.pop(network, None)
            return record
        now = time.monotonic()
        previous_height, since = self._book_observations.get(network, (None, now))
        if height != previous_height:
            since = now
        self._book_observations[network] = height, since
        if (minutes := int((now - since) / 60)) >= 5:
            record["metrics"].append(metric("REST 高度未更新", minutes, "分钟"))
        return record

    def run(self) -> None:
        while not self.stopping.is_set():
            start = time.monotonic()
            try:
                self.poll()
            except Exception:
                # Keep the last completed snapshot and its age visible until the next poll.
                print("Monitor poll did not complete.", file=sys.stderr, flush=True)
            remaining = max(0.0, self.config.interval_seconds - (time.monotonic() - start))
            self.stopping.wait(remaining)


def handler_for(monitor: Monitor, static_dir: Path):
    assets = {
        route: (content_type, (static_dir / filename).read_bytes())
        for route, (filename, content_type) in ASSETS.items()
    }
    class Handler(BaseHTTPRequestHandler):
        server_version = "ChainSyncMonitor"
        sys_version = ""

        def log_message(self, *_):
            # Avoid logging arbitrary request targets supplied by browsers.
            pass

        def do_GET(self):
            self.respond()

        def do_HEAD(self):
            self.respond()

        def respond(self):
            # Never treat query strings, paths, or headers as upstream configuration.
            if self.path == "/api/status":
                mime = "application/json; charset=utf-8"
                data = json.dumps(monitor.snapshot, ensure_ascii=False, allow_nan=False).encode("utf-8")
                status = 200
            elif self.path in assets:
                mime, data = assets[self.path]
                status = 200
            else:
                mime, data, status = "text/plain; charset=utf-8", b"Not found.\n", 404
            self.send_response(status)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Content-Security-Policy", "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(data)
    return Handler


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=Path("config.toml"))
    parser.add_argument("--host")
    parser.add_argument("--port", type=int)
    parser.add_argument("--history", type=Path, help="Override the SQLite availability history path")
    args = parser.parse_args()
    try:
        config = load_config(args.config)
        if args.host is not None:
            config = replace(config, host=validate_host(args.host))
        if args.port is not None:
            config = replace(config, port=validate_port(args.port))
        if args.history is not None:
            config = replace(config, history_path=args.history)
    except ConfigError as error:
        parser.exit(2, str(error) + "\n")

    hook = None
    try:
        hook = importlib.import_module("spv_probe").probe
    except ModuleNotFoundError as error:
        if error.name != "spv_probe":
            raise

    monitor = Monitor(config, hook, history=HistoryStore(config.history_path))
    try:
        server = ThreadingHTTPServer(
            (config.host, config.port), handler_for(monitor, Path(__file__).resolve().parent / "static"),
        )
    except OSError:
        parser.exit(1, "无法启动监听或读取静态页面。\n")

    def stop(_signum, _frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, stop)
    monitor.thread.start()
    try:
        print(f"Monitor listening on {config.host}:{config.port}", flush=True)
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        monitor.stopping.set()
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
