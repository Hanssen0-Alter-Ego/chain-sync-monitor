import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { spawnSync } from "node:child_process";

import { loadConfig } from "../dist/server/backend/src/config.js";
import { HistoryStore } from "../dist/server/backend/src/history.js";
import { Monitor } from "../dist/server/backend/src/monitor.js";
import { makeServer } from "../dist/server/backend/src/server.js";
import { probe } from "../dist/server/backend/src/probes.js";

async function listen(t, server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${server.address().port}`;
}
function directory(t) {
  const dir = mkdtempSync(join(tmpdir(), "status-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function json(response, value, status = 200) {
  response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(value));
}
async function payload(request) {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  return JSON.parse(raw);
}
const reply = (result) => ({ jsonrpc: "2.0", id: 1, result });
const badRequest = { id: 1, jsonrpc: "2.0", error: { code: -32602 } };

test("separate frontend status API, all probes, CORS and no implicit RPC/config disclosure", async (t) => {
  const dir = directory(t);
  const requests = [];
  const spvCell = Buffer.alloc(113);
  spvCell[0] = 7;
  spvCell.writeUInt32LE(90, 33);
  spvCell.writeUInt32LE(100, 37);
  const target = await listen(t, createServer(async (req, res) => {
    requests.push(req.url);
    if (req.url.includes("/book/api/")) return json(res, {
      backend: { chain: req.url.startsWith("/main") ? "main" : "test" },
      blockbook: { bestHeight: 100, inSync: true, inSyncMempool: true },
    });
    if (req.url.includes("/statistics/network")) return json(res, { syncStatus: {
      syncedBlock: 2, tipBlock: 10, syncMode: "bulk", isSyncing: true, progress: 0.93,
    } });
    if (req.url === "/private-asset/healthcheck") return res.writeHead(204).end();
    if (req.method !== "POST") return res.writeHead(404).end();
    const args = await payload(req);
    if (args.method === "getblockchaininfo") {
      assert.equal(req.headers.authorization, "Basic " + Buffer.from("watcher:SAMPLE_ONLY_PASSWORD").toString("base64"));
      return json(res, reply({
        chain: req.url.startsWith("/main") ? "main" : "test", blocks: 100, headers: 100,
        initialblockdownload: false, verificationprogress: 1,
      }));
    }
    if (args.method === "sync_state") return json(res, reply({ tip_number: "0xa", ibd: false }));
    if (args.method === "get_indexer_tip") return json(res, reply({ block_number: "0xa" }));
    if (args.method === "getTxProof") {
      assert.deepEqual(args.params, []);
      return json(res, badRequest);
    }
    if (args.method === "get_cells") {
      assert.equal(args.params[0].script_search_mode, "exact");
      return json(res, reply({ objects: [{ output_data: "0x07" }, { output_data: "0x" + spvCell.toString("hex") }] }));
    }
    return res.writeHead(404).end();
  }));
  writeFileSync(join(dir, "password"), "SAMPLE_ONLY_PASSWORD\n");
  writeFileSync(join(dir, "monitor.toml"), `
[monitor]
cors_origins = ["https://status.netlify.app", "https://status.example.com/"]
[networks.mainnet.btc]
url = "${target}/main/private-bitcoin"
username = "watcher"
password_file = "password"
[networks.mainnet.ckb]
url = "${target}/main/private-ckb"
[networks.mainnet.spv]
url = "${target}/main/private-spv"
[networks.mainnet.spv.type_script]
code_hash = "0x${"ab".repeat(32)}"
hash_type = "type"
args = "0x${"cd".repeat(32)}0100"
[networks.mainnet.blockbook]
url = "${target}/main/book"
[networks.mainnet.ckbadger]
url = "${target}/api/mainnet/v1/statistics/network"
public_url = "https://explorer.example.com/"
[networks.testnet3.btc]
url = "${target}/test/private-bitcoin"
username = "watcher"
password_file = "password"
[networks.testnet3.blockbook]
url = "${target}/test/book/api/"
[networks.testnet3.ckbadger]
url = "${target}/api/testnet/v1/statistics/network"
[[networks.testnet3.http]]
id = "asset-api"
label = "Asset API"
url = "${target}/private-asset/healthcheck"
github_url = "https://github.com/example/project/"
`);
  const cfg = loadConfig(join(dir, "monitor.toml"));
  const monitor = new Monitor(cfg, new HistoryStore(cfg.historyPath));
  const base = await listen(t, makeServer(cfg, () => monitor.snapshot));
  assert.equal((await fetch(base + "/")).status, 404);
  const pending = await (await fetch(base + "/api/status")).json();
  assert.equal(pending.updatedAt, null);
  assert.ok(pending.services.every(service => service.probeAvailable === null));
  assert.deepEqual(requests, []);
  await monitor.poll();
  const amount = requests.length;
  const headers = { Origin: "https://status.netlify.app" };
  const answer = await fetch(base + "/api/status", { headers });
  assert.equal(answer.headers.get("access-control-allow-origin"), headers.Origin);
  assert.equal(answer.headers.get("vary"), "Origin");
  assert.equal(answer.headers.get("cache-control"), "no-store");
  const raw = await answer.text();
  for (const privateValue of [target, "/private-bitcoin", "/private-asset", "SAMPLE_ONLY_PASSWORD", "watcher", "type_script"]) {
    assert.ok(!raw.includes(privateValue), privateValue);
  }
  const snapshot = JSON.parse(raw);
  const get = id => snapshot.services.find(service => service.id === id);
  assert.equal(snapshot.services.length, 9);
  assert.ok(snapshot.updatedAt);
  assert.ok(snapshot.services.every(service => service.probeAvailable === true));
  assert.equal(get("mainnet-spv").state, "synced");
  assert.equal(get("mainnet-spv").metrics.find(m => m.label === "链上 SPV 高度").value, 100);
  assert.equal(get("mainnet-btc").state, "synced");
  assert.equal(get("mainnet-blockbook").state, "synced");
  assert.equal(get("testnet3-blockbook").state, "synced");
  assert.equal(get("mainnet-ckbadger").progress, 0.2);
  assert.equal(get("mainnet-ckbadger").publicUrl, "https://explorer.example.com/");
  assert.equal(get("testnet3-http:asset-api").state, "online");
  assert.equal(get("testnet3-http:asset-api").githubUrl, "https://github.com/example/project");
  assert.equal(get("testnet3-http:asset-api").availability.windows[0].available, 1);
  const foreign = await fetch(base + "/api/status", { headers: { Origin: "https://other.netlify.app" } });
  assert.equal(foreign.headers.get("access-control-allow-origin"), null);
  const preload = await fetch(base + "/api/status", { method: "OPTIONS", headers: { ...headers, "Access-Control-Request-Method": "HEAD" } });
  assert.equal(preload.status, 204);
  assert.equal(preload.headers.get("access-control-allow-origin"), headers.Origin);
  assert.equal((await fetch(base + "/api/status?url=" + target)).status, 404);
  assert.equal((await fetch(base + "/api/status", { method: "POST", body: "{}" })).status, 405);
  assert.equal(requests.length, amount, "browser traffic must not trigger any probes");
});
test("keeps original SQLite history, counts samples and excludes monitor gaps", (t) => {
  const path = join(directory(t), "history.sqlite3");
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE availability_by_minute (
    minute INTEGER NOT NULL, service TEXT NOT NULL,
    available INTEGER NOT NULL CHECK (available >= 0 AND available <= total),
    total INTEGER NOT NULL CHECK (total > 0), PRIMARY KEY (minute, service)) WITHOUT ROWID;
    INSERT INTO availability_by_minute VALUES (10000, 'mainnet-btc', 2, 4);`);
  db.close();
  const now = 10000 * 60_000, samples = new Map([["mainnet-btc", true]]);
  let data = new HistoryStore(path).observe(samples, now)["mainnet-btc"];
  assert.deepEqual(data.windows.map(w => [w.available, w.total]), [[3, 5], [3, 5]]);
  const store = new HistoryStore(path);
  data = store.observe(samples, now + 1440 * 60_000)["mainnet-btc"];
  assert.deepEqual(data.windows.map(w => [w.available, w.total]), [[1, 1], [4, 6]]);
  data = store.observe(new Map([["mainnet-btc", false]]), now + 1440 * 60_000)["mainnet-btc"];
  assert.deepEqual(data.windows.map(w => [w.available, w.total]), [[1, 2], [4, 7]]);
  assert.deepEqual(store.observe(new Map(), now + 20000 * 60_000), {});
});
test("status remains live if history database is not writable", async (t) => {
  const dir = directory(t), path = join(dir, "config.toml");
  writeFileSync(path, '[monitor]\nhistory_path = "missing/history.sqlite3"\n');
  const cfg = loadConfig(path);
  const monitor = new Monitor(cfg, new HistoryStore(cfg.historyPath));
  await monitor.poll();
  assert.ok(monitor.snapshot.updatedAt);
  assert.ok(monitor.snapshot.historyError);
  assert.equal(monitor.snapshot.services.length, 0);
});
test("the latest probe result is independent of synchronization and historical samples", async (t) => {
  let failing = false;
  const upstream = await listen(t, createServer(async (req, res) => {
    if (req.url === "/proof") return json(res, badRequest);
    res.writeHead(failing ? 503 : 200).end();
  }));
  const path = join(directory(t), "config.toml");
  writeFileSync(path, `
[networks.mainnet.spv]
url = "${upstream}/proof"
[[networks.mainnet.http]]
id = "health"
label = "Health"
url = "${upstream}/healthcheck"
`);
  const cfg = loadConfig(path);
  const monitor = new Monitor(cfg, new HistoryStore(cfg.historyPath));
  await monitor.poll();
  failing = true;
  await monitor.poll();
  const base = await listen(t, makeServer(cfg, () => monitor.snapshot));
  const { services } = await (await fetch(base + "/api/status")).json();
  assert.equal(services[0].state, "unknown");
  assert.equal(services[0].probeAvailable, true);
  assert.equal(services[1].probeAvailable, false);
  assert.deepEqual(services[1].availability.windows.map(window => [window.available, window.total]), [[1, 2], [1, 2]]);
});
test("SPV cache, direct Core tip and optional CKB verification keep distinct observations", async (t) => {
  const at = 1_700_000_000;
  let cache = {bitcoinTip:{height:110,observedAt:at},localHeaderTip:{height:105,observedAt:null},confirmedClient:{startHeight:50,endHeight:90,observedAt:at}};
  const missing = {...badRequest,error:{code:-32601}};
  const cell=Buffer.alloc(113);cell[0]=7;cell.writeUInt32LE(70,33);cell.writeUInt32LE(95,37);
  const upstream = await listen(t, createServer(async (req,res) => {
    const {method}=await payload(req);
    if (method==="getTxProof") return json(res,badRequest);
    if (method==="getSyncStatus") return json(res,cache ? reply(cache) : missing);
    if (method==="get_cells") return json(res,reply({objects:[{output_data:"0x07"},{output_data:"0x"+cell.toString("hex")}]}));
    if (method==="getblockchaininfo") return json(res,reply({chain:"main",blocks:120,headers:120,initialblockdownload:false}));
    return json(res,missing);
  }));
  const path=join(directory(t),"config.toml");
  const cfg=`[networks.mainnet.spv]\nurl="${upstream}/spv"\n`;
  const poll=async (toml)=>{
    writeFileSync(path,toml);
    const settings=loadConfig(path);
    const m=new Monitor(settings,new HistoryStore(settings.historyPath)); await m.poll();
    return m.snapshot.services.find(row=>row.kind==="spv");
  };
  let service=await poll(cfg);
  let metrics=new Map(service.metrics.map(m=>[m.label,m]));
  assert.equal(service.probeAvailable,true);
  assert.equal(service.state,"unknown");
  assert.equal(metrics.get("SPV 观测的 BTC 高度").value,110);
  assert.equal(metrics.get("本地 SPV 高度").value,105);
  assert.equal(metrics.get("SPV 缓存的链上高度").observedAt,new Date(at*1000).toISOString());
  service=await poll(cfg+`
[networks.mainnet.spv.type_script]
code_hash="0x${"ab".repeat(32)}"
hash_type="type"
args="0x${"cd".repeat(32)}0100"
[networks.mainnet.ckb]
url="${upstream}/ckb"
[networks.mainnet.btc]
url="${upstream}/btc"
`);
  metrics=new Map(service.metrics.map(m=>[m.label,m.value]));
  assert.equal(metrics.get("链上 SPV 高度"),95);
  assert.equal(metrics.get("本地 BTC 高度"),120);
  assert.equal(metrics.has("SPV 缓存的链上高度"),false);
  cache={bitcoinTip:null,localHeaderTip:null,confirmedClient:null};
  service=await poll(cfg);
  assert.deepEqual(service.metrics.map(m=>m.label),["证明 RPC"]);
  cache=undefined;
  service=await poll(cfg);
  assert.equal(service.probeAvailable,true);
  assert.match(service.note,/type_script/);
});

