import { type BitcoinIndexName, type BitcoinIndexReading, type BitcoinIndexes, type Metric, type Network, type Reading, type State } from "../../shared/status.js";
import { record, type Endpoint } from "./config.js";
import { ProbeError, RpcError, readJson, rpc, statusOnly } from "./http.js";

const btcChains: Record<Network, string[]> = { mainnet: ["main"], testnet3: ["test", "testnet3"] };
const btcHash = /^[0-9a-f]{64}$/i;
const ckbHash = /^0x[0-9a-f]{64}$/i;

export function nat(value: unknown, ckb = false): number | undefined {
  if (ckb && typeof value === "string" && /^0x[0-9a-f]{1,16}$/i.test(value)) value = Number(value);
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
export function fraction(value: unknown) {
  return typeof value === "number" && value >= 0 && value <= 1 ? value : undefined;
}
export function metric(label: string, value: Metric["value"], unit?: string): Metric { return { label, value, unit }; }
export function reading(state: State, metrics: Metric[] = [], note?: string, progress?: number): Reading {
  return { state, metrics, note, progress };
}
export interface BitcoinTip { height: number; headers: number; hash?: string; synced: boolean }
export interface Observation {
  reading: Reading;
  available: boolean;
  tip?: BitcoinTip;
  spvStatus?: SpvStatus;
}
export type BaseProbe = Observation | { book: Record<string, unknown>; backend: Record<string, unknown>; available: boolean };

function bitcoinTip(info: Record<string, unknown> | undefined): BitcoinTip | undefined {
  const height = nat(info?.blocks), headers = nat(info?.headers), ibd = info?.initialblockdownload;
  if (height === undefined || headers === undefined || height > headers || typeof ibd !== "boolean") return;
  const value = info?.bestblockhash;
  const hash = typeof value === "string" && btcHash.test(value) ? value.toLowerCase() : undefined;
  return { height, headers, hash, synced: !ibd && headers === height };
}

async function readBitcoinIndexes(endpoint: Endpoint, timeout: number): Promise<BitcoinIndexes> {
  // getindexinfo only lists running indexes. Errors (e.g. unavailable method or
  // RPC allowlist) don't establish whether any index is enabled.
  let result: Record<string, unknown> | undefined;
  try { if (timeout > 0) result = record(await rpc(endpoint, timeout, "getindexinfo", [], true)); }
  catch { /* The chain probe remains valid even when this optional call fails. */ }
  function index(name: BitcoinIndexName): BitcoinIndexReading {
    if (!result) return { state: "unavailable" };
    if (!Object.hasOwn(result, name)) return { state: "disabled" };
    const entry = record(result[name]);
    const height = nat(entry?.best_block_height);
    if (height === undefined || typeof entry?.synced !== "boolean") return { state: "unavailable" };
    return { state: entry.synced ? "synced" : "syncing", height };
  }
  return { txindex: index("txindex"), txospenderindex: index("txospenderindex") };
}

async function bitcoin(network: Network, endpoint: Endpoint, timeout: number): Promise<Observation> {
  const start = performance.now();
  let info;
  try { info = record(await rpc(endpoint, timeout, "getblockchaininfo", [], true)); }
  catch (error) {
    if (error instanceof RpcError && error.code === -28) {
      return { reading: reading("syncing", [], "Bitcoin Core 正在启动或加载数据。"), available: true };
    }
    throw error;
  }
  if (!info || typeof info.chain !== "string") throw new ProbeError("Bitcoin Core 未返回有效链信息。");
  if (!btcChains[network].includes(info.chain)) {
    return { reading: reading("degraded", [], "Bitcoin Core 返回的网络与配置不符。"), available: false };
  }
  const tip = bitcoinTip(info);
  if (!tip) throw new ProbeError("Bitcoin Core 未返回有效的区块高度、头高度或 IBD 状态。");
  const { height, headers, synced } = tip;
  const rows = [metric("已验证区块高度", height), metric("区块头高度", headers), metric("落后区块头", headers - height, "块")];
  const stamp = new Date((nat(info.time) ?? 0) * 1000);
  if (stamp.getTime()) rows.push(metric("最新区块时间", stamp.toISOString()));
  const bitcoinIndexes = await readBitcoinIndexes(endpoint, timeout - (performance.now() - start) / 1000);
  const indexLags = Object.values(bitcoinIndexes).flatMap(index => index.state === "syncing" ? [headers - index.height] : []);
  const syncTipLag = !info.initialblockdownload && !Object.values(bitcoinIndexes).some(index =>
    index.state === "unavailable" || index.state === "syncing" && index.height > height)
    ? Math.max(headers - height, ...indexLags) : undefined;
  return {
    reading: {
      ...reading(synced ? "synced" : "syncing", rows,
        "按本节点所见的区块头判断，不代表已核对外部网络高度。", fraction(info.verificationprogress)),
      bitcoinIndexes, syncTipLag,
    },
    available: true, tip,
  };
}
async function ckb(endpoint: Endpoint, timeout: number): Promise<Observation> {
  const sync = async () => {
    const result = record(await rpc(endpoint, timeout, "sync_state"));
    const height = nat(result?.tip_number, true);
    if (!result || height === undefined || typeof result.ibd !== "boolean") throw new ProbeError("同步状态格式不匹配。");
    return { result, height, ibd: result.ibd };
  };
  const indexer = async () => {
    const data = await rpc(endpoint, timeout, "get_indexer_tip");
    if (data === null) return undefined;
    const result = record(data);
    const height = nat(result?.block_number, true);
    if (!result || height === undefined) throw new ProbeError("索引器高度格式不匹配。");
    return { result, height };
  };
  const [syncResult, indexResult] = await Promise.allSettled([sync(), indexer()]);
  const s = syncResult.status === "fulfilled" ? syncResult.value : undefined;
  const i = indexResult.status === "fulfilled" ? indexResult.value : undefined;
  const errors = [syncResult, indexResult].flatMap((result, at) => {
    if (result.status !== "rejected") return [];
    const error: unknown = result.reason;
    return [{ offline: error instanceof ProbeError && error.state === "offline",
      note: `${at === 0 ? "sync_state" : "get_indexer_tip"}：${error instanceof ProbeError ? error.note : "检查失败。"}` }];
  });
  const rows: Metric[] = [];
  const best = nat(s?.result.best_known_block_number, true);
  if (s) {
    rows.push(metric("节点区块高度", s.height));
    if (best !== undefined) rows.push(metric("已知区块高度", best));
    const unverified = nat(s.result.unverified_tip_number, true);
    if (unverified !== undefined) rows.push(metric("未验证区块高度", unverified));
    const inflight = nat(s.result.inflight_blocks_count, true);
    if (inflight !== undefined) rows.push(metric("下载中", inflight, "块"));
  }
  if (i) rows.push(metric("索引器高度", i.height));
  if (s && i) {
    rows.push(metric("索引器落后", Math.max(0, s.height - i.height), "块"));
    const actual = s.result.tip_hash, indexed = i.result.block_hash;
    if (s.height === i.height && typeof actual === "string" && typeof indexed === "string"
        && ckbHash.test(actual) && ckbHash.test(indexed) && actual.toLowerCase() !== indexed.toLowerCase()) {
      return { reading: reading("degraded", rows, "节点和索引器在同一高度报告了不同区块。"), available: true };
    }
  }
  if (errors.length) {
    return {
      reading: reading(errors.length === 2 && errors.every((error) => error.offline) ? "offline" : "degraded",
        rows, errors.map((error) => error.note).join(" ")),
      available: !!s,
    };
  }
  if (!i) return { reading: reading("syncing", rows, "索引器还没有返回区块高度。"), available: true };
  const syncing = s && (s.ibd || (best !== undefined && s.height < best) || i.height < s.height);
  const syncTipLag = s && !s.ibd && best !== undefined && best >= s.height && s.height >= i.height
    ? best - i.height : undefined;
  return { reading: { ...reading(syncing ? "syncing" : "synced", rows), syncTipLag }, available: true };
}
async function blockbook(network: Network, endpoint: Endpoint, timeout: number): Promise<BaseProbe> {
  const base = endpoint.url.replace(/\/+$/, "");
  const { data } = await readJson(base + (new URL(base).pathname.endsWith("/api") ? "/" : "/api/"), timeout);
  const answer = record(data), book = record(answer?.blockbook), backend = record(answer?.backend) ?? {};
  if (!book) throw new ProbeError("Blockbook 未返回有效状态。");
  return { book, backend, available: (backend.chain == null || typeof backend.chain === "string" && btcChains[network].includes(backend.chain))
      && nat(book.bestHeight) !== undefined && typeof book.inSync === "boolean" && typeof book.inSyncMempool === "boolean" };
}
export function compareBlockbook(network: Network, book: Record<string, unknown>, backend: Record<string, unknown>,
  tip?: BitcoinTip): { result: Reading; height?: number } {
  const height = nat(book.bestHeight), chainSync = book.inSync, mempoolSync = book.inSyncMempool;
  const rows = height === undefined ? [] : [metric("索引高度", height)];
  const done = (state: State, note: string, progress?: number, syncTipLag?: number) => ({
    result: { ...reading(state, rows, note, progress), syncTipLag }, height,
  });
  if (typeof chainSync === "boolean") rows.push(metric("链同步", chainSync ? "是" : "否"));
  if (typeof mempoolSync === "boolean") rows.push(metric("内存池同步", mempoolSync ? "是" : "否"));
  if (typeof backend.chain === "string" && !btcChains[network].includes(backend.chain)) {
    return done("degraded", "Blockbook 后端返回的 Bitcoin 网络与配置不符。");
  }
  if (backend.error) return done("degraded", "Blockbook 报告 Bitcoin 后端异常。");
  if (typeof chainSync !== "boolean" || typeof mempoolSync !== "boolean") {
    return done("unknown", "Blockbook REST 尚未报告足够的同步状态。");
  }
  const hash = backend.bestBlockHash;
  const reportedTip = typeof backend.chain === "string" && btcChains[network].includes(backend.chain)
    ? nat(backend.blocks) : undefined;
  if (tip && height !== undefined) {
    if (reportedTip === tip.height && tip.hash && typeof hash === "string" && btcHash.test(hash) && hash.toLowerCase() !== tip.hash) {
      return done("degraded", "Blockbook 所连节点与配置的 Core 同高度区块哈希不同。");
    }
    rows.push(metric("配置的 Core 高度", tip.height));
    if (height <= tip.height) rows.push(metric("落后 Core", tip.height - height, "块"));
  } else if (reportedTip !== undefined) {
    rows.push(metric("Blockbook 上游高度", reportedTip));
  }
  const verifiedGap = book.initialSync === false && mempoolSync && tip?.synced && height !== undefined && height <= tip.height
    && (chainSync || height < tip.height) ? tip.height - height : undefined;
  if (book.initialSync === true || !chainSync || !mempoolSync || (tip && height !== undefined && height < tip.height)) {
    return done("syncing", "以 Blockbook REST 报告为准；全量索引时高度可能不会持续刷新。",
      height !== undefined && tip?.headers ? Math.min(1, height / tip.headers) : undefined, verifiedGap);
  }
  if (height === undefined || !tip?.synced) return done("unknown", "Blockbook 自报已同步，尚无同步的 Bitcoin Core 高度可核对。");
  if (height > tip.height) return done("degraded", "Blockbook 索引高度高于配置的 Core，请核对两者的后端。");
  return done("synced", "同步标记正常，索引高度与配置的 Core 一致。", undefined, verifiedGap);
}
function ckbadger(payload: unknown) {
  const data = record(payload), sync = record(data?.syncStatus);
  const height = nat(sync?.syncedBlock), target = nat(sync?.tipBlock);
  if (!sync || height === undefined || target === undefined) throw new ProbeError("CKBadger 未返回有效的网络同步状态。");
  const rows = [metric("索引高度", height), metric("CKB 目标高度", target)];
  if (record(data?.deepForkStatus)?.detected === true) return reading("degraded", rows, "CKBadger 报告深度分叉。");
  if (height > target) return reading("unknown", rows, "目标高度低于索引高度，暂时无法比较。");
  const lag = target - height;
  rows.push(metric("落后", lag, "块"));
  const mode = sync.syncMode;
  if (mode === "bulk" || mode === "normal" || mode === "synced") rows.push(metric("索引模式", mode));
  return {
    ...reading(sync.isSyncing === true || lag ? "syncing" : sync.isSyncing === false && target > 0 ? "synced" : "unknown",
      rows, undefined, target ? height / target : undefined),
    syncTipLag: (mode === "normal" || mode === "synced") && typeof sync.isSyncing === "boolean" && target > 0 ? lag : undefined,
  };
}
type ObservedHeight = { height: number; observedAt?: string };
interface SpvStatus {
  bitcoin?: ObservedHeight;
  local?: ObservedHeight;
  confirmed?: ObservedHeight & { start: number };
}
function spvObservation(value: unknown, heightKey: "height" | "endHeight"): ObservedHeight | undefined {
  const fields = record(value);
  const height = nat(fields?.[heightKey]);
  if (height === undefined || height > 0xffff_ffff) return;
  const epoch = nat(fields?.observedAt);
  const timestamp = epoch === undefined ? undefined : new Date(epoch * 1000);
  return { height, observedAt: timestamp && Number.isFinite(timestamp.valueOf()) ? timestamp.toISOString() : undefined };
}
async function spvStatus(endpoint: Endpoint, timeout: number): Promise<SpvStatus | undefined> {
  try {
    const response = record(await rpc(endpoint, timeout, "getSyncStatus"));
    if (!response || !["bitcoinTip", "localHeaderTip", "confirmedClient"].every(key => Object.hasOwn(response, key))) return;
    const bitcoin = spvObservation(response.bitcoinTip, "height");
    const local = spvObservation(response.localHeaderTip, "height");
    const client = spvObservation(response.confirmedClient, "endHeight");
    const start = nat(record(response.confirmedClient)?.startHeight);
    const confirmed = client && start !== undefined && start <= client.height ? { ...client, start } : undefined;
    return { bitcoin, local, confirmed };
  } catch { return; }
}
async function spvProof(endpoint: Endpoint, timeout: number): Promise<Observation> {
  try { await rpc(endpoint, timeout, "getTxProof"); }
  catch (error) {
    if (error instanceof RpcError && error.code === -32602) {
      return { reading: reading("unknown", [metric("证明 RPC", "在线")], "仅验证 RPC 可达，不能据此判断链上同步。"), available: true };
    }
    if (error instanceof RpcError && error.code === -32601) {
      return { reading: reading("degraded", [metric("RPC", "在线")], "端点未公开 getTxProof。"), available: false };
    }
    return { reading: error instanceof ProbeError ? reading(error.state, [], error.note)
      : reading("degraded", [], "检查失败，未能取得有效数据。"), available: false };
  }
  return { reading: reading("unknown", [metric("RPC", "在线")], "端点未按预期拒绝空参数；同步仍未经验证。"), available: false };
}
function observedMetric(label: string, observation: ObservedHeight): Metric {
  return { ...metric(label, observation.height), observedAt: observation.observedAt };
}
export function mergeSpvStatus(live: Reading, status: SpvStatus | undefined, btc: BitcoinTip | undefined): Reading {
  if (!status) return live;
  const metrics = [...live.metrics];
  if (status.local) metrics.push(observedMetric("本地 SPV 高度", status.local));
  if (btc) {
    if (!metrics.some(row => row.label === "本地 BTC 高度")) metrics.push(metric("本地 BTC 高度", btc.height));
  } else if (status.bitcoin) metrics.push(observedMetric("SPV 观测的 BTC 高度", status.bitcoin));
  if (status.confirmed && !metrics.some(row => row.label === "链上 SPV 高度")) {
    metrics.push(observedMetric("SPV 缓存的链上高度", status.confirmed), metric("SPV 缓存的起始 BTC 高度", status.confirmed.start));
  }
  return { ...live, metrics };
}
export async function inspectOnchain(
  network: Network, endpoint: Endpoint, ckb: Endpoint | undefined, bitcoin: Endpoint | undefined,
  btc: BitcoinTip | undefined, timeout: number, live: Reading, hasLocal: boolean,
  confirmMismatch: (fingerprint: string) => boolean,
): Promise<Reading> {
  const scriptValue = endpoint.typeScript;
  const deadline = performance.now() + timeout * 1000;
  const remaining = () => {
    const seconds = (deadline - performance.now()) / 1000;
    if (seconds <= 0) throw new ProbeError("上游请求超时。", "offline");
    return seconds;
  };
  if (scriptValue === undefined) return { ...live, note: "RPC 在线；配置 code_hash、hash_type 和 args 可查看链上 SPV 高度。" };
  if (!ckb) return { ...live, note: "RPC 在线；请配置 CKB 端点以核对链上 SPV 高度。" };
  try {
    const page = record(await rpc(ckb, timeout, "get_cells", [
      { script: scriptValue, script_type: "type", script_search_mode: "exact", with_data: true },
      "asc", "0x101",
    ]));
    if (!Array.isArray(page?.objects) || page.objects.length > 256) throw new ProbeError("链上 SPV 查询未返回有效结果。");
    const ids: number[] = [];
    const clients = new Map<number, { first: number; tip: number; hash: string }>();
    for (const object of page.objects as unknown[]) {
      const data = record(object)?.output_data;
      if (typeof data !== "string" || !/^0x(?:[0-9a-f]{2})+$/i.test(data)) throw new ProbeError("链上 SPV Cell 格式无效。");
      const bytes = Buffer.from(data.slice(2), "hex");
      if (bytes.length === 1) ids.push(bytes[0]);
      else if (bytes.length === 113 && !clients.has(bytes[0])) clients.set(bytes[0], {
        first: bytes.readUInt32LE(33), tip: bytes.readUInt32LE(37),
        // The packed Bitcoin block hash is in internal byte order, unlike Core's RPC hex.
        hash: Buffer.from(bytes.subarray(1, 33)).reverse().toString("hex"),
      });
      else throw new ProbeError("出现未知或重复的 SPV Cell。");
    }
    const active = clients.get(ids[0]);
    if (ids.length !== 1 || clients.size !== parseInt(scriptValue.args.slice(66, 68), 16) || !active || active.first > active.tip) {
      throw new ProbeError("SPV 实例在 CKB 索引器中尚未完整可见。");
    }
    const { first, tip, hash } = active;
    const metrics = [...live.metrics, metric("链上 SPV 高度", tip), metric("起始 BTC 高度", first), metric("SPV 客户端数", clients.size)];
    const reference = endpoint.bitcoinReference ?? bitcoin;
    let observed = btc;
    let coreHash: string | undefined;
    try {
      if (endpoint.bitcoinReference) {
        const info = record(await rpc(endpoint.bitcoinReference, remaining(), "getblockchaininfo", [], true));
        observed = typeof info?.chain === "string" && btcChains[network].includes(info.chain) ? bitcoinTip(info) : undefined;
      }
      if (observed?.synced && observed.height >= tip && reference) {
        const value = observed.height === tip && observed.hash !== undefined
          ? observed.hash : await rpc(reference, remaining(), "getblockhash", [tip], true);
        if (typeof value === "string" && btcHash.test(value)) coreHash = value.toLowerCase();
      }
    } catch { /* A missing or invalid reference observation is not a disagreement. */ }

    const compare = (value: string) => metrics.push(metric("SPV 区块哈希校验", value));
    const note = hasLocal ? undefined : "SPV RPC 未提供本地缓存高度。";
    const lag = observed && observed.height >= tip ? observed.height - tip : undefined;
    if (observed) metrics.push(metric(endpoint.bitcoinReference ? "参考 BTC 高度" : "本地 BTC 高度", observed.height));
    if (lag !== undefined) metrics.push(metric("SPV 落后", lag, "块"));
    if (!coreHash || !observed || lag === undefined) {
      compare("暂不可比");
      return reading("unknown", metrics, note);
    }
    if (coreHash !== hash) {
      const confirmed = confirmMismatch(`${tip}:${hash}:${coreHash}`);
      compare(confirmed ? "确认分歧" : "等待复查");
      return reading(confirmed ? "degraded" : "unknown", metrics);
    }
    compare("一致");
    return {
      ...reading(lag ? "syncing" : "synced", metrics, note,
        observed.height > first ? (tip - first) / (observed.height - first) : undefined),
      syncTipLag: lag,
    };
  } catch (error) {
    return { ...live, state: "degraded", note: "RPC 在线；链上检查未成功。" + (error instanceof ProbeError ? error.note : "") };
  }
}
export async function probe(network: Network | undefined, endpoint: Endpoint, timeout: number): Promise<BaseProbe> {
  try {
    switch (endpoint.kind) {
      case "btc": return network ? await bitcoin(network, endpoint, timeout) : { reading: reading("unknown", []), available: false };
      case "ckb": return await ckb(endpoint, timeout);
      case "blockbook": return network ? await blockbook(network, endpoint, timeout) : { reading: reading("unknown", []), available: false };
      case "ckbadger": {
        const { status, data } = await readJson(endpoint.url, timeout, { extra: [503] });
        if (status === 503) {
          if (record(data)?.error === "initializing") return { reading: reading("syncing", [], "CKBadger 正在初始化索引。"), available: false };
          throw new ProbeError("CKBadger 返回 HTTP 503。");
        }
        return { reading: ckbadger(data), available: true };
      }
      case "dob_decoder": {
        const versions = await rpc(endpoint, timeout, "dob_protocol_version");
        if (!Array.isArray(versions) || !versions.length || versions.length > 32
            || !versions.every(version => typeof version === "string" && /^dob\/[0-9]{1,9}$/.test(version))) {
          throw new ProbeError("DOB Decoder 未返回有效的协议版本。");
        }
        return { reading: reading("online", [metric("DOB 协议版本", [...new Set(versions)].join(", "))]), available: true };
      }
      case "http": {
        const {status, ms} = await statusOnly(endpoint.url, timeout);
        const available = status >= 200 && status < 300;
        return { reading: reading(available ? "online" : "degraded", [metric("HTTP 状态", status), metric("响应时间", ms, "ms")],
          available ? undefined : "HTTP 探测要求 2xx，不跟随重定向。"), available };
      }
      case "spv": {
        const [proof, status] = await Promise.all([spvProof(endpoint, timeout), spvStatus(endpoint, timeout)]);
        return { ...proof, spvStatus: status };
      }
    }
  } catch (error) {
    return { reading: error instanceof ProbeError ? reading(error.state, [], error.note)
      : reading("degraded", [], "检查失败，未能取得有效数据。"), available: false };
  }
}
