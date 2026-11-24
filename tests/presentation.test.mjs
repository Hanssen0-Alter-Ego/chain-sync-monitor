import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createAttentionTracker, currentProbe, probeTotals, projectRepository, servicePriority, syncComparisons, uptimeBins, uptimeDay, uptimeFillColor } from "../dist/web/presentation.js";

test("a mixed network shows four of five online without conflating sync and reachability", () => {
  const services = [
    { kind: "btc", state: "offline", probeAvailable: false, availability: { windows: [{ ratio: 1 }] } },
    { kind: "ckb", state: "synced", probeAvailable: true },
    { kind: "blockbook", state: "syncing", probeAvailable: true },
    { kind: "spv", state: "unknown", probeAvailable: true },
    { kind: "ckbadger", state: "syncing", probeAvailable: true },
  ];
  assert.deepEqual(probeTotals(services), { online: 4, unconfirmed: 0, total: 5 });
  services[4].probeAvailable = false;
  assert.deepEqual(probeTotals(services), { online: 3, unconfirmed: 0, total: 5 });
});

test("legacy ambiguous samples and explicit pending samples do not pretend to be online", () => {
  assert.equal(currentProbe({ kind: "ckbadger", state: "syncing", availability: { windows: [{ ratio: 1 }] } }), null);
  assert.equal(currentProbe({ kind: "ckb", state: "syncing" }), true);
  assert.equal(currentProbe({ kind: "spv", state: "unknown", metrics: [{ label: "证明 RPC", value: "在线" }] }), true);
  assert.equal(currentProbe({ kind: "spv", state: "unknown", metrics: [{ label: "RPC", value: "在线" }] }), null);
  assert.equal(currentProbe({ kind: "ckb", state: "synced", probeAvailable: null }), null);
});

test("service priority keeps failed probes ahead of incomplete sync and ready services", () => {
  assert.equal(servicePriority({kind:"btc", state:"synced", probeAvailable:false}), 0);
  assert.equal(servicePriority({kind:"ckbadger", state:"offline"}), 0);
  for (const state of ["syncing", "unknown", "degraded"]) {
    assert.equal(servicePriority({kind:"ckbadger", state, probeAvailable:true}), 1);
  }
  assert.equal(servicePriority({kind:"ckb", state:"synced", probeAvailable:null}), 1);
  assert.equal(servicePriority({kind:"http", state:"online", probeAvailable:true}), 2);
  assert.equal(servicePriority({kind:"ckb", state:"synced"}), 2);
  const btc = {kind:"btc", state:"synced", probeAvailable:true};
  assert.equal(servicePriority({...btc, bitcoinIndexes:{txindex:{state:"syncing"}}}), 1);
  assert.equal(servicePriority({...btc, bitcoinIndexes:{txindex:{state:"disabled"}}}), 2);
});

test("only credible near-tip gaps are tolerated and duplicates never count as probes", () => {
  const watch = createAttentionTracker();
  const service = {id:"mainnet-ckbadger", kind:"ckbadger", state:"syncing", probeAvailable:true};
  const snapshot = (second, reading) => ({ updatedAt: `2026-11-24T00:00:${String(second).padStart(2,"0")}Z`,
    services: [{ ...service, ...reading }] });
  const priority = (second, reading) => watch(snapshot(second, reading)).get(service.id).priority;
  const legacy = (lag, mode = "normal") => ({metrics: [
    {label:"索引模式",value:mode}, {label:"落后",value:lag},
    {label:"索引高度",value:100 - lag}, {label:"CKB 目标高度",value:100},
  ]});
  assert.equal(priority(1, legacy(3)), 1, "starting behind is not debounced");
  assert.equal(priority(2, legacy(2)), 2);
  assert.equal(priority(3, legacy(3)), 2);
  assert.equal(priority(3, legacy(3)), 2, "the same upstream observation cannot advance the debounce");
  assert.equal(priority(4, legacy(3)), 1);
  assert.equal(priority(5, legacy(2)), 2, "recovery is immediate");
  assert.equal(priority(6, legacy(5)), 1, "material lag is immediate");
  assert.equal(priority(7, legacy(2)), 2);
  assert.equal(priority(8, {...legacy(2),probeAvailable:false}), 0);
  assert.equal(priority(9, {...legacy(1),state:"unknown"}), 1);
  assert.equal(priority(10, {...legacy(1),state:"degraded"}), 1);
  assert.equal(priority(11, legacy(1,"bulk")), 1);
  assert.equal(priority(12, {kind:"btc",syncTipLag:1}), 2);
  assert.equal(priority(13, {kind:"btc",syncTipLag:0,bitcoinIndexes:{txindex:{state:"syncing",height:100}}}), 1);
  assert.equal(priority(14, {kind:"ckb",metrics:legacy(1).metrics}), 1, "do not guess legacy CKB IBD");
});

