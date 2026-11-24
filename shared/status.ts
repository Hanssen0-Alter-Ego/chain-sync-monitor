export const networks = ["mainnet", "testnet3"] as const;
export type Network = typeof networks[number];
export type Kind = "btc" | "ckb" | "blockbook" | "spv" | "ckbadger" | "dob_decoder" | "http";
export type State = "online" | "synced" | "syncing" | "degraded" | "offline" | "unknown";
export interface Metric {
  label: string;
  value: number | string;
  unit?: string;
  observedAt?: string;
}
export const bitcoinIndexNames = ["txindex", "txospenderindex"] as const;
export type BitcoinIndexName = typeof bitcoinIndexNames[number];
export type BitcoinIndexReading =
  | { state: "synced" | "syncing"; height: number }
  | { state: "disabled" | "unavailable" };
export type BitcoinIndexes = Record<BitcoinIndexName, BitcoinIndexReading>;
export interface Reading {
  state: State;
  metrics: Metric[];
  note?: string;
  progress?: number;
  bitcoinIndexes?: BitcoinIndexes;
  /** Verified gap on a live, non-initial sync path. Absent when not established. */
  syncTipLag?: number;
}
export interface AvailabilityBin { startMinute: number; available: number; total: number }
export interface Availability {
  dayBins?: AvailabilityBin[];
  windows: {seconds: number; ratio: number | null; available: number; total: number}[];
}
export interface Service extends Reading {
  id: string;
  label: string;
  network: Network;
  kind: Kind;
  publicUrl?: string;
  githubUrl?: string;
  probeAvailable?: boolean | null;
  availability: Availability;
}
export interface Snapshot {
  updatedAt: string | null;
  intervalSeconds: number;
  services: Service[];
  historyError?: string;
}
