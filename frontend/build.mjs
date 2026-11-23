import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

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
for (const module of ["app.js", "i18n.js", "locales.js", "fr.js", "de.js", "presentation.js"]) {
  copyFileSync(new URL("../dist/client/frontend/src/" + module, folder), new URL(module, dist));
}
for (const asset of ["style.css", "favicon.svg", "og.png"]) copyFileSync(new URL(asset, folder), new URL(asset, dist));
const defaultShareOrigin = "https://chain-sync-monitor.netlify.app";
let shareOrigin = defaultShareOrigin;
if (process.env.NETLIFY === "true" && process.env.URL) {
  try {
    const site = new URL(process.env.URL);
    if (site.protocol === "https:" && /^[a-z0-9.-]+$/.test(site.hostname) && !site.port &&
        !site.username && !site.password && site.pathname === "/" && !/[?#]/.test(process.env.URL)) shareOrigin = site.origin;
  } catch { /* Keep stable default for malformed values. */ }
}
const index = readFileSync(new URL("index.html", folder), "utf8");
writeFileSync(new URL("index.html", dist), index.replace(defaultShareOrigin + "/og.png", shareOrigin + "/og.png"));
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
