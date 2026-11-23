import { createServer, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Config } from "./config.js";
import type { Snapshot } from "../../shared/status.js";

const assets = [
  ["/", "index.html", "text/html"], ["/index.html", "index.html", "text/html"], ["/style.css", "style.css", "text/css"],
  ["/config.js", "config.js", "text/javascript"], ["/app.js", "app.js", "text/javascript"],
  ["/i18n.js", "i18n.js", "text/javascript"],
];
export function makeServer(config: Config, snapshot: () => Snapshot, staticDir?: string) {
  const files = new Map<string, [Buffer, string]>(staticDir
    ? assets.map(([route, file, type]) => [route, [readFileSync(resolve(staticDir, file)), type]]) : []);
  return createServer((request, response) => {
    const method = request.method;
    const reply = (status: number, mime: string, body: string | Buffer) => send(response, status, mime, body, method === "HEAD");
    if (request.url === "/api/status") {
      const origin = request.headers.origin;
      response.setHeader("Vary", "Origin");
      if (origin && config.corsOrigins.has(origin)) {
        response.setHeader("Access-Control-Allow-Origin", origin);
      }
      if (method === "OPTIONS" && origin && config.corsOrigins.has(origin) &&
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
