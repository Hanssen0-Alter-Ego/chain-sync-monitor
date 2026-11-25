import type { Kind, Service, Snapshot } from "../../shared/status.js";

// An older backend cannot report an exact current result. Only use its
// unambiguous states, never the aggregate availability of prior polls.
export function currentProbe(service: Service): boolean | null {
  if (typeof service.probeAvailable === "boolean" || service.probeAvailable === null) return service.probeAvailable;
  if (service.state === "synced" || service.state === "online") return true;
  if (service.state === "offline") return false;
  if (service.state === "syncing" && (service.kind === "btc" || service.kind === "ckb")) return true;
  if (service.kind === "spv" && service.metrics?.some(({ label, value }) => label === "证明 RPC" && value === "在线")) return true;
  return null;
}

// The connection probe and synchronization are independent. Availability-only
// services are ready once reachable; a Bitcoin node can still be indexing.
export function isAvailabilityOnly(kind: Kind) {
  return kind === "http" || kind === "dob_decoder";
}
export function servicePriority(service: Service): 0 | 1 | 2 {
  const probe = currentProbe(service);
  if (probe === false || service.state === "offline") return 0;
  if (probe !== true || (service.state !== "synced" && !(isAvailabilityOnly(service.kind) && service.state === "online"))) return 1;
  if (service.kind === "btc" && (service.bitcoinIndexes?.txindex?.state === "syncing"
      || service.bitcoinIndexes?.txospenderindex?.state === "syncing")) return 1;
  return 2;
}

const tipTolerance = 2;
const debounceBand = 4;

/** Dashboard grouping only. Return raw status/metrics unchanged outside this classifier. */
export function createAttentionTracker() {
  let latest = NaN;
  let prior = new Map<string, { priority: 0 | 1 | 2; nearTip: boolean }>();

  return (snapshot: Snapshot | null) => {
    const observed = typeof snapshot?.updatedAt === "string" ? Date.parse(snapshot.updatedAt) : NaN;
    if (Number.isFinite(observed) && observed === latest) return prior;
    const regressed = observed < latest;
    const fresh = Number.isFinite(observed) && !regressed;
    const next = new Map<string, { priority: 0 | 1 | 2; nearTip: boolean }>();
    for (const service of snapshot?.services ?? []) {
      if (!service || typeof service.id !== "string") continue;
      const raw = servicePriority(service);
      // Older CKBadger probes already expose enough evidence; do not guess
      // IBD/mempool/confirmation state for other services on older backends.
      const mode = service.kind === "ckbadger" && Array.isArray(service.metrics) && service.metrics.find(row => row?.label === "索引模式")?.value;
      const legacyGap = mode === "normal" || mode === "synced" ? syncComparisons(service)[0]?.lag : undefined;
      const lag = service.syncTipLag ?? legacyGap;
      const credible = fresh && !isAvailabilityOnly(service.kind) && currentProbe(service) === true
        && (service.state === "syncing" || service.state === "synced")
        && typeof lag === "number" && Number.isSafeInteger(lag) && lag >= 0;
      const nearTip = credible && lag <= tipTolerance && (raw === 2 || lag > 0);
      const previous = prior.get(service.id);
      // After a healthy near-tip observation, wait for one additional fresh
      // sample in the marginal band. A duplicate fetch/re-render is no sample.
      const pending = credible && raw === 1 && lag > tipTolerance && lag <= debounceBand
        && previous?.priority === 2 && previous.nearTip;
      next.set(service.id, { priority: nearTip || pending ? 2 : raw, nearTip });
    }
    latest = observed;
    prior = next;
    return next;
  };
}

export function probeTotals(services: Service[]) {
  let online = 0, unconfirmed = 0;
  for (const service of services) {
    const current = currentProbe(service);
    if (current === true) online++;
    if (current === null) unconfirmed++;
  }
  return { online, unconfirmed, total: services.length };
}

const githubProjects = {
  btc: "https://github.com/bitcoin/bitcoin",
  ckb: "https://github.com/nervosnetwork/ckb",
  blockbook: "https://github.com/trezor/blockbook",
  spv: "https://github.com/RGBPlusPlus/ckb-bitcoin-spv-service",
  ckbadger: "https://github.com/janx/ckbadger",
  dob_decoder: "https://github.com/sporeprotocol/dob-decoder-standalone-server",
};
export function projectRepository(service: Service): string | undefined {
  if (Object.hasOwn(githubProjects, service.kind)) return githubProjects[service.kind as keyof typeof githubProjects];
  if (service.kind !== "http") return;
  const configured = service.githubUrl;
  if (configured !== undefined) {
    if (typeof configured !== "string" || /\s/.test(configured) ||
        !/^https:\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9_.-]{1,100}\/?$/.test(configured)) return;
    const url = new URL(configured);
    if (url.pathname.split("/").filter(Boolean).length === 2) return url.href;
    return;
  }
  return service.id === "mainnet-http:btc-asset-api" || service.id === "testnet3-http:btc-asset-api"
    ? "https://github.com/RGBPlusPlus/btc-assets-api" : undefined;
}

