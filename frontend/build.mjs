import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";

const folder = new URL("./", import.meta.url);
const dist = new URL("../dist/web/", folder);
const supplied = process.env.STATUS_API_URL?.trim();
if (process.env.NETLIFY === "true" && !supplied) throw new Error("Set STATUS_API_URL in the Netlify build environment.");
let endpoint = "/api/status", connect = "'self'";
if (supplied) {
  const url = new URL(supplied);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
      || url.username || url.password || /[?#]/.test(supplied) || url.pathname !== "/api/status") {
    throw new Error("STATUS_API_URL must be an HTTPS /api/status endpoint without credentials, query, or fragment.");
  }
  endpoint = url.href;
  connect += " " + url.origin;
}
mkdirSync(dist, { recursive: true });
copyFileSync(new URL("../dist/client/frontend/src/app.js", folder), new URL("app.js", dist));
for (const asset of ["index.html", "style.css"]) copyFileSync(new URL(asset, folder), new URL(asset, dist));
writeFileSync(new URL("config.js", dist), "window.CHAIN_SYNC_MONITOR_API_URL = " + JSON.stringify(endpoint) + ";\n");
writeFileSync(new URL("_headers", dist), [
  "/*",
  "  X-Content-Type-Options: nosniff",
  "  Referrer-Policy: no-referrer",
  `  Content-Security-Policy: default-src 'self'; connect-src ${connect}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`,
  "/config.js",
  "  Cache-Control: no-store",
  "",
].join("\n"));
