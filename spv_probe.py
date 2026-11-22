"""Read the active SPV client cell from the configured CKB instance."""
import re
import struct

CODE = re.compile(r"0x[0-9a-fA-F]{64}")
ARGS = re.compile(r"0x[0-9a-fA-F]{68}")


def probe(network, config, ckb_rpc, btc_tip):
    script = config.get("type_script")
    if not script:
        return {"state": "unknown", "metrics": [],
                "note": "RPC reachable. Configure type_script to track the on-chain SPV tip."}
    if (not isinstance(script, dict)
            or not CODE.fullmatch(str(script.get("code_hash", "")))
            or not ARGS.fullmatch(str(script.get("args", "")))
            or script.get("hash_type") not in {"type", "data", "data1", "data2"}):
        return {"state": "degraded", "metrics": [],
                "note": "Invalid SPV type_script (expected 32-byte code hash and 34-byte args)."}
    if not ckb_rpc:
        return {"state": "degraded", "metrics": [], "note": "No CKB RPC configured for this SPV instance."}

    key = {"script": {k: script[k] for k in ("code_hash", "hash_type", "args")},
           "script_type": "type", "script_search_mode": "exact", "with_data": True}
    # An SPV instance has at most 255 clients plus one info cell.
    # A single response avoids mixing states from multiple pages during an update.
    page = ckb_rpc("get_cells", [key, "asc", "0x101"])
    info = []
    clients = {}
    for obj in page["objects"]:
        data = bytes.fromhex(obj["output_data"][2:])
        if len(data) == 1:
            info.append(data[0])
        elif len(data) == 113 and data[0] not in clients:
            clients[data[0]] = struct.unpack_from("<II", data, 33)
        else:
            raise ValueError("unexpected or duplicate SPV cell")
    expected = int(script["args"][66:68], 16)
    if len(info) != 1 or len(clients) != expected or info[0] not in clients:
        return {"state": "degraded", "metrics": [],
                "note": "SPV instance not fully visible in the CKB indexer."}

    first, tip = clients[info[0]]
    if first > tip:
        raise ValueError("invalid SPV header range")
    metrics = [{"label": "On-chain SPV tip", "value": tip},
               {"label": "First covered BTC height", "value": first},
               {"label": "SPV clients", "value": len(clients)}]
    note = "Local SPV cache height is not exposed by this SPV RPC."
    if btc_tip is None or btc_tip < tip:
        return {"state": "unknown", "metrics": metrics,
                "note": ("BTC comparison unavailable. " if btc_tip is None
                         else "BTC node is behind the SPV tip. ") + note}
    gap = btc_tip - tip
    metrics.extend([{"label": "Local BTC tip", "value": btc_tip},
                    {"label": "SPV lag", "value": gap, "unit": "blocks"}])
    result = {"state": "synced" if gap == 0 else "syncing", "metrics": metrics, "note": note}
    if btc_tip > first:
        result["progress"] = (tip - first) / (btc_tip - first)
    return result
