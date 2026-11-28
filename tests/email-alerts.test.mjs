import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { loadConfig } from "../dist/server/backend/src/config.js";
import { HistoryStore } from "../dist/server/backend/src/history.js";
import { Monitor } from "../dist/server/backend/src/monitor.js";
import { EmailAlerts, sendCloudflareEmail } from "../dist/server/backend/src/email-alerts.js";

const config = {
  accountId: "1".repeat(32), apiToken: "mock-token", from: "monitor@example.com",
  to: "alarms@example.com", statusUrl: "https://monitor.example.com/",
  failureChecks: 3, recoveryChecks: 2, lagBlocks: 2, lagSeconds: 300, notifyChanges: false,
};
const service = (state, probeAvailable, syncTipLag) => ({
  id: "mainnet-ckbadger", label: "CKBadger", kind: "ckbadger", network: "mainnet",
  state, probeAvailable, syncTipLag, metrics: [{ label: "索引高度", value: 42 }],
});
const directory = t => {
  const dir = mkdtempSync(join(tmpdir(), "email-alerts-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test("Cloudflare sends via the fixed HTTPS REST endpoint and checks recipient outcome", async () => {
  const mail = { subject: "[Monitor Alert] OPEN mainnet-ckbadger", text: "test body" };
  const accepted = await sendCloudflareEmail(config, mail, async (url, init) => {
    assert.equal(url, `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/email/sending/send`);
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "error");
    assert.equal(init.headers.Authorization, "Bearer mock-token");
    assert.deepEqual(JSON.parse(init.body), { from: config.from, to: config.to, ...mail });
    return Response.json({ success: true, result: { queued: [config.to] } });
  });
  assert.deepEqual(accepted, { ok: true });
  const bounced = await sendCloudflareEmail(config, mail, async () =>
    Response.json({ success: true, result: { permanent_bounces: [config.to] } }));
  assert.equal(bounced.ok, false);
  assert.equal(bounced.retry, false);
  const throttled = await sendCloudflareEmail(config, mail, async () =>
    new Response(null, { status: 429 }));
  assert.equal(throttled.retry, true);
});

test("startup and catch-up are quiet; degraded-but-reachable opens once and restart preserves incident", async t => {
  const db = join(directory(t), "history.sqlite3");
  const sent = [];
  const send = async (_config, mail) => { sent.push(mail); return { ok: true }; };
  let alerts = new EmailAlerts(db, config, send);
  const at = Date.UTC(2026, 10, 25);
  for (let i = 0; i < 5; i++) {
    alerts.observe([service("syncing", false)], at + i);
    alerts.observe([service("syncing", true)], at + i);
  }
  await alerts.flush(at + 9);
  assert.equal(sent.length, 0);
  for (let i = 10; i < 12; i++) alerts.observe([service("degraded", true)], at + i);
  alerts = new EmailAlerts(db, config, send);
  alerts.observe([service("degraded", true)], at + 12);
  await alerts.flush(at + 12);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].subject, "[Monitor Alert] OPEN mainnet-ckbadger");
  assert.match(sent[0].text, /first_bad_at: 2026-11-25T00:00:00.010Z/);
  assert.ok(sent[0].text.includes("schema: chain-sync-monitor/1"));
  alerts = new EmailAlerts(db, config, send);
  alerts.observe([service("offline", false)], at + 13);
  alerts.observe([service("synced", true, 0)], at + 14);
  alerts.observe([service("unknown", false)], at + 15);
  alerts.observe([service("synced", true, 0)], at + 16);
  await alerts.flush(at + 16);
  assert.equal(sent.length, 1);
  alerts.observe([service("synced", true, 0)], at + 17);
  await alerts.flush(at + 17);
  assert.equal(sent[1].subject, "[Monitor Alert] RECOVERED mainnet-ckbadger");
  assert.equal(sent[1].text.match(/^incident_id: (.+)$/m)[1], sent[0].text.match(/^incident_id: (.+)$/m)[1]);
});

