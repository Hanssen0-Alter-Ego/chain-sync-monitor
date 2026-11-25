import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { Service } from "../../shared/status.js";
import { record, type EmailAlertsConfig } from "./config.js";

const retryDelays = [30_000, 120_000, 600_000] as const;
const retention = 7 * 24 * 60 * 60 * 1000;
type EventKind = "OPEN" | "RECOVERED";
type EventRow = { id: string; subject: string; text: string; attempts: number };
type ServiceState = { incident: string | null; bad: number; good: number; first_bad: number | null };
type Delivery = { ok: true } | { ok: false; retry: boolean; reason: string };

export async function sendCloudflareEmail(
  config: EmailAlertsConfig, mail: Pick<EventRow, "subject" | "text">, request = fetch,
): Promise<Delivery> {
  try {
    const response = await request(`https://api.cloudflare.com/client/v4/accounts/${config.accountId}/email/sending/send`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${config.apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: config.from, to: config.to, subject: mail.subject, text: mail.text }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { ok: false, retry: response.status === 429 || response.status >= 500, reason: `HTTP ${response.status}` };
    }
    const payload = record(await response.json());
    const result = record(payload?.result);
    const contains = (key: string) => {
      const values = result?.[key];
      return Array.isArray(values) && values.includes(config.to);
    };
    if (contains("permanent_bounces") || contains("suppressed_recipients")) {
      return { ok: false, retry: false, reason: "recipient bounced or is suppressed" };
    }
    return payload?.success === true && (contains("delivered") || contains("queued"))
      ? { ok: true } : { ok: false, retry: false, reason: "API did not accept the recipient" };
  } catch {
    // Never log errors containing request data, URLs, or credentials.
    return { ok: false, retry: true, reason: "request or response failed" };
  }
}

function observation(service: Service) {
  if (service.state === "offline" || service.state === "degraded") return "bad";
  if (service.probeAvailable === true && (service.state === "online" || service.state === "synced" || service.state === "syncing")) return "good";
  return "neutral";
}

function mailFor(
  service: Service, kind: EventKind, incident: string, firstBad: number, observedAt: number, statusUrl?: string,
) {
  const id = `${incident}:${kind.toLowerCase()}`;
  const iso = (ts: number) => new Date(ts).toISOString();
  const lines = [
    "schema: chain-sync-monitor/1",
    `event: ${kind}`,
    `event_id: ${id}`,
    `incident_id: ${incident}`,
    `service_id: ${service.id}`,
    `service: ${service.label}`,
    `network: ${service.network ?? "none"}`,
    `kind: ${service.kind}`,
    `state: ${service.state}`,
    `first_bad_at: ${iso(firstBad)}`,
    `observed_at: ${iso(observedAt)}`,
    ...(service.syncTipLag === undefined ? [] : [`tip_lag_blocks: ${service.syncTipLag}`]),
    ...(statusUrl ? [`status_url: ${statusUrl}`] : []),
    "",
    "Probe details:",
    ...(service.note ? [service.note] : []),
    ...service.metrics.map(metric => `${metric.label}: ${metric.value}${metric.unit ? ` ${metric.unit}` : ""}`),
  ];
  return { id, subject: `[Monitor Alert] ${kind} ${service.id}`, text: lines.join("\n") };
}

export class EmailAlerts {
  private sending?: Promise<void>;
  private initialized = false;
  constructor(
    private readonly dbPath: string,
    private readonly config: EmailAlertsConfig,
    private readonly send = sendCloudflareEmail,
  ) {}

