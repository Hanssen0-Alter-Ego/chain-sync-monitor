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

test("DOB Decoder uses its version RPC and records valid replies as availability, not sync", async (t) => {
  const dir = directory(t);
  const seen = [];
  const target = await listen(t, createServer(async (req, res) => {
    assert.equal(req.method, "POST");
    assert.equal(req.headers["content-type"], "application/json");
    assert.deepEqual(await payload(req), replyRequest);
    seen.push(req.url);
    if (req.url === "/valid") return json(res, reply(["dob/0", "dob/1", "dob/15"]));
    if (req.url === "/wrong-id") return json(res, { ...reply(["dob/0"]), id: 2 });
    if (req.url === "/wrong-version") return json(res, { ...reply(["dob/0"]), jsonrpc: "1.0" });
    if (req.url === "/failure") return json(res, { ...reply(["dob/0"]), error: { code: -32601 } });
    if (req.url === "/empty") return json(res, reply([]));
    if (req.url === "/mixed") return json(res, reply(["dob/0", "http"]));
    if (req.url === "/object") return json(res, reply({ versions: ["dob/0"] }));
    if (req.url === "/null") return json(res, reply(null));
    if (req.url === "/upstream-status") return json(res, reply(["dob/0"]), 503);
    return res.writeHead(200, { "Content-Type": "text/html" }).end("<p>Healthy</p>");
  }));
  const replyRequest = { jsonrpc: "2.0", method: "dob_protocol_version", params: [], id: 1 };
  const path = join(dir, "monitor.toml");
  writeFileSync(path, `[[groups.probes.services]]
kind = "dob_decoder"
network = "mainnet"
url = "${target}/valid"
[[groups.probes.services]]
kind = "dob_decoder"
network = "testnet"
url = "${target}/empty"
`);
  const cfg = loadConfig(path);
  const monitor = new Monitor(cfg, new HistoryStore(cfg.historyPath));
  await monitor.poll();
  assert.deepEqual([...seen].sort(), ["/empty", "/valid"]);
  assert.equal(monitor.snapshot.services[1].network, "testnet3");
  const [main, testnet] = monitor.snapshot.services;
  assert.equal(main.id, "mainnet-dob_decoder");
  assert.equal(main.state, "online");
  assert.equal(main.probeAvailable, true);
  assert.equal(main.metrics[0].value, "dob/0, dob/1, dob/15");
  assert.equal(main.progress, undefined);
  assert.equal(main.availability.windows[0].available, 1);
  assert.equal(testnet.id, "testnet3-dob_decoder");
  assert.equal(testnet.probeAvailable, false);
  assert.equal(testnet.availability.windows[0].available, 0);
  for (const url of ["/wrong-id", "/wrong-version", "/failure", "/empty", "/mixed", "/object", "/null", "/upstream-status", "/not-json"]) {
    const failed = await probe("mainnet", { ...cfg.endpoints.mainnet.get("dob_decoder"), url: target + url }, 1);
    assert.equal(failed.available, false, url);
    assert.notEqual(failed.reading.state, "online", url);
  }
});

