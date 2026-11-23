import type { Service } from "../../shared/status.js";

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

export function probeTotals(services: Service[]) {
  let online = 0, unconfirmed = 0;
  for (const service of services) {
    const current = currentProbe(service);
    if (current === true) online++;
    if (current === null) unconfirmed++;
  }
  return { online, unconfirmed, total: services.length };
}

const keyMetrics = {
  btc: ["已验证区块高度", "落后区块头"],
  ckb: ["节点区块高度", "索引器高度", "索引器落后"],
  blockbook: ["索引高度", "落后 Core"],
  ckbadger: ["索引高度", "落后"],
  spv: ["链上 SPV 高度", "SPV 落后"],
  http: [],
};
export function keySyncMetric(service: Service): { label: string; value: number; unit?: string } | undefined {
  if (!Array.isArray(service.metrics) || !Object.hasOwn(keyMetrics, service.kind)) return;
  for (const label of keyMetrics[service.kind]) {
    const metric = service.metrics.find(row => row?.label === label);
    if (metric && typeof metric.value === "number" && Number.isFinite(metric.value)) {
      return { label: metric.label, value: metric.value, unit: metric.unit };
    }
  }
}
export function uptimeDay(availability: Service["availability"]) {
  if (!Array.isArray(availability?.windows)) return;
  const sample = availability.windows.find(row => row?.seconds === 86_400);
  if (sample && Number.isSafeInteger(sample.total) && Number.isSafeInteger(sample.available)
      && sample.total > 0 && sample.available >= 0 && sample.available <= sample.total) return sample;
}