  private withDb<T>(operation: (db: DatabaseSync) => T) {
    const db = new DatabaseSync(this.dbPath);
    try {
      db.exec("PRAGMA busy_timeout = 1000;");
      if (!this.initialized) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS email_alert_state (
            service TEXT PRIMARY KEY, incident TEXT, bad INTEGER NOT NULL, good INTEGER NOT NULL, first_bad INTEGER
          ) STRICT;
          CREATE TABLE IF NOT EXISTS email_alert_outbox (
            id TEXT PRIMARY KEY, service TEXT NOT NULL, subject TEXT NOT NULL, text TEXT NOT NULL,
            created INTEGER NOT NULL, next_try INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
            finished INTEGER
          ) STRICT;
        `);
        this.initialized = true;
      }
      return operation(db);
    } finally { db.close(); }
  }

  observe(services: Service[], now = Date.now()) {
    const events = this.withDb(db => {
      const queued = [];
      db.exec("BEGIN IMMEDIATE;");
      const read = db.prepare("SELECT incident, bad, good, first_bad FROM email_alert_state WHERE service = ?");
      const save = db.prepare(`
        INSERT INTO email_alert_state VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (service) DO UPDATE SET incident=excluded.incident, bad=excluded.bad,
          good=excluded.good, first_bad=excluded.first_bad
      `);
      const enqueue = db.prepare("INSERT INTO email_alert_outbox (id, service, subject, text, created, next_try) VALUES (?, ?, ?, ?, ?, ?)");
      for (const service of services) {
        const state = read.get(service.id) as ServiceState | undefined;
        const last = state ?? { incident: null, bad: 0, good: 0, first_bad: null };
        let { incident, bad, good, first_bad: firstBad } = last;
        const sample = observation(service);
        let event: EventKind | undefined;
        if (!incident) {
          bad = sample === "bad" ? bad + 1 : 0;
          firstBad = bad === 0 ? null : firstBad ?? now;
          if (bad >= this.config.failureChecks) {
            incident = randomUUID();
            event = "OPEN";
          }
        } else {
          good = sample === "good" ? good + 1 : 0;
          if (good >= this.config.recoveryChecks) event = "RECOVERED";
        }
        if (event && incident && firstBad !== null) {
          const { id, subject, text } = mailFor(service, event, incident, firstBad, now, this.config.statusUrl);
          enqueue.run(id, service.id, subject, text, now, now);
          queued.push({ event, event_id: id, service_id: service.id, state: service.state });
          if (event === "RECOVERED") { incident = null; bad = 0; good = 0; firstBad = null; }
        }
        if (incident !== last.incident || bad !== last.bad || good !== last.good || firstBad !== last.first_bad) {
          save.run(service.id, incident, bad, good, firstBad);
        }
      }
      db.prepare("DELETE FROM email_alert_outbox WHERE finished < ?").run(now - retention);
      db.exec("COMMIT;");
      return queued;
    });
    for (const event of events) {
      console.info(JSON.stringify({ message: "Monitor incident", ...event }));
    }
  }

  /** Keep network I/O outside the probe loop, with one sender per monitor process. */
  flush(now = Date.now()) {
    return this.sending ??= this.drain(now).finally(() => { this.sending = undefined; });
  }

  private async drain(now: number) {
    for (let sent = 0; sent < 8; sent++) {
      const entry = this.withDb(db => db.prepare(`
        SELECT id, service, subject, text, attempts FROM email_alert_outbox AS candidate
        WHERE finished IS NULL AND next_try <= ?
          AND NOT EXISTS (SELECT 1 FROM email_alert_outbox AS prior
            WHERE prior.service = candidate.service AND prior.finished IS NULL AND prior.rowid < candidate.rowid)
        ORDER BY rowid LIMIT 1
      `).get(now)) as (EventRow & { service: string }) | undefined;
      if (!entry) break;
      const result = await this.send(this.config, entry);
      const delay = retryDelays[entry.attempts];
      const retry = !result.ok && result.retry && delay !== undefined;
      this.withDb(db => {
        if (retry) {
          db.prepare("UPDATE email_alert_outbox SET attempts = attempts+1, next_try = ? WHERE id = ?").run(now + delay, entry.id);
        } else db.prepare("UPDATE email_alert_outbox SET finished = ? WHERE id = ?").run(now, entry.id);
      });
      const log = { message: "Monitor alert email", event_id: entry.id, service_id: entry.service, attempt: entry.attempts + 1 };
      if (result.ok) console.info(JSON.stringify({ ...log, outcome: "accepted" }));
      else console.error(JSON.stringify({ ...log, outcome: retry ? "retrying" : "failed", reason: result.reason }));
    }
  }
}
