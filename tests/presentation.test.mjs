import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { currentProbe, probeTotals, projectRepository, syncComparisons, uptimeDay } from "../dist/web/presentation.js";

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

test("the uptime chart uses counted probes and rejects missing or impossible samples", () => {
  const window = (available, total) => ({ seconds: 86_400, available, total, ratio: null });
  assert.equal(uptimeDay({windows: [window(0, 0)]}), undefined);
  assert.equal(uptimeDay({windows: [window(2, 1)]}), undefined);
  assert.equal(uptimeDay({windows: [{ ...window(4, 5), seconds: 604_800 }]}), undefined);
  assert.deepEqual(uptimeDay({windows: [window(0, 2)]}), window(0, 2));
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

test("GitHub repository icons do not conflate public service links or arbitrary probe IDs", () => {
  assert.equal(projectRepository({kind:"ckbadger"}), "https://github.com/janx/ckbadger");
  assert.equal(projectRepository({kind:"http",id:"testnet3-http:btc-asset-api"}), "https://github.com/RGBPlusPlus/btc-assets-api");
  assert.equal(projectRepository({kind:"http",id:"testnet3-http:other",publicUrl:"https://example.org"}), undefined);
  assert.equal(projectRepository({kind:"http",githubUrl:"https://github.com/owner/repo"}), "https://github.com/owner/repo");
  for (const githubUrl of ["http://github.com/owner/repo","https://github.com/owner/..","https://github.com/owner/repo/issues","https://gh.example/owner/repo","https://x@github.com/owner/repo"]) {
    assert.equal(projectRepository({kind:"http",githubUrl}), undefined);
  }
});

test("built dashboard renders two dimensions and preserves the expanded row after refresh", async () => {
  class Element {
    children = [];
    dataset = {};
    attrs = {};
    selectors = new Map();
    handlers = new Map();
    querySelector(selector) {
      if (!this.selectors.has(selector)) {
        const node = new Element();
        node.parentElement = this;
        this.selectors.set(selector, node);
      }
      return this.selectors.get(selector);
    }
    querySelectorAll(selector) {
      const output = [];
      const walk = (node) => {
        if (!(node instanceof Element)) return;
        if (selector === ".service-details[open]" && node.open) output.push(node);
        for (const child of [...node.children, ...node.selectors.values()]) walk(child);
      };
      walk(this);
      return output;
    }
    cloneNode() { return new Element(); }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    hasChildNodes() { return this.children.length > 0; }
    addEventListener(event, listener) { this.handlers.set(event, listener); }
    setAttribute(key, value) { this.attrs[key] = value; }
    matches(selector) { return selector === ".service-details > summary" && this.parentElement?.dataset.serviceId !== undefined; }
    focus() { globalThis.document.activeElement = this; }
  }
  const original = Object.fromEntries(["document", "window", "navigator", "fetch"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const document = new Element();
  document.documentElement = {};
  document.createDocumentFragment = () => new Element();
  document.createElement = tag => Object.assign(new Element(), {tagName:tag});
  document.querySelector("#network-template").content = new Element();
  document.querySelector("#service-template").content = new Element();
  const services = [
    ["btc", "offline", false], ["ckb", "synced", true], ["blockbook", "syncing", true],
    ["spv", "unknown", true], ["ckbadger", "syncing", true],
  ].map(([kind, state, probeAvailable]) => ({
    id: kind, network: "mainnet", kind, label: kind, state, probeAvailable,
    metrics: kind === "blockbook" ? [{ label:"索引高度", value:123456 }] :
      kind === "ckb" ? [{label:"节点区块高度",value:10000},{label:"已知区块高度",value:10001},{label:"索引器高度",value:10000}] :
      kind === "ckbadger" ? [{label:"索引高度",value:0},{label:"CKB 目标高度",value:1000}] : [],
    progress: kind === "ckbadger" ? 0 : undefined,
    availability: {windows: [{seconds: 86_400, ratio: 0.75, available: kind === "spv" ? 0 : kind === "btc" ? 0 : 3, total: kind === "spv" ? 0 : 4}]},
  }));
  try {
    Object.defineProperty(globalThis, "document", { configurable: true, value: document });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en-US"] } });
    globalThis.window = { setTimeout() {}, setInterval() {}, clearTimeout() {} };
    globalThis.fetch = async () => new Response(JSON.stringify({ updatedAt: new Date().toISOString(), intervalSeconds: 30, services }));
    await import("../dist/web/app.js");
    await new Promise(resolve => setImmediate(resolve));
    const section = () => document.querySelector("#networks").children[0].children[0];
    const card = index => section().querySelector(".cards").children[index];
    assert.equal(section().querySelector(".network-summary").textContent, "4 / 5 online");
    assert.equal(card(3).querySelector(".probe-state").querySelector(".state-label").textContent, "Online");
    assert.equal(card(3).querySelector(".sync-state").querySelector(".state-label").textContent, "Sync not verified");
    assert.equal(card(1).querySelector(".sync-state").dataset.state, "synced");
    assert.equal(card(2).querySelector(".sync-state").dataset.state, "syncing");
    const template = readFileSync(new URL("../dist/web/index.html", import.meta.url), "utf8");
    assert.doesNotMatch(template, /class="(?:network-code|eyebrow)"/);
    assert.match(template, /<details class="service-details">[\s\S]*?<meter[\s\S]*?<\/details>/);
    const strips = index => card(index).querySelector(".sync-comparisons").children;
    assert.equal(section().querySelector("h2").textContent, "Mainnet");
    assert.equal(card(2).querySelector(".github-link").href, "https://github.com/trezor/blockbook");
    assert.equal(strips(1)[0].children[1].children[0].attrs["aria-valuetext"], "99.99%");
    assert.equal(strips(1)[1].children[1].children[0].attrs["aria-valuetext"], "100%");
    assert.equal(strips(2)[0].children[0].children[0].children[1].textContent, "123,456");
    assert.equal(strips(2)[0].children.length, 1);
    assert.equal(strips(4)[0].children[1].children[0].value, 0);
    assert.equal(card(2).querySelector("meter").value, .75);
    assert.equal(card(3).querySelector(".uptime-group").hidden, true);
    assert.equal(card(3).querySelector(".no-sync-data").textContent, "No sync data");
    const details = card(3).querySelector(".service-details");
    details.open = true;
    details.querySelector("summary").focus();
    await document.querySelector("#refresh").handlers.get("click")();
    assert.notEqual(card(3).querySelector(".service-details"), details);
    assert.equal(card(3).querySelector(".service-details").open, true);
    assert.equal(card(2).querySelector(".service-details").open, false);
    assert.equal(document.activeElement, card(3).querySelector(".service-details").querySelector("summary"));
  } finally {
    for (const [key, descriptor] of Object.entries(original)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