test("outbox retains the same event and sends recovery after the retried opening", async t => {
  const info = t.mock.method(console, "info", () => {});
  const error = t.mock.method(console, "error", () => {});
  const attempts = [];
  const send = async (_config, mail) => {
    attempts.push(mail);
    return attempts.length === 1 ? { ok: false, retry: true, reason: "HTTP 503" } : { ok: true };
  };
  const alerts = new EmailAlerts(join(directory(t), "history.sqlite3"), {
    ...config, failureChecks: 1, recoveryChecks: 1,
  }, send);
  alerts.observe([service("offline", false)], 100);
  await alerts.flush(100);
  alerts.observe([service("synced", true, 1)], 190);
  alerts.observe([service("synced", true, 0)], 200);
  await alerts.flush(200);
  assert.equal(attempts.length, 1);
  await alerts.flush(30_100);
  assert.equal(attempts.length, 3);
  assert.equal(attempts[0].text, attempts[1].text);
  assert.match(attempts[2].subject, /RECOVERED/);
  const logs = mock => mock.mock.calls.map(call => JSON.parse(call.arguments[0]));
  const [open, recovered, acceptedOpen, acceptedRecovery] = logs(info);
  assert.equal(info.mock.callCount(), 4);
  assert.equal(error.mock.callCount(), 1);
  assert.deepEqual([open.event, recovered.event], ["OPEN", "RECOVERED"]);
  assert.deepEqual([open.state, recovered.state], ["offline", "synced"]);
  assert.deepEqual(logs(error)[0], {
    message: "Monitor alert email", event_id: open.event_id, service_id: "mainnet-ckbadger",
    attempt: 1, outcome: "retrying", reason: "HTTP 503",
  });
  for (const [incident, sent, attempt] of [[open, acceptedOpen, 2], [recovered, acceptedRecovery, 1]]) {
    assert.deepEqual(sent, {
      message: "Monitor alert email", event_id: incident.event_id, service_id: "mainnet-ckbadger",
      attempt, outcome: "accepted",
    });
  }
  const rawLogs = JSON.stringify([...logs(info), ...logs(error)]);
  for (const secret of [config.apiToken, config.from, config.to, config.statusUrl, "Probe details"]) {
    assert.ok(!rawLogs.includes(secret));
  }
});

test("email config is opt-in; an enabled config reads the token file without exposing it", t => {
  const dir = directory(t);
  const path = join(dir, "monitor.toml");
  const opts = '[alerts.email]\naccount_id = "' + config.accountId
    + '"\napi_token_file = "token"\nfrom = "' + config.from + '"\nto = "' + config.to + '"\n';
  writeFileSync(path, opts);
  assert.equal(loadConfig(path).emailAlerts, undefined);
  writeFileSync(path, opts + "enabled = true\n");
  assert.throws(() => loadConfig(path), /api_token_file/);
  writeFileSync(join(dir, "token"), "mock-token\n");
  assert.equal(loadConfig(path).emailAlerts.apiToken, "mock-token");
});

test("a real monitor poll queues email without waiting for Cloudflare or exposing configuration", async t => {
  const dir = directory(t);
  const server = createServer((_request, response) => response.writeHead(503).end());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const path = join(dir, "monitor.toml");
  writeFileSync(path, `[[groups.probes.services]]
kind = "http"
network = "mainnet"
id = "health"
label = "Health"
url = "${base}"
`);
  const cfg = loadConfig(path);
  cfg.emailAlerts = { ...config, failureChecks: 1 };
  let finish;
  const captured = [];
  t.mock.method(globalThis, "fetch", (_url, init) => {
    captured.push(JSON.parse(init.body));
    return new Promise(resolve => { finish = resolve; });
  });
  const monitor = new Monitor(cfg, new HistoryStore(cfg.historyPath));
  await monitor.poll();
  await monitor.poll();
  assert.equal(monitor.snapshot.services[0].state, "degraded");
  assert.equal(captured.length, 1);
  assert.equal(captured[0].subject, "[Monitor Alert] OPEN mainnet-http:health");
  assert.ok(!captured[0].text.includes(base));
  assert.ok(!JSON.stringify(monitor.snapshot).includes(config.apiToken));
  finish(Response.json({ success: true, result: { delivered: [config.to] } }));
  await new Promise(resolve => setImmediate(resolve));
});