test("SPV script fields are optional, but must be valid together", (t) => {
  const path = join(directory(t), "monitor.toml");
  const service = `[[groups.ckb.services]]
kind = "spv"
network = "testnet"
url = "https://spv.example"
`;
  const load = (toml) => { writeFileSync(path, toml); return loadConfig(path); };
  assert.equal(load(service).endpoints.testnet3.get("spv").typeScript, undefined);
  assert.throws(() => load(service + 'hash_type = "type"'), /code_hash.*hash_type.*args/);
  assert.throws(() => load(service + `code_hash = "0x${"aa".repeat(32)}"
hash_type = "invalid"
args = "0x${"bb".repeat(34)}"`), /code_hash.*hash_type.*args/);
  assert.throws(() => load(service.replace('network = "testnet"', 'network = "invalid"')), /network/);
  assert.throws(() => load(service + '[groups.ckb.services.extra]'), /不支持的 SPV 配置项/);
  assert.throws(() => load('[extra]'), /配置顶层仅支持/);
});

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
        initialblockdownload: false, verificationprogress: 1, bestblockhash: "0".repeat(64),
      }));
    }
    if (args.method === "getindexinfo") {
      assert.deepEqual(args.params, []);
      assert.equal(req.headers.authorization, "Basic " + Buffer.from("watcher:SAMPLE_ONLY_PASSWORD").toString("base64"));
      return json(res, reply(req.url.startsWith("/main") ? {
        txindex: { synced: true, best_block_height: 100 },
        txospenderindex: { synced: false, best_block_height: 0 },
      } : { txindex: { synced: false, best_block_height: 50 }, coinstatsindex: {} }));
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
[[groups.probes.services]]
kind = "btc"
network = "mainnet"
url = "${target}/main/private-bitcoin"
username = "watcher"
password_file = "password"
[[groups.probes.services]]
kind = "ckb"
network = "mainnet"
url = "${target}/main/private-ckb"
[[groups.probes.services]]
kind = "spv"
network = "mainnet"
url = "${target}/main/private-spv"
code_hash = "0x${"ab".repeat(32)}"
hash_type = "type"
args = "0x${"cd".repeat(32)}0100"
[[groups.probes.services]]
kind = "blockbook"
network = "mainnet"
url = "${target}/main/book"
[[groups.probes.services]]
kind = "ckbadger"
network = "mainnet"
url = "${target}/api/mainnet/v1/statistics/network"
public_url = "https://explorer.example.com/"
[[groups.probes.services]]
kind = "btc"
network = "testnet"
url = "${target}/test/private-bitcoin"
username = "watcher"
password_file = "password"
[[groups.probes.services]]
kind = "blockbook"
network = "testnet"
url = "${target}/test/book/api/"
[[groups.probes.services]]
kind = "ckbadger"
network = "testnet"
url = "${target}/api/testnet/v1/statistics/network"
[[groups.probes.services]]
kind = "http"
network = "testnet"
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
  for (const privateValue of [target, "/private-bitcoin", "/private-asset", "SAMPLE_ONLY_PASSWORD", "watcher", "code_hash"]) {
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
  assert.deepEqual(get("mainnet-btc").bitcoinIndexes, {
    txindex: { state: "synced", height: 100 },
    txospenderindex: { state: "syncing", height: 0 },
  });
  assert.deepEqual(get("testnet3-btc").bitcoinIndexes, {
    txindex: { state: "syncing", height: 50 },
    txospenderindex: { state: "disabled" },
  });
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
test("unavailable Bitcoin index status never downgrades a healthy chain probe", async (t) => {
  const url = await listen(t, createServer(async (req, res) => {
    const { method } = await payload(req);
    if (method === "getblockchaininfo") return json(res, reply({
      chain: "main", blocks: 27, headers: 27, initialblockdownload: false,
    }));
    assert.equal(method, "getindexinfo");
    switch (req.url) {
      case "/legacy": return json(res, { id: 1, error: { code: -32601 } }, 404);
      case "/forbidden": return res.writeHead(403).end();
      case "/malformed": return json(res, reply([]));
      case "/partial": return json(res, reply({
        txindex: { synced: false, best_block_height: 25 },
        txospenderindex: { synced: false, best_block_height: "25" },
      }));
      default: return res.writeHead(500).end();
    }
  }));
  for (const path of ["/legacy", "/forbidden", "/malformed", "/partial"]) {
    const { reading, available, tip } = await probe("mainnet", { url: url + path, kind: "btc", label: "Bitcoin Core" }, 0.5);
    assert.equal(available, true, path);
    assert.equal(reading.state, "synced", path);
    assert.equal(tip.height, 27, path);
    assert.deepEqual(reading.bitcoinIndexes, {
      txindex: path === "/partial" ? { state: "syncing", height: 25 } : { state: "unavailable" },
      txospenderindex: { state: "unavailable" },
    }, path);
  }
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
  assert.equal(data.dayBins.length, 12);
  assert.deepEqual(data.dayBins[0], { startMinute: 8561, available: 0, total: 0 });
  assert.deepEqual(data.dayBins[11], { startMinute: 9881, available: 3, total: 5 });
  const store = new HistoryStore(path);
  data = store.observe(samples, now + 1440 * 60_000)["mainnet-btc"];
  assert.deepEqual(data.windows.map(w => [w.available, w.total]), [[1, 1], [4, 6]]);
  data = store.observe(new Map([["mainnet-btc", false]]), now + 1440 * 60_000)["mainnet-btc"];
  assert.deepEqual(data.windows.map(w => [w.available, w.total]), [[1, 2], [4, 7]]);
  assert.deepEqual(data.dayBins[11], { startMinute: 11321, available: 1, total: 2 });
  assert.equal(data.dayBins.slice(0, 11).every(bin => bin.total === 0), true);
  data = store.observe(new Map([["mainnet-btc", true]]), now + 1560 * 60_000)["mainnet-btc"];
  assert.deepEqual(data.dayBins[10], { startMinute: 11321, available: 1, total: 2 });
  assert.deepEqual(data.dayBins[11], { startMinute: 11441, available: 1, total: 1 });
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
[[groups.probes.services]]
kind = "spv"
network = "mainnet"
url = "${upstream}/proof"
[[groups.probes.services]]
kind = "http"
network = "mainnet"
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
test("poll certifies near-tip lag without concealing initial sync or unrelated component lag", async (t) => {
  let initial = false, mempool = true, indexHeight = 98;
  const upstream = await listen(t, createServer(async (req, res) => {
    if (req.url.includes("/book")) return json(res, {backend:{chain:"main"}, blockbook:{
      bestHeight:99, inSync:false, inSyncMempool:mempool, initialSync:initial,
    }});
    if (req.url.includes("/explorer")) return json(res, {syncStatus:{
      syncedBlock:99, tipBlock:100, syncMode:initial ? "bulk" : "normal", isSyncing:true,
    }});
    const {method} = await payload(req);
    if (method === "getblockchaininfo") return json(res, reply({chain:"main",blocks:100,headers:100,initialblockdownload:initial}));
    if (method === "getindexinfo") return json(res, reply({txindex:{synced:false,best_block_height:indexHeight}}));
    if (method === "sync_state") return json(res, reply({tip_number:"0x63",best_known_block_number:"0x64",ibd:initial}));
    if (method === "get_indexer_tip") return json(res, reply({block_number:"0x62"}));
    return res.writeHead(404).end();
  }));
  const path = join(directory(t), "config.toml");
  writeFileSync(path, ["btc","ckb","blockbook","ckbadger"].map((kind,index) =>
    `[[groups.probes.services]]
kind = "${kind}"
network = "mainnet"
url="${upstream}/${["btc","ckb","book","explorer"][index]}"
`).join(""));
  const settings = loadConfig(path);
  const monitor = new Monitor(settings,new HistoryStore(settings.historyPath));
  const snapshot = async () => {
    await monitor.poll();
    return Object.fromEntries(monitor.snapshot.services.map(r => [r.kind,r]));
  };
  let data = await snapshot();
  assert.equal(data.btc.syncTipLag, 2);
  assert.equal(data.btc.bitcoinIndexes.txindex.state, "syncing");
  assert.equal(data.ckb.syncTipLag, 2, "compare indexer with known tip across both CKB legs");
  assert.equal(data.blockbook.syncTipLag, 1);
  assert.equal(data.ckbadger.syncTipLag, 1);
  assert.equal(data.ckb.state, "syncing");
  assert.equal(data.blockbook.state, "syncing");
  initial = true;
  data = await snapshot();
  for (const kind of ["btc","ckb","blockbook","ckbadger"]) {
    assert.equal(data[kind].syncTipLag, undefined, kind + " initial sync");
  }
  initial = false;
  mempool = false;
  indexHeight = 90;
  data = await snapshot();
  assert.equal(data.blockbook.syncTipLag, undefined, "mempool outage is not a single-block lag");
  assert.equal(data.btc.syncTipLag, 10, "node tip at zero cannot hide its slower index");
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
    if (method==="getblockhash") return json(res,reply("0".repeat(64)));
    return json(res,missing);
  }));
  const path=join(directory(t),"config.toml");
  const cfg=`[[groups.probes.services]]
kind = "spv"
network = "mainnet"\nurl="${upstream}/spv"\n`;
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
  assert.equal(service.syncTipLag,undefined,"cache-only SPV is not certified");
  assert.equal(metrics.get("SPV 观测的 BTC 高度").value,110);
  assert.equal(metrics.get("本地 SPV 高度").value,105);
  assert.equal(metrics.get("SPV 缓存的链上高度").observedAt,new Date(at*1000).toISOString());
  service=await poll(cfg+`
code_hash="0x${"ab".repeat(32)}"
hash_type="type"
args="0x${"cd".repeat(32)}0100"
[[groups.probes.services]]
kind = "ckb"
network = "mainnet"
url="${upstream}/ckb"
[[groups.probes.services]]
kind = "btc"
network = "mainnet"
url="${upstream}/btc"
`);
  metrics=new Map(service.metrics.map(m=>[m.label,m.value]));
  assert.equal(metrics.get("链上 SPV 高度"),95);
  assert.equal(service.syncTipLag,25,"live SPV compared with synced BTC");
  assert.equal(metrics.get("本地 BTC 高度"),120);
  assert.equal(metrics.has("SPV 缓存的链上高度"),false);
  cache={bitcoinTip:null,localHeaderTip:null,confirmedClient:null};
  service=await poll(cfg);
  assert.deepEqual(service.metrics.map(m=>m.label),["证明 RPC"]);
  cache=undefined;
  service=await poll(cfg);
  assert.equal(service.probeAvailable,true);
  assert.match(service.note,/code_hash/);
});

test("Blockbook falls back to its backend blocks only with a matching chain and no error", async (t) => {
  let upstream = {chain:"main",blocks:100,headers:140};
  const node=await listen(t,createServer((_req,res)=>json(res,{
    backend:upstream,blockbook:{bestHeight:91,inSync:true,inSyncMempool:true},
  })));
  const path=join(directory(t),"config.toml");
  writeFileSync(path,`[[groups.probes.services]]
kind = "blockbook"
network = "mainnet"\nurl="${node}"\n`);
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
    writeFileSync(path, `[[groups.probes.services]]
kind = "btc"
network = "mainnet"\nurl = "${url}"\n`);
    assert.throws(() => loadConfig(path), /HTTP/);
  }
  for (const allowed of ["https://site.example/path", "*", "null"]) {
    writeFileSync(path, `[monitor]\ncors_origins = ["${allowed}"]\n`);
    assert.throws(() => loadConfig(path), /cors_origins/);
  }
  writeFileSync(path, `[[groups.probes.services]]
kind = "btc"
network = "mainnet"\nurl="http://private-host"\npublic_url="javascript:alert(1)"`);
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
  for (const path of ["/locales.js", "/de.js", "/fr.js", "/favicon.svg", "/og.png"]) {
    const asset = await fetch(base + path);
    assert.equal(asset.status, 200, path);
    const mime = path.endsWith(".js") ? "text/javascript" : path.endsWith(".png") ? "image/png" : "image/svg+xml";
    assert.equal(asset.headers.get("content-type").split(";")[0], mime, path);
  }
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
  const file = "dist/web/config.js", headers = "dist/web/_headers", index = "dist/web/index.html";
  const keep = new Map([file, headers, index].map(path => [path, readFileSync(path)]));
  t.after(() => { for (const [path, content] of keep) writeFileSync(path, content); });
  const run = (STATUS_API_URL, URL) => spawnSync(process.execPath, ["frontend/build.mjs"], {
    env: { ...process.env, NETLIFY: "true", URL, STATUS_API_URL, BTC_PASSWORD: "sample-unrelated-secret" },
  });
  assert.equal(run("").status, 1);
  assert.equal(run("https://username:password@example.com/api/status").status, 1);
  assert.equal(run("https://api.example.com/api/status").status, 0);
  assert.match(readFileSync(file, "utf8"), /https:\/\/api.example.com\/api\/status/);
  assert.match(readFileSync(index, "utf8"), /property="og:url" content="https:\/\/chain-sync-monitor\.netlify\.app\/"/);
  assert.doesNotMatch(readFileSync(file, "utf8"), /sample-unrelated-secret/);
  assert.match(readFileSync(headers, "utf8"), /connect-src 'self' https:\/\/api.example.com/);
  assert.equal(run("https://api.example.com/api/status", "https://monitor.example.org").status, 0);
  assert.match(readFileSync(index, "utf8"), /property="og:image" content="https:\/\/monitor\.example\.org\/og\.png"/);
  assert.match(readFileSync(index, "utf8"), /property="og:url" content="https:\/\/monitor\.example\.org\/"/);
  assert.equal(run("https://api.example.com/api/status", "https://attacker@example.org/deploy").status, 0);
  assert.match(readFileSync(index, "utf8"), /property="og:image" content="https:\/\/chain-sync-monitor\.netlify\.app\/og\.png"/);
  assert.match(readFileSync(index, "utf8"), /property="og:url" content="https:\/\/chain-sync-monitor\.netlify\.app\/"/);
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

test("SPV checks a configured independent reference at the exact CKB client height", async t => {
  const height = 977560;
  const accepted = "0000000000000000000129e025b9ebc6269a1ca4fd7532b7e1ca4fce876ad30a";
  const competing = "ab".repeat(32);
  const cell = Buffer.alloc(113);
  cell[0] = 27;
  Buffer.from(accepted, "hex").reverse().copy(cell, 1);
  cell.writeUInt32LE(975744, 33);
  cell.writeUInt32LE(height, 37);
  let referenceHeight = height;
  let referenceTipHash = accepted.toUpperCase();
  let historical = accepted;
  let referenceChain = "main";
  let referenceIbd = false;
  let referenceRequests = [];
  const upstream = await listen(t, createServer(async (req, res) => {
    const { method, params } = await payload(req);
    if (method === "get_cells") return json(res, reply({ objects: [
      { output_data: "0x1b" }, { output_data: "0x" + cell.toString("hex") },
    ] }));
    if (method === "getTxProof") return json(res, badRequest);
    if (req.url === "/reference") {
      assert.equal(req.headers.authorization, "Basic " + Buffer.from("reference-user:REFERENCE_ONLY").toString("base64"));
      referenceRequests.push([method, params]);
      if (method === "getblockchaininfo") return json(res, reply({
        chain: referenceChain, blocks: referenceHeight, headers: referenceHeight, initialblockdownload: referenceIbd,
        bestblockhash: referenceTipHash,
      }));
      if (method === "getblockhash") return json(res, reply(historical));
    }
    if (method === "getblockchaininfo") return json(res, reply({
      chain: "main", blocks: height, headers: height, initialblockdownload: false, bestblockhash: accepted,
    }));
    return json(res, {...badRequest, error: {code: -32601}});
  }));
  const path = join(directory(t), "config.toml");
  writeFileSync(path, `
[[groups.probes.services]]
kind = "spv"
network = "mainnet"
url="${upstream}/spv"
code_hash="0x${"ab".repeat(32)}"
hash_type="type"
args="0x${"cd".repeat(32)}0100"
[groups.probes.services.bitcoin_reference]
url="${upstream}/reference"
username="reference-user"
password="REFERENCE_ONLY"
[[groups.probes.services]]
kind = "ckb"
network = "mainnet"
url="${upstream}/ckb"
[[groups.probes.services]]
kind = "btc"
network = "mainnet"
url="${upstream}/btc"
`);
  const cfg = loadConfig(path);
  const monitor = new Monitor(cfg, new HistoryStore(cfg.historyPath));
  const base = await listen(t, makeServer(cfg, () => monitor.snapshot));
  async function poll(state, comparison) {
    referenceRequests = [];
    await monitor.poll();
    const raw = await (await fetch(base + "/api/status")).text();
    for (const secret of ["REFERENCE_ONLY", "reference-user", upstream, accepted, competing]) assert.ok(!raw.includes(secret));
    const svc = JSON.parse(raw).services.find(s => s.id === "mainnet-spv");
    assert.equal(svc.state, state);
    assert.equal(svc.metrics.find(m => m.label === "SPV 区块哈希校验")?.value, comparison);
    assert.equal(svc.probeAvailable, true, "a hash mismatch is not an RPC outage");
    return svc;
  }
  await poll("synced", "一致");
  assert.deepEqual(referenceRequests, [["getblockchaininfo", []]]);
  referenceTipHash = competing;
  await poll("unknown", "等待复查");
  referenceTipHash = accepted;
  await poll("synced", "一致");
  referenceTipHash = competing;
  await poll("unknown", "等待复查");
  await poll("degraded", "确认分歧");
  referenceHeight++;
  const svc = await poll("syncing", "一致");
  assert.deepEqual(referenceRequests, [["getblockchaininfo", []], ["getblockhash", [height]]]);
  assert.equal(svc.syncTipLag, 1);
  historical = "invalid";
  await poll("unknown", "暂不可比");
  historical = competing;
  await poll("unknown", "等待复查");
  referenceChain = "test";
  await poll("unknown", "暂不可比");
  assert.deepEqual(referenceRequests, [["getblockchaininfo", []]]);
  referenceChain = "main";
  referenceIbd = true;
  await poll("unknown", "暂不可比");
  referenceIbd = false;
  referenceHeight = height - 1;
  await poll("unknown", "暂不可比");
  assert.deepEqual(referenceRequests, [["getblockchaininfo", []]]);
  referenceHeight = height;
  await poll("unknown", "等待复查");
});

test("named groups mix networks and unscoped apps without changing existing uptime IDs", async (t) => {
  const dir = directory(t);
  const url = await listen(t, createServer((_req, res) => res.end("ok")));
  const path = join(dir, "monitor.toml");
  writeFileSync(path, `[[groups.probes.services]]
kind = "http"
network = "testnet"
id = "portal"
label = "Portal test"
url = "${url}"
`);
  const initial = loadConfig(path);
  const history = new HistoryStore(initial.historyPath);
  const first = new Monitor(initial, history);
  await first.poll();
  const moved = `[groups."Ops & apps"]
label = "运维 / Apps"

[[groups."Ops & apps".services]]
kind = "http"
id = "portal"
label = "Portal test"
network = "testnet"
url = "${url}"

[[groups."Ops & apps".services]]
kind = "http"
id = "portal"
label = "Portal"
url = "${url}"

[[groups."Ops & apps".services]]
kind = "http"
id = "portal"
label = "Portal main"
network = "mainnet"
url = "${url}"
`;
  writeFileSync(path, moved);
  const monitor = new Monitor(loadConfig(path), history);
  await monitor.poll();
  const services = JSON.parse(JSON.stringify(monitor.snapshot)).services;
  assert.deepEqual(services.map(service => service.id), ["mainnet-http:portal", "testnet3-http:portal", "service-http:portal"]);
  assert.deepEqual(services.map(service => service.network), ["mainnet", "testnet3", undefined]);
  assert.ok(!Object.hasOwn(services[2], "network"));
  assert.ok(services.every(service => service.state === "online"));
  assert.ok(services.every(service => service.group.id === "Ops & apps" && service.group.label === "运维 / Apps"));
  assert.deepEqual(services.map(service => service.availability.windows[0].total), [1, 2, 1]);
  writeFileSync(path, moved.replace('network = "mainnet"', 'network = "testnet"'));
  assert.throws(() => loadConfig(path), /重复/);
  writeFileSync(path, `[[groups.any.services]]
kind = "btc"
url = "${url}"`);
  assert.throws(() => loadConfig(path), /network/);
});