type Height = { label: string; value: number; observedAt?: string };
type Comparison = { current?: Height; target?: Height; lag?: number; ratio?: number; gapLabel?: string; index?: { name: string; label: string; state: string } };
function height(service: Service, metric: string, label = metric): Height | undefined {
  if (!Array.isArray(service.metrics)) return;
  const row = service.metrics.find(row => row?.label === metric);
  if (typeof row?.value !== "number" || !Number.isSafeInteger(row.value) || row.value < 0) return;
  const time = typeof row.observedAt === "string" ? Date.parse(row.observedAt) : NaN;
  return { label, value: row.value, observedAt: Number.isFinite(time) ? row.observedAt : undefined };
}
function compare(current?: Height, target?: Height, gapLabel?: string): Comparison[] {
  if (!current && !target) return [];
  if (!current || !target || current.value > target.value) return [{ current, target }];
  return [{ current, target, lag: target.value - current.value, ratio: target.value ? current.value / target.value : 1, gapLabel }];
}
export function syncComparisons(service: Service): Comparison[] {
  switch (service.kind) {
    case "btc": {
      const verified = height(service, "已验证区块高度");
      const rows = compare(verified, height(service, "区块头高度"));
      const indexes = [
        { name: "txindex", label: "交易索引" },
        { name: "txospenderindex", label: "已花费输出索引" },
      ] as const;
      for (const index of indexes) {
        const result = service.bitcoinIndexes?.[index.name];
        if (!result) continue;
        if (result.state === "disabled" || result.state === "unavailable") {
          rows.push({ index: { ...index, state: result.state === "disabled" ? "未启用" : "不可用" } });
        } else if ("height" in result && Number.isSafeInteger(result.height) && result.height >= 0) {
          const pair = compare({ label: "索引高度", value: result.height }, verified)[0];
          rows.push({ ...pair, index: { ...index, state: result.state === "synced" ? "已同步" : "同步中" } });
        }
      }
      return rows;
    }
    case "ckb": {
      const verified = height(service, "节点区块高度");
      const known = height(service, "已知区块高度");
      const indexer = height(service, "索引器高度");
      return [...compare(verified, known), ...(indexer ? compare(indexer, verified) : [])];
    }
    case "blockbook":
      return compare(height(service, "索引高度"), height(service, "配置的 Core 高度") ?? height(service, "Blockbook 上游高度"));
    case "ckbadger": return compare(height(service, "索引高度"), height(service, "CKB 目标高度"));
    case "spv": {
      const chain = height(service, "链上 SPV 高度") ?? height(service, "SPV 缓存的链上高度");
      const core = height(service, "本地 BTC 高度", "BTC Core 高度") ?? height(service, "SPV 观测的 BTC 高度");
      const local = height(service, "本地 SPV 高度");
      const reference = height(service, "参考 BTC 高度") ?? core;
      return local ? [...(chain ? compare(chain, local, "上链落后") : []), ...compare(local, core ?? reference, "头同步落后")] : compare(chain, reference);
    }
    default: return [];
  }
}
export function uptimeDay(availability: Service["availability"]) {
  if (!Array.isArray(availability?.windows)) return;
  const sample = availability.windows.find(row => row?.seconds === 86_400);
  if (sample && Number.isSafeInteger(sample.total) && Number.isSafeInteger(sample.available)
      && sample.total > 0 && sample.available >= 0 && sample.available <= sample.total) return sample;
}

/** Reject partial/invalid series rather than turning backend mistakes into downtime. */
export function uptimeBins(availability: Service["availability"]) {
  const bins = availability?.dayBins;
  if (!Array.isArray(bins) || bins.length !== 12 || bins.some((bin, i) =>
    !bin || !Number.isSafeInteger(bin.startMinute) || Math.abs(bin.startMinute) > 143_999_999_880 ||
    (i > 0 && bin.startMinute - bins[i - 1].startMinute !== 120) ||
    !Number.isSafeInteger(bin.available) || !Number.isSafeInteger(bin.total) ||
    bin.available < 0 || bin.total < bin.available
  )) return null;
  return bins.map(bin => {
    const ratio = bin.total ? bin.available / bin.total : null;
    return {
      ...bin,
      ratio,
      state: stateOfBin(bin.available, bin.total),
    };
  });
}

function stateOfBin(available: number, total: number): "empty" | "down" | "up" | "mixed" {
  return total === 0 ? "empty" : available === 0 ? "down" : available === total ? "up" : "mixed";
}

// Dashboard green, amber and pink, expressed in linear-light sRGB for mixing.
// The midpoint is an illustrative color, not a status or failure threshold.
const uptimePalette = ([0xf5a9b8, 0xe9c484, 0x8ddeaa]).map(rgb =>
  [16, 8, 0].map(shift => {
    const channel = ((rgb >> shift) & 255) / 255;
    return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
  })
);

export function uptimeFillColor(ratio: number): string {
  const position = ratio * 2;
  const segment = position < 1 ? 0 : 1;
  const weight = position - segment;
  const channels = uptimePalette[segment].map((start, i) => {
    const linear = start + (uptimePalette[segment + 1][i] - start) * weight;
    const display = linear <= .0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - .055;
    return Math.round(display * 255).toString(16).padStart(2, "0");
  });
  return `#${channels.join("")}`;
}