test("continuous verified lag opens at five minutes; gaps, jitter and restarts preserve the incident", async t => {
  const db = join(directory(t), "monitor.sqlite3");
  const sent = [];
  const send = async (_config, mail) => { sent.push(mail); return { ok: true }; };
  const settings = { ...config, notifyChanges: true };
  let alerts = new EmailAlerts(db, settings, send);
  let now = 1_800_000_000_000;
  const poll = (state = "syncing", gap = 2, elapsed = 30_000) => {
    now += elapsed;
    alerts.observe([service(state, state !== "offline", gap)], now);
  };
  const repeat = (count, ...args) => { for (let i = 0; i < count; i++) poll(...args); };
  repeat(10);
  poll("unknown"); // A neutral sample interrupts the 4m30s streak.
  repeat(10);
  poll("syncing", 2, 120_000); // Missed polls cannot count as observed lag time.
  repeat(9);
  await alerts.flush(now);
  assert.equal(sent.length, 0);
  alerts = new EmailAlerts(db, settings, send);
  poll();
  const firstLag = now;
  repeat(4);
  repeat(3, "offline");
  repeat(10); // HTTP back for 4m30s, still no confirmed business transition.
  await alerts.flush(now);
  assert.deepEqual(sent.map(m => m.subject.split(" ")[2]), ["OPEN", "CHANGED"]);
  poll();
  repeat(3, "offline");
  repeat(11);
  poll("synced", 1);
  alerts.observe([service("synced", true, 1)], now); // Duplicate poll.
  poll("unknown");
  poll("synced", 0);
  await alerts.flush(now);
  assert.equal(sent.length, 5);
  poll("syncing", 1);
  await alerts.flush(now);
  const values = key => sent.map(m => m.text.match(new RegExp("^" + key + ": (.+)$", "m"))?.[1]);
  assert.deepEqual(values("event"), ["OPEN", "CHANGED", "CHANGED", "CHANGED", "CHANGED", "RECOVERED"]);
  const lag = "reachable-but-lagging";
  assert.deepEqual(values("state"), [lag, "offline", lag, "offline", lag, "synced"]);
  assert.deepEqual(values("previous_state"), ["none", lag, "offline", lag, "offline", lag]);
  assert.equal(values("previous_tip_lag_blocks")[1], "2");
  assert.equal(new Set(values("event_id")).size, 6);
  assert.equal(new Set(values("incident_id")).size, 1);
  assert.equal(values("observed_at")[0], new Date(firstLag).toISOString());
  assert.equal(values("state_observed_since")[0], new Date(firstLag - 300_000).toISOString());
  assert.equal(values("tip_lag_blocks")[0], "2");
});

test("custom lag threshold leaves a neutral band; compatibility mode suppresses intermediate mail", async t => {
  const sent = [];
  const alerts = new EmailAlerts(join(directory(t), "history"), {
    ...config, failureChecks: 1, recoveryChecks: 1, lagBlocks: 4, lagSeconds: 10,
  }, async (_cfg, mail) => { sent.push(mail); return { ok: true }; });
  const poll = (ts, state, lag) => alerts.observe([service(state, state !== "offline", lag)], ts);
  poll(1, "offline");
  poll(10_001, "syncing", 4);
  poll(20_001, "syncing", 4);
  poll(30_001, "syncing", 3);
  poll(40_001, "synced");
  poll(50_001, "synced", 0);
  await alerts.flush(50_001);
  assert.equal(sent.length, 1);
  poll(60_001, "synced", 1);
  await alerts.flush(60_001);
  assert.match(sent[1].text, /event: RECOVERED/);
  assert.match(sent[1].text, /previous_state: reachable-but-lagging/);
});

