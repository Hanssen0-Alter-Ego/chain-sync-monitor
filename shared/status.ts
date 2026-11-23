export const networks = ["mainnet", "testnet3"] as const;
export type Network = typeof networks[number];
export type Kind = "btc" | "ckb" | "blockbook" | "spv" | "ckbadger" | "http";
export type State = "online" | "synced" | "syncing" | "degraded" | "offline" | "unknown";
export interface Metric {
  label: string;
  value: number | string;
  unit?: string;
  observedAt?: string;
}
export interface Reading {
  state: State;
  metrics: Metric[];
  note?: string;
  progress?: number;
}
export interface Availability {
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
