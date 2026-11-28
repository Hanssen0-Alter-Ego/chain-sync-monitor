import { networks, type Network, type Reading, type Snapshot, type Availability } from "../../shared/status.js";
import type { Config, Endpoint } from "./config.js";
import { EmailAlerts } from "./email-alerts.js";
import { availability, historyError, type HistoryStore } from "./history.js";
import { compareBlockbook, inspectOnchain, mergeSpvStatus, metric, probe, reading, verifiedBadgerLag, type BitcoinTip, type CkbTip } from "./probes.js";

async function parallel<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>) {
  const output: R[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      output[i] = await fn(items[i]);
    }
  }));
  return output;
}
export class Monitor {
  snapshot: Snapshot;
  private readonly probes: {network?: Network; id: string; endpoint: Endpoint}[];
  private spvMismatches = new Map<Network, string>();
  private bookHeights = new Map<Network, { height: number; since: number }>();
  private history: Record<string, Availability> = {};
  private error?: string;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private initialPoll?: Promise<void>;
  private readonly alerts?: EmailAlerts;
  constructor(readonly config: Config, private readonly store: HistoryStore) {
    this.probes = [
      ...networks.flatMap(network => [...config.endpoints[network]].map(([key, endpoint]) =>
        ({ network, id: `${network}-${key}`, endpoint }))),
      ...[...config.unscoped].map(([key, endpoint]) => ({ id: `service-${key}`, endpoint })),
    ];
    if (config.emailAlerts) {
      const maxSampleGapMs = Math.max(config.intervalSeconds * 1.5, config.timeoutSeconds * 2) * 1000;
      this.alerts = new EmailAlerts(config.historyPath, config.emailAlerts, undefined, maxSampleGapMs);
    }
    this.record(new Map());
    this.snapshot = this.build(null, []);
  }
  private build(updatedAt: string | null, readings: Reading[], current: boolean[] = []): Snapshot {
    return {
      updatedAt, intervalSeconds: this.config.intervalSeconds, historyError: this.error,
      services: this.probes.map(({ network, id, endpoint }, index) => ({
        id, network, group: endpoint.group, kind: endpoint.kind, label: endpoint.label, publicUrl: endpoint.publicUrl, githubUrl: endpoint.githubUrl,
        ...(readings[index] ?? reading("unknown", [], "等待首次检查。")),
        probeAvailable: current[index] ?? null,
        availability: this.history[id] ?? availability(),
      })),
    };
  }
  private record(outcomes: Map<string, boolean>) {
    try { this.history = this.store.observe(outcomes); this.error = undefined; }
    catch { this.history = {}; this.error = historyError; }
  }
  async poll() {
    const results = await parallel(this.probes, 8, ({ network, endpoint }) => probe(network, endpoint, this.config.timeoutSeconds));
    const tips = new Map<Network, BitcoinTip>();
    const ckbTips = new Map<Network, CkbTip>();
    for (const [index, result] of results.entries()) {
      const { network } = this.probes[index];
      if (network && "reading" in result && result.ckbTip) ckbTips.set(network, result.ckbTip);
      if (network && "reading" in result && result.tip) tips.set(network, result.tip);
    }
    const readings = await Promise.all(results.map(async (result, index) => {
      const { network, endpoint } = this.probes[index];
      const btc = network && tips.get(network);
      if ("book" in result) {
        if (!network) return reading("unknown", []);
        const { result: live, height } = compareBlockbook(network, result.book, result.backend, btc);
        if (height === undefined || live.state !== "syncing") this.bookHeights.delete(network);
        else {
          const now = performance.now(), last = this.bookHeights.get(network);
          const since = last?.height === height ? last.since : now;
          this.bookHeights.set(network, { height, since });
          const minutes = Math.floor((now - since) / 60_000);
          if (minutes >= 5) live.metrics.push(metric("REST 高度未更新", minutes, "分钟"));
        }
        return live;
      }
      if (network && endpoint.kind === "blockbook") this.bookHeights.delete(network);
      if (network && endpoint.kind === "spv") {
        const status = result.spvStatus;
        let live = result.reading;
        const previousMismatch = this.spvMismatches.get(network);
        this.spvMismatches.delete(network);
        if (result.available && live.state === "unknown" && (endpoint.typeScript !== undefined || !status)) {
          const endpoints = this.config.endpoints[network];
          live = await inspectOnchain(network, endpoint, endpoints.get("ckb"), endpoints.get("btc"), btc,
            this.config.timeoutSeconds, live, status?.local !== undefined, fingerprint => {
              this.spvMismatches.set(network, fingerprint);
              return previousMismatch === fingerprint;
            });
        } else if (result.available && status) {
          live = { ...live, note: "SPV 高度来自服务缓存的观测，不代表已独立核实同步。" };
        }
        return mergeSpvStatus(live, status, btc);
      }
      if (network && result.badgerIndex) {
        const tip = ckbTips.get(network), reference = this.config.endpoints[network].get("ckb");
        if (reference && tip) {
          const syncTipLag = await verifiedBadgerLag(network, reference, this.config.timeoutSeconds, result.badgerIndex, tip);
          if (syncTipLag !== undefined) {
            return { ...result.reading, state: syncTipLag > 0 ? "syncing" as const : result.reading.state,
              metrics: [...result.reading.metrics, metric("已验证区块高度", tip.height)], syncTipLag };
          }
        }
      }
      return result.reading;
    }));
    this.record(new Map(results.map((result, index) => [this.probes[index].id, result.available])));
    const now = Date.now();
    this.snapshot = this.build(new Date(now).toISOString(), readings, results.map(result => result.available));
    if (this.alerts) {
      try {
        this.alerts.observe(this.snapshot.services, now);
        void this.alerts.flush(now).catch(() => console.error("Could not process the email alert outbox."));
      } catch { console.error("Could not save email alert state."); }
    }
  }
  start() {
    if (this.initialPoll) return;
    const tick = async () => {
      const start = performance.now();
      try { await this.poll(); }
      catch { console.error("Monitor poll did not complete."); }
      finally {
        if (!this.stopped) this.timer = setTimeout(tick, Math.max(0, this.config.intervalSeconds * 1000 - (performance.now() - start)));
      }
    };
    this.initialPoll = tick();
  }
  stop() { this.stopped = true; clearTimeout(this.timer); }
}
