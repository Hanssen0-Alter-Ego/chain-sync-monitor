import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { State } from "../../shared/status.js";
import { record, type Endpoint } from "./config.js";

const MAX_BODY = 2 * 1024 * 1024;
export class ProbeError extends Error {
  constructor(readonly note: string, readonly state: State = "degraded") { super(note); }
}
export class RpcError extends ProbeError {
  constructor(readonly code: number) {
    super(`RPC 返回错误（${code}）。`, code === -32601 ? "unknown" : "degraded");
  }
}
interface Options {
  body?: string;
  authorization?: string;
  extra?: number[];
  statusOnly?: boolean;
  invalidJsonState?: State;
}
interface Reply {
  status: number;
  body: Uint8Array;
  observedAt?: number;
}
function request(url: string, timeout: number, options: Options): Promise<Reply> {
  const transport = new URL(url).protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fail = (error: ProbeError) => { clearTimeout(timer); reject(error); };
    const done = (result: Reply) => { clearTimeout(timer); resolve(result); };
    const body = options.body;
    const req = transport(url, {
      method: body === undefined ? "GET" : "POST",
      agent: false,
      headers: {
        "User-Agent": "chain-sync-monitor/2",
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }),
        ...(options.authorization ? { Authorization: options.authorization } : {}),
      },
    }, (response) => {
      const status = response.statusCode ?? 0;
      const discard = () => response.destroy();
      if (options.statusOnly) { done({status, body: Buffer.alloc(0)}); discard(); return; }
      if (status >= 300 && status < 400) { fail(new ProbeError("上游返回重定向，未跟随。")); discard(); return; }
      if (status !== 200 && !options.extra?.includes(status)) {
        fail(new ProbeError(`上游返回 HTTP ${status}。`)); discard(); return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      response.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_BODY) {
          fail(new ProbeError("上游响应超过大小限制。")); discard();
        } else chunks.push(chunk);
      });
      response.on("end", () => {
        const received = Date.now();
        const { date, age } = response.headers;
        // A cached response can have an old Date, an Age, or both.
        const originTime = date === undefined ? received : Date.parse(date);
        const observedAt = originTime <= received && (age === undefined || /^\d+$/.test(age))
          ? Math.min(originTime, received - Number(age ?? 0) * 1000) : NaN;
        done({status, body: Buffer.concat(chunks), observedAt});
      });
      response.on("error", () => fail(new ProbeError("无法读取 HTTP 响应。", "offline")));
    });
    req.on("error", () => fail(new ProbeError("无法连接上游或读取 HTTP 响应。", "offline")));
    timer = setTimeout(() => {
      fail(new ProbeError("上游请求超时。", "offline"));
      req.destroy();
    }, timeout * 1000);
    req.end(body);
  });
}
export async function readJson(url: string, timeout: number, options: Options = {}) {
  const { status, body, observedAt } = await request(url, timeout, options);
  try {
    const data: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    return { status, data, observedAt };
  } catch {
    if (status === 200) throw new ProbeError("上游没有返回有效的 JSON。", options.invalidJsonState);
    throw new ProbeError(`上游返回 HTTP ${status}。`);
  }
}
export async function statusOnly(url: string, timeout: number) {
  const start = performance.now();
  const { status } = await request(url, timeout, { statusOnly: true });
  return { status, ms: Math.round(performance.now() - start) };
}
export async function rpc(endpoint: Endpoint, timeout: number, method: string, params: unknown[] = [], bitcoin = false) {
  const { status, data } = await readJson(endpoint.url, timeout, {
    body: JSON.stringify({ jsonrpc: bitcoin ? "1.0" : "2.0", method, params, id: 1 }),
    authorization: endpoint.authorization, extra: bitcoin ? [400, 404, 500] : [],
  });
  const reply = record(data);
  if (!reply || reply.id !== 1 || (!bitcoin && reply.jsonrpc !== "2.0")) {
    throw new ProbeError(status === 200 ? "上游返回的 RPC 响应格式不匹配。" : `上游返回 HTTP ${status}。`);
  }
  const code = record(reply.error)?.code;
  if (typeof code === "number" && Number.isInteger(code)) throw new RpcError(code);
  if (reply.error != null || !Object.hasOwn(reply, "result") || status !== 200) {
    throw new ProbeError("上游返回的 RPC 响应格式不匹配。");
  }
  return reply.result;
}