test("the uptime chart uses counted probes and rejects missing or impossible samples", () => {
  const window = (available, total) => ({ seconds: 86_400, available, total, ratio: null });
  assert.equal(uptimeDay({windows: [window(0, 0)]}), undefined);
  assert.equal(uptimeDay({windows: [window(2, 1)]}), undefined);
  assert.equal(uptimeDay({windows: [{ ...window(4, 5), seconds: 604_800 }]}), undefined);
  assert.deepEqual(uptimeDay({windows: [window(0, 2)]}), window(0, 2));
});

test("uptime bins keep exact proportions and probe states", () => {
  const samples = [[480,480], [479,480], [98,100], [97,100], [90,100], [45,100], [0,70], [0,0]];
  const dayBins = Array.from({length:12}, (_, i) => {
    const [available, total] = samples[i] ?? [0,0];
    return {startMinute: i * 120, available, total};
  });
  const bins = uptimeBins({dayBins, windows:[]});
  assert.deepEqual(bins.slice(0,8).map(({ratio, state})=>[ratio,state]), [
    [1,"up"], [479/480,"mixed"], [.98,"mixed"], [.97,"mixed"],
    [.9,"mixed"], [.45,"mixed"], [0,"down"], [null,"empty"],
  ]);
  assert.equal(uptimeBins({dayBins: dayBins.slice(1), windows:[]}), null);
});

test("comparisons use real observations and show bars even near the tip", () => {
  const check = (kind, rows) => syncComparisons({kind, metrics: rows.map(([label,value]) => ({label,value}))});
  const [verified,indexer] = check("ckb", [["节点区块高度",10000],["已知区块高度",10001],["索引器高度",10000]]);
  assert.equal(verified.ratio, 10000/10001);
  assert.equal(indexer.ratio, 1);
  assert.equal(verified.lag, 1);
  const [book] = check("blockbook", [["索引高度", 80], ["Blockbook 上游高度", 100]]);
  assert.equal(book.ratio, .8);
  assert.equal(book.lag, 20);
  assert.equal(check("blockbook", [["索引高度",0]])[0].ratio, undefined);
  const [chain,local] = check("spv", [["SPV 缓存的链上高度",80], ["本地 SPV 高度",90], ["本地 BTC 高度",100]]);
  assert.equal(chain.target.label, "本地 SPV 高度");
  assert.equal(chain.lag, 10);
  assert.equal(local.lag, 10);
  assert.equal(check("spv", [["SPV 缓存的链上高度",91], ["本地 SPV 高度",90]])[0].ratio, undefined);
});

test("BTC optional index rows compare measured progress to the verified tip", () => {
  const service = {kind:"btc",metrics:[{label:"已验证区块高度",value:100},{label:"区块头高度",value:120}]};
  assert.equal(syncComparisons(service).length, 1);
  const [node, tx, spender] = syncComparisons({ ...service, bitcoinIndexes: {
    txindex: {state:"syncing",height:75}, txospenderindex:{state:"disabled"},
  } });
  assert.equal(node.target.value, 120);
  assert.equal(tx.target.value, 100);
  assert.equal(tx.lag, 25);
  assert.equal(tx.ratio, .75);
  assert.equal(tx.index.name, "txindex");
  assert.equal(spender.index.state, "未启用");
  assert.equal(spender.ratio, undefined);
});

test("GitHub repository icons do not conflate public service links or arbitrary probe IDs", () => {
  assert.equal(projectRepository({kind:"ckbadger"}), "https://github.com/janx/ckbadger");
  assert.equal(projectRepository({kind:"http",id:"testnet3-http:btc-asset-api"}), "https://github.com/RGBPlusPlus/btc-assets-api");
  assert.equal(projectRepository({kind:"http",id:"testnet3-http:other",publicUrl:"https://example.org"}), undefined);
  assert.equal(projectRepository({kind:"http",githubUrl:"https://github.com/owner/repo"}), "https://github.com/owner/repo");
  for (const githubUrl of ["http://github.com/owner/repo","https://github.com/owner/..","https://github.com/owner/repo/issues","https://gh.example/owner/repo","https://x@github.com/owner/repo"]) {
    assert.equal(projectRepository({kind:"http",githubUrl}), undefined);
  }
});