test("Blockbook falls back to its backend blocks only with a matching chain and no error", async (t) => {
  let upstream = {chain:"main",blocks:100,headers:140};
  const node=await listen(t,createServer((_req,res)=>json(res,{
    backend:upstream,blockbook:{bestHeight:91,inSync:true,inSyncMempool:true},
  })));
  const path=join(directory(t),"config.toml");
  writeFileSync(path,`[networks.mainnet.blockbook]\nurl="${node}"\n`);
  const cfg=loadConfig(path);
  const monitor=new Monitor(cfg,new HistoryStore(cfg.historyPath));
  const check=async()=>{ await monitor.poll(); return monitor.snapshot.services[0]; };
  let service=await check();
  assert.equal(service.state,"unknown");
  assert.equal(service.metrics.find(row=>row.label==="Blockbook 上游高度").value,100);
  for (const invalid of [{blocks:100},{chain:"test",blocks:100},{chain:"main",blocks:100,error:"warming up"},{chain:"main",blocks:-1},{chain:"main",blocks:"100"}]) {
    upstream=invalid;
    service=await check();
    assert.ok(!service.metrics.some(row=>row.label==="Blockbook 上游高度"));
  }
});

test("never forwards authorization via redirects, and bounds response time/body", async (t) => {
  let arrived = false;
  const redirectTarget = await listen(t, createServer((_req,res) => { arrived = true; res.end(); }));
  const base = await listen(t, createServer(async (req, res) => {
    if (req.url === "/redirect") return res.writeHead(302, {Location: redirectTarget}).end();
    if (req.url === "/too-big") return res.end("x".repeat(2 * 1024 * 1024 + 1));
    if (req.url === "/partial") { res.write("{"); return; }
    return json(res, { id: 1, error: { code: -28, message: "private path" } }, 500);
  }));
  const endpoint = { kind: "btc", label: "BTC", authorization: "Basic testing" };
  assert.match((await probe("mainnet", {...endpoint, url: base + "/redirect"}, 1)).reading.note, /重定向/);
  assert.equal(arrived, false);
  assert.match((await probe("mainnet", {...endpoint, url: base + "/too-big"}, 1)).reading.note, /大小限制/);
  assert.equal((await probe("mainnet", {...endpoint, url: base + "/partial"}, 0.1)).reading.state, "offline");
  const warming = await probe("mainnet", {...endpoint, url: base}, 1);
  assert.equal(warming.available, true);
  assert.equal(warming.reading.state, "syncing");
  assert.ok(!warming.reading.note.includes("private"));
});
test("validates RPC URLs, public links and exact CORS configuration", (t) => {
  const dir = directory(t), path = join(dir, "config.toml");
  for (const url of ["http://test:secret@host/rpc", "http://host/rpc?", "http://host/rpc#"]) {
    writeFileSync(path, `[networks.mainnet.btc]\nurl = "${url}"\n`);
    assert.throws(() => loadConfig(path), /HTTP/);
  }
  for (const allowed of ["https://site.example/path", "*", "null"]) {
    writeFileSync(path, `[monitor]\ncors_origins = ["${allowed}"]\n`);
    assert.throws(() => loadConfig(path), /cors_origins/);
  }
  writeFileSync(path, '[networks.mainnet.btc]\nurl="http://private-host"\npublic_url="javascript:alert(1)"');
  assert.throws(() => loadConfig(path), /public_url/);
});
test("Netlify permalink CORS is opt-in, site-specific, and shared by reads and preflights", async (t) => {
  const path = join(directory(t), "config.toml");
  const id = "6b04b5a37287b99d17100bcc";
  const site = "chain-sync-monitor";
  const permalink = `https://${id}--${site}.netlify.app`;
  for (const invalid of ["", "https://site.netlify.app", "*.netlify.app", "Site", "bad--site", "-site", "site-", "a".repeat(64), "site\n", 123]) {
    writeFileSync(path, `[monitor]\ncors_netlify_site = ${JSON.stringify(invalid)}\n`);
    assert.throws(() => loadConfig(path), /cors_netlify_site/);
  }
  const explicit = "https://status.example.com";
  const branch = `https://staging--${site}.netlify.app`;
  writeFileSync(path, `[monitor]\ncors_origins = ["${explicit}", "${branch}"]\n`);
  const disabled = await listen(t, makeServer(loadConfig(path), () => ({})));
  assert.equal((await fetch(disabled + "/api/status", {headers: {Origin: permalink}}))
    .headers.get("access-control-allow-origin"), null);
  writeFileSync(path, `[monitor]\ncors_netlify_site = "${site}"\ncors_origins = ["${explicit}", "${branch}"]\n`);
  const base = await listen(t, makeServer(loadConfig(path), () => ({})));
  const status = base + "/api/status";
  const allowed = [permalink, `https://${"f".repeat(24)}--${site}.netlify.app`, `https://${site}.netlify.app`, explicit, branch];
  const denied = [
    "null", permalink.replace("https:", "http:"), permalink + ":443", permalink + ":8443",
    permalink + "/", permalink + "/api/status", permalink + "?", permalink + "#fragment",
    permalink + ".", permalink + ".example.com", `https://other.${id}--${site}.netlify.app`,
    `https://${id}--other-site.netlify.app`, `https://${id}-${site}.netlify.app`,
    `https://${id.slice(1)}--${site}.netlify.app`, `https://g${id.slice(1)}--${site}.netlify.app`,
    `https://${id}--${site}-other.netlify.app`, `https://deploy-preview-42--${site}.netlify.app`,
    `https://user@${id}--${site}.netlify.app`, permalink + ", " + explicit,
  ];
  for (const [origin, permitted] of [...allowed.map(origin => [origin, true]), ...denied.map(origin => [origin, false])]) {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      const headers = { Origin: origin };
      if (method === "OPTIONS") headers["Access-Control-Request-Method"] = "GET";
      const response = await fetch(status, {method, headers});
      assert.equal(response.status, method === "OPTIONS" ? permitted ? 204 : 405 : 200, origin);
      assert.equal(response.headers.get("access-control-allow-origin"), permitted ? origin : null, origin);
      assert.equal(response.headers.get("access-control-allow-credentials"), null);
      if (method === "OPTIONS" && permitted) assert.equal(response.headers.get("access-control-allow-methods"), "GET, HEAD");
    }
  }
  const unsupported = await fetch(status, {method: "OPTIONS", headers: {
    Origin: permalink, "Access-Control-Request-Method": "POST",
  }});
  assert.equal(unsupported.status, 405);
  assert.equal(unsupported.headers.get("access-control-allow-methods"), null);
  assert.equal((await fetch(base, {headers: {Origin: permalink}})).headers.get("access-control-allow-origin"), null);
});
test("co-deploy keeps static frontend and read-only status", async (t) => {
  const dir = directory(t), path = join(dir, "config.toml");
  writeFileSync(path, "");
  const cfg = loadConfig(path);
  const monitor = new Monitor(cfg, new HistoryStore(cfg.historyPath));
  const base = await listen(t, makeServer(cfg, () => monitor.snapshot, "dist/web"));
  const html = await fetch(base);
  assert.equal(html.status, 200);
  assert.ok((await html.text()).includes("<title>Chain Sync Monitor</title>"));
  const localeModule = await fetch(base + "/i18n.js");
  assert.equal((await fetch(base + "/presentation.js")).status, 200);
  assert.equal(localeModule.status, 200);
  assert.match(localeModule.headers.get("content-type"), /^text\/javascript/);
  const config = await fetch(base + "/config.js");
  assert.match(await config.text(), /"\/api\/status"/);
  const ticker = await fetch(base + "/app.js");
  const script = await ticker.text();
  assert.match(script, /CHAIN_SYNC_MONITOR_API_URL/);
  assert.match(script, /credentials: "same-origin"/);
  const head = await fetch(base + "/api/status", { method: "HEAD" });
  assert.equal(await head.text(), "");
  assert.match(head.headers.get("content-type"), /^application\/json/);
});
test("Netlify artifact embeds only the HTTPS status endpoint and restricts browser connections", (t) => {
  const file = "dist/web/config.js", headers = "dist/web/_headers";
  const keep = new Map([file, headers].map(path => [path, readFileSync(path)]));
  t.after(() => { for (const [path, content] of keep) writeFileSync(path, content); });
  const run = (STATUS_API_URL) => spawnSync(process.execPath, ["frontend/build.mjs"], {
    env: { ...process.env, NETLIFY: "true", STATUS_API_URL, BTC_PASSWORD: "sample-unrelated-secret" },
  });
  assert.equal(run("").status, 1);
  assert.equal(run("https://username:password@example.com/api/status").status, 1);
  assert.equal(run("https://api.example.com/api/status").status, 0);
  assert.match(readFileSync(file, "utf8"), /https:\/\/api.example.com\/api\/status/);
  assert.doesNotMatch(readFileSync(file, "utf8"), /sample-unrelated-secret/);
  assert.match(readFileSync(headers, "utf8"), /connect-src 'self' https:\/\/api.example.com/);
});
test("CKBadger warm-up does not mark the service available; wrong BTC network is not healthy", async (t) => {
  const base = await listen(t, createServer((req, res) => {
    if (req.url === "/badger") return json(res, { error: "initializing" }, 503);
    return json(res, reply({ chain: "main", blocks: 1, headers: 1, initialblockdownload: false }));
  }));
  const badger = await probe("testnet3", { kind: "ckbadger", label: "CKBadger", url: base + "/badger" }, 1);
  assert.equal(badger.reading.state, "syncing");
  assert.equal(badger.available, false);
  const btc = await probe("testnet3", { kind: "btc", label: "BTC", url: base }, 1);
  assert.equal(btc.reading.state, "degraded");
  assert.equal(btc.available, false);
});
