import assert from "node:assert/strict";
import test from "node:test";
import { currentProbe, keySyncMetric, probeTotals, uptimeDay } from "../dist/web/presentation.js";

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
  assert.deepEqual(keySyncMetric({kind: "blockbook", metrics: [{label: "索引高度", value: 0}]}), {label: "索引高度", value: 0, unit: undefined});
  assert.equal(keySyncMetric({kind: "spv", metrics: [{label: "证明 RPC", value: "在线"}]}), undefined);
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
  document.createDocumentFragment = document.createElement = () => new Element();
  document.querySelector("#network-template").content = new Element();
  document.querySelector("#service-template").content = new Element();
  const services = [
    ["btc", "offline", false], ["ckb", "synced", true], ["blockbook", "syncing", true],
    ["spv", "unknown", true], ["ckbadger", "syncing", true],
  ].map(([kind, state, probeAvailable]) => ({
    id: kind, network: "mainnet", kind, label: kind, state, probeAvailable,
    metrics: kind === "blockbook" ? [{ label: "索引高度", value: 123456 }] : [],
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
    assert.equal(card(2).querySelector(".progress-title").textContent, "Index height");
    assert.equal(card(2).querySelector(".progress-value").textContent, "123,456");
    assert.equal(card(2).querySelector("progress").hidden, true);
    assert.equal(card(2).querySelector("meter").hidden, false);
    assert.equal(card(2).querySelector("meter").value, 0.75);
    assert.equal(card(2).querySelector("meter").attrs["aria-valuetext"], "75% (3/4 checks)");
    assert.equal(card(4).querySelector("progress").hidden, false);
    assert.equal(card(4).querySelector("progress").value, 0);
    assert.equal(card(0).querySelector("meter").hidden, false);
    assert.equal(card(0).querySelector("meter").value, 0);
    assert.equal(card(3).querySelector("meter").hidden, true);
    assert.equal(card(3).querySelector(".uptime-ratio").textContent, "No samples");
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
