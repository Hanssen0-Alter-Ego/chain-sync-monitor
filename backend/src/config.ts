import { closeSync, openSync, readFileSync, readSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse } from "smol-toml";
import { type Network, type Kind, type ServiceGroup } from "../../shared/status.js";

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
  group?: ServiceGroup;
  typeScript?: { code_hash: string; hash_type: string; args: string };
  bitcoinReference?: Endpoint;
}
export interface EmailAlertsConfig {
  accountId: string;
  apiToken: string;
  from: string;
  to: string;
  statusUrl?: string;
  failureChecks: number;
  recoveryChecks: number;
  lagBlocks: number;
  lagSeconds: number;
}

export interface Config {
  endpoints: Record<Network, Map<string, Endpoint>>;
  unscoped: Map<string, Endpoint>;
  host: string;
  port: number;
  intervalSeconds: number;
  timeoutSeconds: number;
  historyPath: string;
  corsOrigins: Set<string>;
  corsNetlifySite?: string;
  emailAlerts?: EmailAlertsConfig;
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
function bitcoinAuthorization(source: Record<string, unknown>, dir: string, field: string) {
  const username = credential(source, "username", dir, field);
  const password = credential(source, "password", dir, field);
  if ((username === undefined) !== (password === undefined) || username?.includes(":")) {
    throw new ConfigError(`${field} 的 RPC 用户名与密码必须同时配置且用户名不含冒号。`);
  }
  return username === undefined ? undefined : "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
}
function emailAlerts(value: unknown, dir: string): EmailAlertsConfig | undefined {
  if (value === undefined) return;
  const field = "alerts.email";
  const opts = table(value, field);
  if (opts.enabled === undefined || opts.enabled === false) return;
  if (opts.enabled !== true) throw new ConfigError(`${field}.enabled 必须是布尔值。`);
  if (typeof opts.account_id !== "string" || !/^[0-9a-f]{32}$/i.test(opts.account_id)) {
    throw new ConfigError(`${field}.account_id 必须是 32 位十六进制 Cloudflare Account ID。`);
  }
  if (Object.hasOwn(opts, "api_token")) throw new ConfigError(`${field} 请用 api_token_file 或 api_token_env。`);
  const apiToken = credential(opts, "api_token", dir, field);
  if (!apiToken || /\s/.test(apiToken)) throw new ConfigError(`${field} 缺少有效的 Cloudflare API Token。`);
  const address = (key: "from" | "to") => {
    const value = opts[key];
    if (typeof value !== "string" || value.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z0-9-]+$/i.test(value)) {
      throw new ConfigError(`${field}.${key} 必须是单个邮件地址。`);
    }
    return value;
  };
  return {
    accountId: opts.account_id, apiToken, from: address("from"), to: address("to"),
    statusUrl: opts.status_url === undefined ? undefined : httpUrl(opts.status_url, `${field}.status_url`),
    failureChecks: number(opts.failure_checks ?? 3, 1, 30, `${field}.failure_checks`, true),
    lagBlocks: number(opts.lag_blocks ?? 2, 2, Number.MAX_SAFE_INTEGER, `${field}.lag_blocks`, true),
    lagSeconds: number(opts.lag_seconds ?? 300, 1, 86_400, `${field}.lag_seconds`, true),
    recoveryChecks: number(opts.recovery_checks ?? 2, 1, 30, `${field}.recovery_checks`, true),
  };
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
  const unscoped = new Map<string, Endpoint>();
  if (Object.keys(raw).some(key => !["monitor", "alerts", "groups"].includes(key))) {
    throw new ConfigError("配置顶层仅支持 monitor、alerts 和 groups。");
  }
  function displayLabel(value: unknown, field: string) {
    if (typeof value !== "string" || !value.trim() || value.trim().length > 80 || /[\x00-\x1f\x7f]/.test(value)) {
      throw new ConfigError(`${field} 无效。`);
    }
    return value.trim();
  }
  function add(service: Record<string, unknown>, kind: Kind, field: string, network?: Network, group?: ServiceGroup) {
    const target = network ? endpoints[network] : unscoped;
    let key: string = kind;
    if (kind === "http") {
      const { id } = service;
      if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) {
        throw new ConfigError(`${field}.id 无效或重复。`);
      }
      key = "http:" + id;
      if ([...target.values()].filter(probe => probe.kind === "http").length >= 8) {
        throw new ConfigError(`${field} 的网络范围最多允许 8 个 HTTP 探针。`);
      }
    }
    if (target.has(key)) throw new ConfigError(`${field} 的服务 ID 或探针类型在同一网络范围内重复。`);
    const endpoint: Endpoint = {
      kind, group, label: kind === "http" ? displayLabel(service.label, field + ".label") : labels[kind],
      url: httpUrl(service.url, field + ".url"),
      publicUrl: service.public_url === undefined ? undefined : httpUrl(service.public_url, field + ".public_url", true),
      githubUrl: service.github_url === undefined ? undefined : githubRepository(service.github_url, field + ".github_url"),
    };
    if (kind === "btc") endpoint.authorization = bitcoinAuthorization(service, dir, field);
    if (kind === "spv") {
      if (Object.keys(service).some(key => !["kind", "network", "url", "public_url", "github_url", "code_hash", "hash_type", "args", "bitcoin_reference"].includes(key))) {
        throw new ConfigError(`${field} 包含不支持的 SPV 配置项。`);
      }
      const { code_hash, hash_type, args } = service;
      if (code_hash !== undefined || hash_type !== undefined || args !== undefined) {
        if (typeof code_hash !== "string" || !/^0x[0-9a-f]{64}$/i.test(code_hash)
            || typeof hash_type !== "string" || !["type", "data", "data1", "data2"].includes(hash_type)
            || typeof args !== "string" || !/^0x[0-9a-f]{68}$/i.test(args)) {
          throw new ConfigError(`${field} 的 SPV 脚本须同时提供有效的 code_hash（32 字节）、hash_type 和 args（34 字节）。`);
        }
        endpoint.typeScript = { code_hash, hash_type, args };
      }
      if (service.bitcoin_reference !== undefined) {
        const name = field + ".bitcoin_reference";
        const reference = table(service.bitcoin_reference, name);
        endpoint.bitcoinReference = {
          kind: "btc", label: labels.btc, url: httpUrl(reference.url, name + ".url"),
          authorization: bitcoinAuthorization(reference, dir, name),
        };
      }
    }
    target.set(key, endpoint);
  }
  function knownKind(kind: unknown): kind is Kind {
    return typeof kind === "string" && (kind === "http" || Object.hasOwn(labels, kind));
  }
  for (const [id, value] of Object.entries(table(raw.groups ?? {}, "groups"))) {
    const field = `groups.${id}`;
    const opts = table(value, field);
    const group = { id: displayLabel(id, field), label: displayLabel(opts.label ?? id, field + ".label") };
    if (group.id !== id) throw new ConfigError(`${field} 的分组名不能以空白开头或结尾。`);
    const services = opts.services ?? [];
    if (!Array.isArray(services)) throw new ConfigError(`${field}.services 必须是数组。`);
    for (const [index, value] of services.entries()) {
      const name = `${field}.services[${index}]`;
      const service = table(value, name);
      const { kind, network } = service;
      if (!knownKind(kind)) throw new ConfigError(`${name}.kind 不是支持的探针。`);
      if (network === undefined && kind !== "http" && kind !== "dob_decoder") {
        throw new ConfigError(`${name}.network 必须为 mainnet 或 testnet。`);
      }
      if (network !== undefined && network !== "mainnet" && network !== "testnet") {
        throw new ConfigError(`${name}.network 必须为 mainnet 或 testnet。`);
      }
      add(service, kind, name, network === "testnet" ? "testnet3" : network, group);
    }
  }
  return {
    endpoints, unscoped, corsOrigins, corsNetlifySite, emailAlerts: emailAlerts(table(raw.alerts ?? {}, "alerts").email, dir), historyPath: resolve(dir, historyPath),
    host: listenHost(opts.host ?? "127.0.0.1"), port: listenPort(opts.port ?? 8080),
    intervalSeconds: number(opts.interval_seconds ?? 30, 1, 3600, "monitor.interval_seconds"),
    timeoutSeconds: number(opts.timeout_seconds ?? 5, 0.1, 60, "monitor.timeout_seconds"),
  };
}