test("built dashboard prioritizes both networks and preserves expanded rows across recovery", async () => {
  class Element {
    children = [];
    tagName = "DIV";
    nodeType = 1;
    get nodeName() { return this.tagName.toUpperCase(); }
    get childNodes() { return [...this.children, ...this.selectors.values()].filter(item => item instanceof Element); }
    get firstChild() { return this.childNodes[0] ?? null; }
    get nextSibling() {
      const siblings = this.parentElement?.childNodes ?? [];
      return siblings[siblings.indexOf(this) + 1] ?? null;
    }
    get isConnected() { return this === globalThis.document || this.parentElement?.isConnected === true; }
    getAttributeNames() { return [...Object.keys(this.attrs), ...Object.keys(this.dataset).map(key => key === "renderKey" ? "data-render-key" : `data-${key}`), ...(this.hidden === true ? ["hidden"] : []), ...(this.open ? ["open"] : []), ...(this.textContent === undefined ? [] : ["test-text"]), ...(this.title === undefined ? [] : ["title"]), ...(this.href === undefined ? [] : ["href"])]; }
    hasAttribute(key) { return this.getAttributeNames().includes(key); }
    removeAttribute(key) { if (key === "hidden") this.hidden = false; else delete this.attrs[key]; }
    insertBefore(child, anchor) {
      if (child.stubSelector) {
        this.selectors.set(child.stubSelector, child);
        child.parentElement = this;
        return child;
      }
      child.parentElement?.removeChild(child);
      const index = this.children.indexOf(anchor);
      this.children.splice(index < 0 ? this.children.length : index, 0, child);
      child.parentElement = this;
      return child;
    }
    removeChild(child) {
      for (let focus = globalThis.document.activeElement; focus; focus = focus.parentElement) {
        if (focus === child) globalThis.document.activeElement = globalThis.document;
      }
      if (child.stubSelector) this.selectors.delete(child.stubSelector);
      else {
        const index = this.children.indexOf(child);
        if (index >= 0) this.children.splice(index, 1);
      }
      child.parentElement = undefined;
    }
    closest(selector) {
      if (selector === "[hidden]" && this.hidden === true) return this;
      if (selector === "article[data-render-key]" && this.nodeName === "ARTICLE" && this.dataset.renderKey) return this;
      return this.parentElement?.closest(selector) ?? null;
    }
    dataset = {};
    attrs = {};
    selectors = new Map();
    handlers = new Map();
    querySelector(selector) {
      if (selector === ".network" || selector === "article") return this;
      if (selector === ".service-details > summary") return this.querySelector(".service-details").querySelector("summary");
      if (!this.selectors.has(selector)) {
        const node = new Element();
        node.parentElement = this;
        node.stubSelector = selector;
        if (selector.includes("details") || selector === ".uptime-breakdown") node.tagName = "DETAILS";
        this.selectors.set(selector, node);
      }
      return this.selectors.get(selector);
    }
    querySelectorAll(selector) {
      const output = [];
      const walk = (node) => {
        if (!(node instanceof Element)) return;
        if ((selector === ".service-details[open]" && node.open)
            || (selector === "article[data-render-key]" && node.nodeName === "ARTICLE" && node.dataset.renderKey)) output.push(node);
        for (const child of [...node.children, ...node.selectors.values()]) walk(child);
      };
      walk(this);
      return output;
    }
    cloneNode() { return Object.assign(new Element(), {tagName: this.tagName}); }
    append(...children) { for (const child of children) { if (child instanceof Element) child.parentElement = this; this.children.push(child); } }
    replaceChildren(...children) { this.children = children; }
    hasChildNodes() { return this.children.length > 0; }
    addEventListener(event, listener) { this.handlers.set(event, listener); }
    setAttribute(key, value) {
      if (key === "data-render-key") this.dataset.renderKey = value;
      else if (key.startsWith("data-")) this.dataset[key.slice(5)] = value;
      else if (key === "hidden") this.hidden = true;
      else if (key === "test-text") this.textContent = value;
      else if (key === "title" || key === "href") this[key] = value;
      else this.attrs[key] = value;
    }
    getAttribute(key) {
      if (key === "data-render-key") return this.dataset.renderKey ?? null;
      if (key.startsWith("data-")) return this.dataset[key.slice(5)] ?? null;
      if (key === "hidden") return this.hidden ? "" : null;
      if (key === "test-text") return this.textContent ?? null;
      if (key === "href" || key === "title") return this[key] ?? null;
      return this.attrs[key] ?? null;
    }
    matches(selector) { return selector === ".service-details > summary" && this.parentElement?.dataset.serviceId !== undefined; }
    focus() { globalThis.document.activeElement = this; }
  }
  const original = Object.fromEntries(["document", "window", "navigator", "fetch", "HTMLElement", "HTMLMeterElement", "HTMLProgressElement", "Node"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const document = new Element();
  document.documentElement = {};
  document.createDocumentFragment = () => new Element();
  document.createElement = tag => Object.assign(new Element(), {tagName:tag});
  document.createElementNS = (_ns, tag) => document.createElement(tag);
  document.querySelector("#network-template").content = document.createElement("SECTION");
  document.querySelector("#service-template").content = document.createElement("ARTICLE");
  const services = [
    ["btc", "offline", false], ["ckb", "synced", true], ["blockbook", "syncing", true],
    ["spv", "unknown", true], ["ckbadger", "syncing", true],
  ].map(([kind, state, probeAvailable]) => ({
    id: kind, network: "mainnet", kind, label: kind, state, probeAvailable,
    metrics: kind === "blockbook" ? [{ label:"索引高度", value:123456 }] :
      kind === "ckb" ? [{label:"节点区块高度",value:10000},{label:"已知区块高度",value:10001},{label:"索引器高度",value:10000}] :
      kind === "ckbadger" ? [{label:"索引高度",value:0},{label:"CKB 目标高度",value:1000}] : [],
    progress: kind === "ckbadger" ? 0 : undefined,
    availability: {windows: [{seconds: 86_400, ratio: 0.75, available: kind === "spv" ? 0 : kind === "btc" ? 0 : 3, total: kind === "spv" ? 0 : 4}],
      dayBins: kind === "blockbook" ? Array.from({length: 12}, (_, i) => ({
        startMinute: 30_000_000 + i * 120, available: i === 7 ? 479 : i === 8 || i === 10 ? 1 : 0,
        total: i === 7 ? 480 : i === 10 ? 2 : i === 8 || i === 11 ? 1 : 0,
      })) : undefined},
  }));
  services.push(
    { id: "testnet3-http:btc-asset-api", network:"testnet3", kind:"http", label:"BTC Asset API", state:"online", probeAvailable:true,
      metrics:[{label:"HTTP 状态",value:200},{label:"响应时间",value:0}], availability:{windows:[]} },
    { id: "testnet3-http:other", network:"testnet3", kind:"http", label:"Other", state:"offline", probeAvailable:false,
      metrics:[], availability:{windows:[]} },
  );
  const serviceIds = services.map(service => service.id);
  try {
    for (const key of ["HTMLElement", "HTMLMeterElement", "HTMLProgressElement"]) globalThis[key] = Element;
    globalThis.Node = { TEXT_NODE: 3 };
    Object.defineProperty(globalThis, "document", { configurable: true, value: document });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en-US"] } });
    const preferences = new Map();
    const listeners = new Map();
    const timers = [];
    globalThis.window = { setTimeout(fn, delay) { timers.push({ fn, delay }); }, setInterval() {}, clearTimeout() {},
      addEventListener(event, fn) { listeners.set(event, fn); },
      localStorage: { getItem(key) { return preferences.get(key) ?? null; }, setItem(key, value) { preferences.set(key, value); } },
    };
    globalThis.fetch = async () => new Response(JSON.stringify({ updatedAt: new Date().toISOString(), intervalSeconds: 30, services }));
    await import("../dist/web/app.js");
    await new Promise(resolve => setImmediate(resolve));
    const container = document.querySelector("#networks");
    const section = id => container.children.find(row => row.dataset.network === id);
    const rows = id => section(id).querySelector(".cards").children;
    const ids = id => rows(id).map(row => row.dataset.renderKey).filter(Boolean);
    const card = index => container.querySelectorAll("article[data-render-key]").find(row => row.dataset.renderKey === serviceIds[index]);
    assert.deepEqual(container.children.map(row => row.dataset.network), ["attention", "mainnet", "testnet3"]);
    assert.equal(section("attention").querySelector("h2").textContent, "Needs attention");
    assert.deepEqual(ids("attention"), ["btc", "testnet3-http:other", "blockbook", "spv", "ckbadger"]);
    assert.deepEqual(ids("mainnet"), ["ckb"]);
    assert.deepEqual(ids("testnet3"), ["testnet3-http:btc-asset-api"]);
    assert.equal(card(0).querySelector(".card-network").textContent, "Mainnet");
    assert.equal(card(6).querySelector(".card-network").textContent, "Testnet");
    assert.equal(card(1).querySelector(".card-network").hidden, true);
    assert.equal(section("mainnet").querySelector(".network-summary").textContent, "4 / 5 online");
    assert.equal(card(3).querySelector(".probe-state").querySelector(".state-label").textContent, "Online");
    assert.equal(card(3).querySelector(".sync-state").querySelector(".state-label").textContent, "Sync not verified");
    assert.equal(card(1).querySelector(".sync-state").dataset.state, "synced");
    assert.equal(card(2).querySelector(".sync-state").dataset.state, "syncing");
    const template = readFileSync(new URL("../dist/web/index.html", import.meta.url), "utf8");
    assert.match(readFileSync(new URL("../dist/web/style.css", import.meta.url), "utf8"), /\.network\[data-network="mainnet"\] h2 \{ color: var\(--error\); \}/);
    assert.doesNotMatch(template, /class="(?:network-code|eyebrow)"/);
    assert.match(template, /<details class="service-details">[\s\S]*?<meter[\s\S]*?<\/details>/);
    const strips = index => card(index).querySelector(".sync-comparisons").children;
    assert.equal(section("mainnet").querySelector("h2").textContent, "Mainnet");
    assert.equal(card(2).querySelector(".github-link").href, "https://github.com/trezor/blockbook");
    assert.equal(strips(1)[0].children[1].children[0].attrs["aria-valuetext"], "99.99%");
    assert.equal(strips(1)[1].children[1].children[0].attrs["aria-valuetext"], "100%");
    assert.equal(strips(2)[0].children[0].children[0].children[1].textContent, "123,456");
    assert.equal(strips(2)[0].children.length, 1);
    assert.equal(strips(4)[0].children[1].children[0].value, 0);
    assert.equal(card(2).querySelector("meter").value, .75);
    assert.match(template, /<summary>[^]*?class="service-uptime"[^]*?<\/summary>/);
    assert.equal(card(2).querySelector(".service-uptime-value").textContent, "75%");
    const history = card(2).querySelector(".uptime-history");
    assert.equal(history.hidden, false);
    assert.deepEqual(history.children.slice(8).map(cell => cell.dataset.state), ["up", "empty", "mixed", "down"]);
    assert.match(history.children[7].title, /Some checks failed · 99\.79% \(479\/480 checks\)/);
    assert.equal(history.children[7].children[0].children[0].attrs.fill, uptimeFillColor(479/480));
    assert.equal(history.children[7].children[0].children[0].attrs.height, String(479/480));
    assert.equal(history.children[9].children.length, 0);
    assert.match(history.children[10].title, /Some checks failed · 50% \(1\/2 checks\)/);
    assert.equal(history.children[10].children[0].children[0].attrs.y, "0.5");
    assert.equal(history.children[10].children[0].children[0].attrs.height, "0.5");
    assert.equal(history.children[11].children.length, 0);
    assert.match(card(2).querySelector(".uptime-history-detail").querySelector(".uptime-history-caption").textContent, /Two-hour probe results, oldest to newest/);
    const historyDetail = card(2).querySelector(".uptime-history-detail");
    assert.match(history.children[9].title, /No samples$/);
    assert.match(history.children[11].title, /All checks failed · 0% \(0\/1 checks\)/);
    const keyItems = historyDetail.querySelector(".uptime-history-key").children;
    assert.equal(keyItems.length, 4);
    for (const state of ["down", "empty"]) {
      const swatch = keyItems.map(item => item.children[0]).find(item => item.dataset.state === state);
      assert.ok(swatch);
      assert.equal(swatch.children.length, 0);
    }
    assert.equal(historyDetail.querySelector(".uptime-breakdown").querySelector(".uptime-history-ranges").children[10].textContent, history.children[10].title);
    assert.equal(card(3).querySelector(".uptime-history").hidden, true);
    assert.equal(card(3).querySelector(".uptime-history-detail").querySelector(".uptime-history-caption").textContent, "Uptime timeline unavailable");
    assert.match(template, /href="#networks">Skip to Service Status<\/a>/);
    assert.match(template, /id="networks" tabindex="-1"/);
    assert.match(template, /name="theme-color" content="#090d10"/);
    assert.match(template, /id="refresh-announcement"[^>]*aria-live="polite"/);
    assert.doesNotMatch(template, /id="freshness"[^>]*aria-live/);
    assert.match(history.children[10].title, / UTC · /);
    const announcement = document.querySelector("#refresh-announcement");
    const initialAnnouncement = announcement.textContent;
    await timers.filter(timer => timer.delay === 30_000).at(-1).fn();
    assert.equal(announcement.textContent, initialAnnouncement);
    assert.equal(card(0).querySelector(".service-uptime-value").textContent, "0%");
    assert.equal(card(3).querySelector(".service-uptime-value").textContent, "No samples");
    assert.match(card(2).querySelector(".service-details").querySelector("summary").attrs["aria-label"], /24-hour uptime 75%/);
    assert.equal(section("testnet3").querySelector("h2").textContent, "Testnet");
    assert.equal(card(5).querySelector(".kind").hidden, true);
    assert.equal(card(5).querySelector(".http-measurements").querySelector(".http-status").textContent, "200");
    assert.equal(card(5).querySelector(".http-measurements").querySelector(".http-latency").textContent, "0 ms");
    assert.equal(card(6).querySelector(".http-measurements").querySelector(".http-status").textContent, "No response");
    assert.equal(card(6).querySelector(".http-measurements").querySelector(".http-latency").textContent, "No data");
    assert.equal(card(3).querySelector(".uptime-group").hidden, true);
    assert.equal(card(3).querySelector(".no-sync-data").textContent, "No sync data");
    const details = card(3).querySelector(".service-details");
    details.open = true;
    details.querySelector("summary").focus();
    await document.querySelector("#refresh").handlers.get("click")();
    assert.equal(card(3).querySelector(".service-details"), details);
    assert.equal(card(3).querySelector(".service-details").open, true);
    assert.notEqual(card(2).querySelector(".service-details").open, true);
    assert.equal(document.activeElement, card(3).querySelector(".service-details").querySelector("summary"));
    assert.match(template, /<label for="language"[^]*?<svg[^>]+aria-hidden="true"[^]*?<span id="language-label">Language<\/span>[^]*?<select id="language" name="language">/);
    const blockbookDetails = card(2).querySelector(".service-details");
    blockbookDetails.open = true;
    const breakdown = historyDetail.querySelector(".uptime-breakdown");
    breakdown.open = true;
    const breakdownSummary = breakdown.querySelector("summary");
    breakdownSummary.focus();
    const oldRange = breakdown.querySelector(".uptime-history-ranges").children[10];
    services[2].availability.dayBins[10].available = 2;
    await document.querySelector("#refresh").handlers.get("click")();
    assert.equal(card(2).querySelector(".service-details"), blockbookDetails);
    assert.equal(historyDetail.querySelector(".uptime-breakdown"), breakdown);
    assert.equal(breakdown.open, true);
    assert.equal(document.activeElement, breakdownSummary);
    assert.equal(breakdown.querySelector(".uptime-history-ranges").children[10], oldRange);
    assert.match(oldRange.textContent, /All checks succeeded · 100% \(2\/2 checks\)/);
    assert.equal(history.children[10].children[0].children[0].attrs.height, "1");
    const savedBins = services[2].availability.dayBins;
    delete services[2].availability.dayBins;
    await timers.filter(timer => timer.delay === 30_000).at(-1).fn();
    assert.equal(breakdown.hidden, true);
    assert.equal(document.activeElement, blockbookDetails.querySelector("summary"));
    services[2].availability.dayBins = savedBins;
    await timers.filter(timer => timer.delay === 30_000).at(-1).fn();
    assert.equal(breakdown.hidden, false);
    assert.equal(breakdown.open, true);
    const movedRow = card(2);
    const recoveredHttp = card(6);
    services[2].state = "synced";
    services[6].state = "online";
    services[6].probeAvailable = true;
    breakdownSummary.focus();
    await document.querySelector("#refresh").handlers.get("click")();
    assert.deepEqual(ids("attention"), ["btc", "spv", "ckbadger"]);
    assert.deepEqual(ids("mainnet"), ["ckb", "blockbook"]);
    assert.deepEqual(ids("testnet3"), ["testnet3-http:btc-asset-api", "testnet3-http:other"]);
    assert.equal(card(2), movedRow);
    assert.equal(card(6), recoveredHttp);
    assert.equal(card(2).querySelector(".card-network").hidden, true);
    assert.equal(blockbookDetails.open, true);
    assert.equal(breakdown.open, true);
    assert.equal(document.activeElement, breakdownSummary);
    services[2].state = "syncing";
    await document.querySelector("#refresh").handlers.get("click")();
    assert.deepEqual(ids("attention"), ["btc", "blockbook", "spv", "ckbadger"]);
    assert.equal(card(2), movedRow);
    assert.equal(card(2).querySelector(".card-network").hidden, false);
    assert.equal(document.activeElement, breakdownSummary);
    const firstProject = card(2).querySelector(".github-link");
    firstProject.focus();
    await document.querySelector("#refresh").handlers.get("click")();
    assert.equal(card(2).querySelector(".github-link"), firstProject);
    assert.equal(document.activeElement, card(2).querySelector(".github-link"));
    const refresh = document.querySelector("#refresh");
    refresh.focus();
    const refreshing = refresh.handlers.get("click")();
    assert.equal(refresh.attrs["aria-disabled"], "true");
    await refreshing;
    assert.equal(refresh.attrs["aria-disabled"], "false");
    assert.match(announcement.textContent, /Updated/);
    assert.equal(document.activeElement, refresh);
    const disconnected = card(4).querySelector(".github-link");
    disconnected.focus();
    const removed = services.splice(4, 1)[0];
    await refresh.handlers.get("click")();
    assert.equal(disconnected.isConnected, false);
    assert.equal(document.activeElement, document.querySelector("#networks"));
    services.splice(4, 0, removed);
    await refresh.handlers.get("click")();
    const selector = document.querySelector("#language");
    const languageLabel = document.querySelector("#language-label");
    assert.equal(languageLabel.textContent, "Language");
    const select = value => { selector.value = value; selector.handlers.get("change")(); };
    assert.equal(selector.value, "auto");
    assert.equal(document.documentElement.lang, "en");
    select("zh-CN");
    assert.equal(document.documentElement.lang, "zh-CN");
    assert.equal(languageLabel.textContent, "语言");
    assert.equal(section("attention").querySelector("h2").textContent, "需要关注");
    assert.equal(card(2).querySelector(".card-network").textContent, "主网");
    assert.equal(document.querySelector("h1").textContent, "链同步监控");
    assert.equal(card(3).querySelector(".service-details").open, true);
    assert.equal(preferences.get("chain-sync-monitor.language"), "zh-CN");
    await import("../dist/web/app.js?after-reload");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(selector.value, "zh-CN");
    assert.equal(document.documentElement.lang, "zh-CN");
    select("fr");
    assert.equal(document.documentElement.lang, "fr");
    select("de");
    assert.equal(document.documentElement.lang, "de");
    globalThis.window.localStorage.setItem = () => { throw new Error("storage blocked"); };
    select("ja");
    assert.equal(document.documentElement.lang, "ja");
    globalThis.navigator.languages = ["zh-TW"];
    select("auto");
    assert.equal(document.documentElement.lang, "zh-Hant");
    globalThis.navigator.languages = ["en"];
    listeners.get("languagechange")();
    assert.equal(document.documentElement.lang, "en");
    const beforeAllReady = card(2);
    for (const service of services) {
      service.state = service.kind === "http" ? "online" : "synced";
      service.probeAvailable = true;
    }
    await refresh.handlers.get("click")();
    assert.equal(section("attention").hidden, true);
    assert.deepEqual(ids("attention"), []);
    assert.deepEqual(ids("mainnet"), serviceIds.slice(0, 5));
    assert.deepEqual(ids("testnet3"), serviceIds.slice(5));
    assert.equal(card(2), beforeAllReady);
    // Use the real refresh + render path: repeated HTTP fetches and locale
    // re-renders of one snapshot cannot advance the classification.
    const explorer = services.find(service => service.kind === "ckbadger");
    let checkedAt = Date.now() + 60_000;
    globalThis.fetch = async () => new Response(JSON.stringify({
      updatedAt: new Date(checkedAt).toISOString(), intervalSeconds: 30, services,
    }));
    const setGap = (gap, mode = "normal") => {
      explorer.state = "syncing";
      explorer.metrics = [{label:"索引高度",value:100-gap},{label:"CKB 目标高度",value:100},
        {label:"落后",value:gap},{label:"索引模式",value:mode}];
    };
    setGap(1);
    await refresh.handlers.get("click")();
    assert.ok(ids("mainnet").includes(explorer.id));
    assert.equal(card(serviceIds.indexOf(explorer.id)).querySelector(".sync-state").querySelector(".state-label").textContent, "Syncing");
    assert.match(strips(serviceIds.indexOf(explorer.id))[0].children[0].children[2].children[1].textContent, /1/);
    checkedAt += 30_000;
    setGap(3);
    await refresh.handlers.get("click")();
    select("zh-CN");
    await refresh.handlers.get("click")();
    assert.ok(ids("mainnet").includes(explorer.id), "same upstream sample must remain held after re-render");
    checkedAt += 30_000;
    await refresh.handlers.get("click")();
    assert.ok(ids("attention").includes(explorer.id));
    checkedAt += 30_000;
    setGap(2);
    await refresh.handlers.get("click")();
    assert.ok(ids("mainnet").includes(explorer.id), "recovery must move the card back immediately");
    checkedAt += 30_000;
    setGap(1,"bulk");
    await refresh.handlers.get("click")();
    assert.ok(ids("attention").includes(explorer.id), "true bulk sync stays visible even at one block");

    checkedAt += 30_000;
    select("en");
    const decoder = {
      id: "testnet3-dob_decoder", kind: "dob_decoder", network: "testnet3",
      label: "DOB Decoder", state: "online", probeAvailable: true,
      metrics: [{ label: "DOB 协议版本", value: "dob/0, dob/1" }],
      availability: { windows: [{ seconds: 86_400, ratio: 1, available: 4, total: 4 }] },
    };
    services.push(decoder);
    serviceIds.push(decoder.id);
    await refresh.handlers.get("click")();
    const decoderCard = card(serviceIds.indexOf(decoder.id));
    const versions = decoderCard.querySelector(".dob-measurements");
    assert.ok(ids("testnet3").includes(decoder.id));
    assert.equal(versions.hidden, false);
    assert.equal(versions.querySelector("dt").textContent, "DOB protocol versions");
    assert.equal(versions.querySelector("dd").textContent, "dob/0, dob/1");
    assert.equal(decoderCard.querySelector(".sync-state").hidden, true);
    assert.equal(strips(serviceIds.indexOf(decoder.id)).length, 0);
    assert.match(decoderCard.querySelector(".uptime-ratio").textContent, /100/);
    assert.equal(decoderCard.querySelector(".github-link").href, "https://github.com/sporeprotocol/dob-decoder-standalone-server");

    checkedAt += 30_000;
    decoder.state = "degraded";
    decoder.probeAvailable = false;
    decoder.metrics = [];
    await refresh.handlers.get("click")();
    assert.ok(ids("attention").includes(decoder.id));
    assert.equal(decoderCard.querySelector(".sync-state").hidden, true);
    assert.equal(decoderCard.querySelector(".dob-measurements").querySelector("dd").textContent, "No data");

  } finally {
    for (const [key, descriptor] of Object.entries(original)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});

test("the timeline and legend use hollow solid outlines for failure and dotted outlines for no samples", () => {
  const css = readFileSync(new URL("../dist/web/style.css", import.meta.url), "utf8");
  const styles = state => [...css.matchAll(new RegExp(
    String.raw`:is\(\.uptime-history > span, \.uptime-swatch\)\[data-state="${state}"\]\s*\{([^}]+)\}`, "g"
  ))].map(match => match[1].trim().replace(/\s+/g, " "));
  assert.deepEqual(styles("down"), [
    "background: transparent; border: 1px solid var(--error);",
    "background: Canvas; border-color: CanvasText;",
  ]);
  assert.deepEqual(styles("empty"), [
    "background: transparent; border: 1px dotted var(--muted);",
    "background: Canvas; border-color: CanvasText;",
  ]);
});

test("uptime fill colors blend without abrupt changes at previous thresholds or the midpoint", () => {
  assert.equal(uptimeFillColor(1), "#8ddeaa");
  assert.equal(uptimeFillColor(.5), "#e9c484");
  assert.equal(uptimeFillColor(0), "#f5a9b8");
  const rgb = ratio => uptimeFillColor(ratio).slice(1).match(/../g).map(x => Number.parseInt(x, 16));
  const distance = (a, b) => Math.max(...rgb(a).map((channel, i) => Math.abs(channel - rgb(b)[i])));
  assert.ok(distance(1, 479/480) <= 1);
  for (const boundary of [.98, .9, .5]) {
    assert.ok(distance(boundary - .001, boundary + .001) <= 2);
  }
  assert.ok(new Set([.1,.2,.3,.4,.5,.6,.7,.8,.9,1].map(uptimeFillColor)).size === 10);
});
