import { createServer, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Config } from "./config.js";
import type { Snapshot } from "../../shared/status.js";

const assets = [
  ["/", "index.html", "text/html"], ["/index.html", "index.html", "text/html"], ["/style.css", "style.css", "text/css"],
  ["/config.js", "config.js", "text/javascript"], ["/app.js", "app.js", "text/javascript"],
  ["/i18n.js", "i18n.js", "text/javascript"],
  ["/presentation.js", "presentation.js", "text/javascript"],
];
function allowsOrigin(config: Config, origin: string): boolean {
  if (config.corsOrigins.has(origin)) return true;
  const site = config.corsNetlifySite;
  if (!site || !origin.startsWith("https://")) return false;
  // Browser Origin is serialized without a path, credentials, or the default port.
  const host = origin.slice("https://".length);
  const suffix = `${site}.netlify.app`;
  if (host === suffix) return true;
  const deploySuffix = `--${suffix}`;
  if (site.length + 26 > 63 || !host.endsWith(deploySuffix)) return false;
  const id = host.slice(0, -deploySuffix.length);
  return id.length === 24 && /^[a-f0-9]+$/.test(id);
}
export function makeServer(config: Config, snapshot: () => Snapshot, staticDir?: string) {
  const files = new Map<string, [Buffer, string]>(staticDir
    ? assets.map(([route, file, type]) => [route, [readFileSync(resolve(staticDir, file)), type]]) : []);
  return createServer((request, response) => {
    const method = request.method;
    const reply = (status: number, mime: string, body: string | Buffer) => send(response, status, mime, body, method === "HEAD");
    if (request.url === "/api/status") {
      const origin = request.headers.origin;
      const allowed = origin !== undefined && allowsOrigin(config, origin);
      response.setHeader("Vary", method === "OPTIONS" ? "Origin, Access-Control-Request-Method" : "Origin");
      if (allowed) response.setHeader("Access-Control-Allow-Origin", origin);
      if (method === "OPTIONS" && allowed &&
          ["GET", "HEAD"].includes(request.headers["access-control-request-method"] ?? "")) {
        response.setHeader("Access-Control-Allow-Methods", "GET, HEAD");
        response.writeHead(204).end();
        return;
      }
      if (method === "GET" || method === "HEAD") {
        return reply(200, "application/json", JSON.stringify(snapshot()));
      }
      response.setHeader("Allow", "GET, HEAD, OPTIONS");
      return reply(405, "text/plain", "Method not allowed.\n");
    }
    if (method === "GET" || method === "HEAD") {
      const file = files.get(request.url ?? "");
      if (file) {
        response.setHeader("Content-Security-Policy", "default-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
        return reply(200, file[1], file[0]);
      }
    }
    return reply(404, "text/plain", "Not found.\n");
  });
}
function send(response: ServerResponse, status: number, type: string, payload: string | Buffer, head: boolean) {
  response.writeHead(status, {
    "Content-Type": type + "; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(head ? undefined : payload);
}
