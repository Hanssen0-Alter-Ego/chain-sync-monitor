import { closeSync, openSync, readFileSync, readSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse } from "smol-toml";
import { networks, type Network, type Kind } from "../../shared/status.js";

export const labels: Record<Exclude<Kind, "http">, string> = {
  btc: "Bitcoin Core", ckb: "CKB 节点与索引器", blockbook: "Blockbook",
  spv: "Bitcoin SPV 服务", ckbadger: "CKBadger", dob_decoder: "DOB Decoder",
};

export interface Endpoint {
  url: string;
  publicUrl?: string;
  githubUrl?: string;
  authorization?: string;
  label: string;
  kind: Kind;
  typeScript?: unknown;
}
export interface Config {
  endpoints: Record<Network, Map<string, Endpoint>>;
  host: string;
  port: number;
  intervalSeconds: number;
  timeoutSeconds: number;
  historyPath: string;
  corsOrigins: Set<string>;
  corsNetlifySite?: string;
}
export class ConfigError extends Error {}
export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
function table(value: unknown, label: string) {
  const output = record(value);
  if (!output) throw new ConfigError(`${label} 应是 TOML 表。`);
  return output;
}
function number(value: unknown, low: number, high: number, label: string, integer = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < low || value > high
      || (integer && !Number.isInteger(value))) {
    throw new ConfigError(`${label} 超出范围或格式无效。`);
  }
  return value;
}
export function listenHost(value: unknown): string {
  if (typeof value !== "string" || !value || /\s/.test(value)) throw new ConfigError("monitor.host 无效。");
  return value;
}
export function listenPort(value: unknown): number {
  return number(value, 1, 65535, "monitor.port", true);
}
function httpUrl(value: unknown, field: string, publicUrl = false) {
  if (typeof value === "string" && /^https?:\/\//.test(value) && !/[\s\x00-\x1f\\]/.test(value)
      && (publicUrl || !/[?#]/.test(value)) && !/^https?:\/\/[^/]*@/.test(value)) {
    try {
      const url = new URL(value);
      if (url.hostname && !url.username && !url.password) return value;
    } catch { /* keep the error free of raw URLs */ }
  }
  throw new ConfigError(`${field} 必须是无内嵌凭据的 HTTP(S) URL。`);
}
function githubRepository(value: unknown, field: string) {
  if (typeof value === "string" && !/\s/.test(value) &&
      /^https:\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9_.-]{1,100}\/?$/.test(value)) {
    const url = new URL(value);
    if (url.pathname.split("/").filter(Boolean).length === 2) return url.href.replace(/\/$/, "");
  }
  throw new ConfigError(`${field} 必须是 HTTPS GitHub 仓库地址。`);
}
function origin(value: unknown) {
  const url = new URL(httpUrl(value, "monitor.cors_origins"));
  if (url.pathname !== "/") throw new ConfigError("monitor.cors_origins 仅允许精确 origin，不允许路径。");
  return url.origin;
}
function credential(source: Record<string, unknown>, key: string, dir: string, label: string) {
  const fields = [key, key + "_env", key + "_file"].filter((field) => Object.hasOwn(source, field));
  if (!fields.length) return undefined;
  if (fields.length !== 1) throw new ConfigError(`${label} 的 ${key} 只能配置一种来源。`);
  const field = fields[0];
  let value = source[field];
  if (typeof value !== "string" || !value || value.length > 4096) throw new ConfigError(`${label}.${field} 格式无效。`);
  if (field.endsWith("_env")) value = process.env[value];
  else if (field.endsWith("_file")) {
    try {
      const fd = openSync(resolve(dir, value), "r");
      try {
        const buffer = Buffer.alloc(4097);
        const bytes = readSync(fd, buffer, 0, buffer.length, null);
        if (bytes === buffer.length) throw new Error("Credential exceeds limit");
        value = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytes)).replace(/[\r\n]+$/, "");
      } finally { closeSync(fd); }
    }
    catch { throw new ConfigError(`无法读取 ${label}.${field} 指定的凭据文件。`); }
  }
  if (typeof value !== "string" || !value || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new ConfigError(`${label}.${field} 未提供有效凭据。`);
  }
  return value;
}
export function loadConfig(path: string): Config {
  let raw: Record<string, unknown>;
  try { raw = parse(readFileSync(path, "utf8")); }
  catch { throw new ConfigError("无法读取配置文件，或 TOML 格式无效。"); }
  const dir = dirname(resolve(path));
  const opts = table(raw.monitor === undefined ? {} : raw.monitor, "monitor");
  const historyPath = opts.history_path ?? "history.sqlite3";
  if (typeof historyPath !== "string" || !historyPath.trim() || historyPath.includes("\0")) {
    throw new ConfigError("monitor.history_path 必须是非空路径。");
  }
  const origins = opts.cors_origins ?? [];
  if (!Array.isArray(origins)) throw new ConfigError("monitor.cors_origins 应是数组。");
  const corsOrigins = new Set(origins.map(origin));
  const corsNetlifySite = opts.cors_netlify_site;
  if (corsNetlifySite !== undefined && (typeof corsNetlifySite !== "string" || !corsNetlifySite.length
      || corsNetlifySite.length > 63 || /[^a-z0-9-]|^-|-$|--/.test(corsNetlifySite))) {
    throw new ConfigError("monitor.cors_netlify_site 必须是小写 Netlify 站点名，不含域名或路径。");
  }
  const endpoints: Config["endpoints"] = { mainnet: new Map(), testnet3: new Map() };
  const configured = table(raw.networks ?? {}, "networks");
  if (Object.keys(configured).some((net) => !Object.hasOwn(endpoints, net))) {
    throw new ConfigError("网络名称仅支持 mainnet 和 testnet3。");
  }
  for (const net of networks) {
    const network = table(configured[net] ?? {}, `networks.${net}`);
    for (const kind of Object.keys(network)) {
      if (kind !== "http" && !Object.hasOwn(labels, kind)) throw new ConfigError(`networks.${net} 包含不支持的服务。`);
    }
    for (const kind of Object.keys(labels) as (keyof typeof labels)[]) {
      if (!Object.hasOwn(network, kind)) continue;
      const field = `networks.${net}.${kind}`;
      const service = table(network[kind], field);
      const endpoint: Endpoint = {
        kind, label: labels[kind], url: httpUrl(service.url, field + ".url"),
        publicUrl: service.public_url === undefined ? undefined : httpUrl(service.public_url, field + ".public_url", true),
      };
      if (kind === "btc") {
        const username = credential(service, "username", dir, field);
        const password = credential(service, "password", dir, field);
        if ((username === undefined) !== (password === undefined) || username?.includes(":")) {
          throw new ConfigError(`${field} 的 RPC 用户名与密码必须同时配置且用户名不含冒号。`);
        }
        if (username !== undefined) endpoint.authorization = "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
      }
      if (kind === "spv") endpoint.typeScript = service.type_script;
      endpoints[net].set(kind, endpoint);
    }
    const probes = network.http ?? [];
    if (!Array.isArray(probes) || probes.length > 8) throw new ConfigError(`networks.${net}.http 必须是数组，每个网络最多 8 项。`);
    for (const probe of probes as unknown[]) {
      const field = `networks.${net}.http`;
      const service = table(probe, field);
      const { id, label } = service;
      if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(id) || endpoints[net].has("http:" + id)) {
        throw new ConfigError(`${field}.id 无效或重复。`);
      }
      if (typeof label !== "string" || !label.trim() || label.trim().length > 80 || /[\x00-\x1f]/.test(label)) {
        throw new ConfigError(`${field}.label 无效。`);
      }
      endpoints[net].set("http:" + id, {
        kind: "http", label: label.trim(), url: httpUrl(service.url, field + ".url"),
        publicUrl: service.public_url === undefined ? undefined : httpUrl(service.public_url, field + ".public_url", true),
        githubUrl: service.github_url === undefined ? undefined : githubRepository(service.github_url, field + ".github_url"),
      });
    }
  }
  return {
    endpoints, corsOrigins, corsNetlifySite, historyPath: resolve(dir, historyPath),
    host: listenHost(opts.host ?? "127.0.0.1"), port: listenPort(opts.port ?? 8080),
    intervalSeconds: number(opts.interval_seconds ?? 30, 1, 3600, "monitor.interval_seconds"),
    timeoutSeconds: number(opts.timeout_seconds ?? 5, 0.1, 60, "monitor.timeout_seconds"),
  };
}
