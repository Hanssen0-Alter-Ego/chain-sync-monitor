"""Optional HTTP probes for CKBadger and non-chain services."""
import http.client
import time
from urllib.parse import urlsplit


def http_probe(url, timeout):
    """Status-only GET. Do not follow redirects, forward auth or read the body."""
    parts = urlsplit(url)
    connection = (http.client.HTTPSConnection if parts.scheme == "https"
                  else http.client.HTTPConnection)(parts.hostname, parts.port, timeout=timeout)
    start = time.monotonic()
    try:
        connection.request("GET", parts.path or "/", headers={"User-Agent": "chain-sync-monitor/1"})
        with connection.getresponse() as response:
            return response.status, round((time.monotonic() - start) * 1000)
    finally:
        connection.close()


def ckbadger(result):
    """Normalize the read-only /api/v1/statistics/network response."""
    sync = result.get("syncStatus") if isinstance(result, dict) else None
    if not isinstance(sync, dict):
        raise ValueError("missing CKBadger sync status")
    height, target = sync.get("syncedBlock"), sync.get("tipBlock")
    if any(type(value) is not int or not 0 <= value <= 2**53 - 1 for value in (height, target)):
        raise ValueError("invalid CKBadger block heights")
    rows = [
        {"label": "索引高度", "value": height},
        {"label": "CKB 目标高度", "value": target},
    ]
    fork = result.get("deepForkStatus")
    if isinstance(fork, dict) and fork.get("detected") is True:
        return {"state": "degraded", "metrics": rows, "note": "CKBadger 报告深度分叉。"}
    if height > target:
        return {"state": "unknown", "metrics": rows, "note": "目标高度低于索引高度，暂时无法比较。"}
    lag = target - height
    rows.append({"label": "落后", "value": lag, "unit": "块"})
    mode = sync.get("syncMode")
    if mode in ("bulk", "normal", "synced"):
        rows.append({"label": "索引模式", "value": mode})
    if sync.get("isSyncing") is True or lag:
        state = "syncing"
    elif sync.get("isSyncing") is False and target > 0:
        state = "synced"
    else:
        state = "unknown"
    out = {"state": state, "metrics": rows}
    if target:
        out["progress"] = height / target
    return out
