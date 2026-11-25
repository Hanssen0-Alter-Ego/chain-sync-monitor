import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { loadConfig } from "../dist/server/backend/src/config.js";
import { HistoryStore } from "../dist/server/backend/src/history.js";
import { Monitor } from "../dist/server/backend/src/monitor.js";
import { EmailAlerts, sendCloudflareEmail } from "../dist/server/backend/src/email-alerts.js";

const config = {
  accountId: "1".repeat(32), apiToken: "mock-token", from: "monitor@example.com",
  to: "alarms@example.com", statusUrl: "https://monitor.example.com/",
  failureChecks: 3, recoveryChecks: 2,
};
const service = (state, probeAvailable) => ({
  id: "mainnet-ckbadger", label: "CKBadger", kind: "ckbadger", network: "mainnet",
  state, probeAvailable, metrics: [{ label: "索引高度", value: 42 }],
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
  alerts.observe([service("synced", true)], at + 14);
  alerts.observe([service("unknown", false)], at + 15);
  alerts.observe([service("synced", true)], at + 16);
  await alerts.flush(at + 16);
  assert.equal(sent.length, 1);
  alerts.observe([service("synced", true)], at + 17);
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
  alerts.observe([service("online", true)], 200);
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
  assert.deepEqual([open.state, recovered.state], ["offline", "online"]);
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
  writeFileSync(path, `[[networks.mainnet.http]]
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
