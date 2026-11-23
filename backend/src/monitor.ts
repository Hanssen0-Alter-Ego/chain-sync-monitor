import { networks, type Network, type Reading, type Snapshot, type Availability } from "../../shared/status.js";
import type { Config } from "./config.js";
import { availability, historyError, type HistoryStore } from "./history.js";
import { compareBlockbook, inspectOnchain, metric, probe, reading, type BitcoinTip } from "./probes.js";

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
  private readonly probes;
  private bookHeights = new Map<Network, { height: number; since: number }>();
  private history: Record<string, Availability> = {};
  private error?: string;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private initialPoll?: Promise<void>;
  constructor(readonly config: Config, private readonly store: HistoryStore) {
    this.probes = networks.flatMap(network => [...config.endpoints[network]].map(([key, endpoint]) =>
      ({ network, id: `${network}-${key}`, endpoint })));
    this.record(new Map());
    this.snapshot = this.build(null, []);
  }
  private build(updatedAt: string | null, readings: Reading[], current: boolean[] = []): Snapshot {
    return {
      updatedAt, intervalSeconds: this.config.intervalSeconds, historyError: this.error,
      services: this.probes.map(({ network, id, endpoint }, index) => ({
        id, network, kind: endpoint.kind, label: endpoint.label, publicUrl: endpoint.publicUrl,
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
    for (const [index, result] of results.entries()) {
      if ("reading" in result && result.tip) tips.set(this.probes[index].network, result.tip);
    }
    const readings = await Promise.all(results.map(async (result, index) => {
      const { network, endpoint } = this.probes[index];
      const btc = tips.get(network);
      if ("book" in result) {
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
      if (endpoint.kind === "blockbook") this.bookHeights.delete(network);
      if (endpoint.kind === "spv" && result.available && result.reading.state === "unknown") {
        return await inspectOnchain(endpoint.typeScript, this.config.endpoints[network].get("ckb"), btc,
          this.config.timeoutSeconds, result.reading);
      }
      return result.reading;
    }));
    this.record(new Map(results.map((result, index) => [this.probes[index].id, result.available])));
    this.snapshot = this.build(new Date().toISOString(), readings, results.map(result => result.available));
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