test("legacy SQLite upgrade retains a queued OPEN and retries each transition in incident order", async t => {
  const path = join(directory(t), "legacy.db");
  const db = new DatabaseSync(path);
  const id = "mainnet-ckbadger", incident = "existing-incident";
  const opening = `schema: chain-sync-monitor/1\nevent: OPEN\nstate: offline\nincident_id: ${incident}\n\nProbe details:\n`;
  db.exec(`
    CREATE TABLE email_alert_state (service TEXT PRIMARY KEY, incident TEXT, bad INTEGER NOT NULL,
      good INTEGER NOT NULL, first_bad INTEGER) STRICT;
    CREATE TABLE email_alert_outbox (id TEXT PRIMARY KEY, service TEXT NOT NULL, subject TEXT NOT NULL,
      text TEXT NOT NULL, created INTEGER NOT NULL, next_try INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      finished INTEGER) STRICT;
  `);
  db.prepare("INSERT INTO email_alert_state VALUES (?, ?, 3, 1, 500)").run(id, incident);
  db.prepare("INSERT INTO email_alert_outbox VALUES (?, ?, ?, ?, 500, 1500, 1, NULL)")
    .run(incident + ":open", id, "[Monitor Alert] OPEN " + id, opening);
  db.close();
  const configV2 = { ...config, failureChecks: 1, recoveryChecks: 1, lagSeconds: 1, notifyChanges: true };
  const attempts = [];
  const send = async (_cfg, mail) => {
    attempts.push(mail);
    return attempts.length === 2 ? { ok: false, retry: true, reason: "HTTP 429" } : { ok: true };
  };
  let alerts = new EmailAlerts(path, configV2, send);
  alerts.observe([service("synced", true, 0)], 800);
  alerts.observe([service("syncing", true, 2)], 1_000);
  alerts.observe([service("syncing", true, 2)], 2_000);
  await alerts.flush(2_000);
  assert.equal(attempts[0].text, opening);
  assert.match(attempts[1].text, /previous_state: offline/);
  alerts = new EmailAlerts(path, configV2, send);
  alerts.observe([service("degraded", true)], 3_000);
  alerts.observe([service("offline", false)], 4_000);
  alerts.observe([service("synced", true, 1)], 5_000);
  alerts.observe([service("synced", true, 0)], 6_000);
  await alerts.flush(31_999);
  assert.equal(attempts.length, 2);
  await alerts.flush(32_000);
  assert.equal(attempts.length, 6);
  assert.deepEqual(attempts.map(m => m.subject.split(" ")[2]), ["OPEN", "CHANGED", "CHANGED", "CHANGED", "CHANGED", "RECOVERED"]);
  assert.equal(attempts[1].id, attempts[2].id);
  assert.equal(attempts[1].text, attempts[2].text);
  assert.equal(new Set(attempts.map(m => m.id)).size, 5);
  for (const m of attempts.slice(1)) {
    assert.match(m.text, /incident_id: existing-incident\n/);
    assert.match(m.text, /first_bad_at: 1970-01-01T00:00:00.500Z/);
  }
});

test("an HTTP service opens on consecutive failures and debounces later fault changes", async t => {
  const sent = [];
  const alerts = new EmailAlerts(join(directory(t), "history"), { ...config, notifyChanges: true },
    async (_cfg, mail) => { sent.push(mail); return { ok: true }; });
  let now = 0;
  const poll = state => alerts.observe([{ ...service(state, state === "online"), id: "service-http:health", kind: "http" }], ++now);
  for (const state of ["degraded", "offline", "degraded", "offline", "unknown", "offline", "offline",
    "degraded", "offline", "offline", "offline", "online", "online"]) poll(state);
  await alerts.flush(now);
  assert.deepEqual(sent.map(m => m.subject.split(" ")[2]), ["OPEN", "CHANGED", "RECOVERED"]);
  assert.match(sent[1].text, /state: offline\nprevious_state: degraded/);
});
