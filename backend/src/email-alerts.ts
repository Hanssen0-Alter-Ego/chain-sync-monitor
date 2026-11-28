import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { Service } from "../../shared/status.js";
import { record, type EmailAlertsConfig } from "./config.js";

const retryDelays = [30_000, 120_000, 600_000] as const;
const retention = 7 * 24 * 60 * 60 * 1000;
type EventKind = "OPEN" | "CHANGED" | "RECOVERED";
type Fault = "offline" | "degraded" | "reachable-but-lagging";
type Sample = Fault | "healthy" | null;
type EventRow = { id: string; subject: string; text: string; attempts: number };
type ServiceState = {
  incident: string | null; confirmed: Fault | null; first_bad: number | null;
  candidate: Sample; since: number; samples: number; last_seen: number | null;
  lag: number | null; lag_at: number | null;
};
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

function observation(service: Service, config: EmailAlertsConfig): Sample {
  if (service.state === "offline" || service.state === "degraded") return service.state;
  if (!service.probeAvailable || !["synced", "online", "syncing"].includes(service.state)) return null;
  if (service.kind !== "ckbadger") return "healthy";
  const gap = service.syncTipLag;
  if (gap === undefined || !Number.isSafeInteger(gap) || gap < 0) return null;
  if (gap <= 1) return "healthy";
  return gap >= config.lagBlocks ? "reachable-but-lagging" : null;
}

function reason(state: string, service: Service) {
  if (state === "reachable-but-lagging") return "Index persistently behind the verified CKB tip";
  if (state === "synced" && service.kind === "ckbadger") return "Index within one block of the verified CKB tip";
  return service.note ?? `Probe reports ${service.state}`;
}

function mailFor(
  service: Service, kind: EventKind, incident: string, firstBad: number, observedAt: number,
  last: ServiceState | undefined, state: string, since: number, statusUrl?: string,
) {
  const suffix = kind === "CHANGED" ? `changed:${randomUUID()}` : kind.toLowerCase();
  const id = `${incident}:${suffix}`;
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
    `state: ${state}`,
    `previous_state: ${last?.confirmed ?? (kind === "OPEN" ? "none" : "unknown")}`,
    `probe_state: ${service.state}`,
    `reason: ${reason(state, service)}`,
    `state_observed_since: ${iso(since)}`,
    `first_bad_at: ${iso(firstBad)}`,
    `observed_at: ${iso(observedAt)}`,
    ...(service.syncTipLag === undefined ? [] : [`tip_lag_blocks: ${service.syncTipLag}`]),
    ...(last?.confirmed === "reachable-but-lagging" && last.lag !== null && last.lag_at !== null
      ? [`previous_tip_lag_blocks: ${last.lag}`, `previous_lag_observed_at: ${iso(last.lag_at)}`] : []),
    ...(statusUrl ? [`status_url: ${statusUrl}`] : []),
    "",
    "Probe details:",
    ...(service.note ? [service.note] : []),
    ...service.metrics.map(metric => `${metric.label}: ${metric.value}${metric.unit ? ` ${metric.unit}` : ""}`),
  ];
  return { id, subject: `[Monitor Alert] ${kind} ${service.id}`, text: lines.join("\n") };
}

function initialize(db: DatabaseSync) {
  db.exec("BEGIN IMMEDIATE");
  db.exec(`CREATE TABLE IF NOT EXISTS email_alert_outbox (
    id TEXT PRIMARY KEY, service TEXT NOT NULL, subject TEXT NOT NULL, text TEXT NOT NULL,
    created INTEGER NOT NULL, next_try INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    finished INTEGER
  ) STRICT`);
  const legacy = db.prepare("PRAGMA table_info(email_alert_state)").all().some(col => col.name === "bad");
  if (legacy) db.exec("ALTER TABLE email_alert_state RENAME TO email_alert_state_legacy");
  db.exec(`CREATE TABLE IF NOT EXISTS email_alert_state (
    service TEXT PRIMARY KEY, incident TEXT, confirmed TEXT, first_bad INTEGER,
    candidate TEXT, since INTEGER NOT NULL, samples INTEGER NOT NULL, last_seen INTEGER, lag INTEGER, lag_at INTEGER
  ) STRICT`);
  if (legacy) {
    // Old streaks did not distinguish fault types or verify recovery. Keep active incidents
    // and recover the last confirmed fault from their OPEN event when it is still retained.
    const insert = db.prepare(`INSERT INTO email_alert_state
      (service, incident, confirmed, first_bad, since, samples) VALUES (?, ?, ?, ?, 0, 0)`);
    for (const row of db.prepare(`SELECT s.service, s.incident, s.first_bad, o.text
      FROM email_alert_state_legacy s LEFT JOIN email_alert_outbox o ON o.id = s.incident || ':open'
      WHERE s.incident IS NOT NULL`).all()) {
      const confirmed = String(row.text ?? "").split("\n\n")[0].match(/^state: (offline|degraded)$/m)?.[1];
      insert.run(row.service, row.incident, confirmed ?? null, row.first_bad);
    }
    db.exec("DROP TABLE email_alert_state_legacy");
  }
  db.exec("COMMIT");
}

export class EmailAlerts {
  private sending?: Promise<void>;
  private initialized = false;
  constructor(
    private readonly dbPath: string,
    private readonly config: EmailAlertsConfig,
    private readonly send = sendCloudflareEmail,
    private readonly maxSampleGapMs = 45_000,
  ) {}

  private withDb<T>(operation: (db: DatabaseSync) => T) {
    const db = new DatabaseSync(this.dbPath);
    try {
      db.exec("PRAGMA busy_timeout = 1000;");
      if (!this.initialized) {
        initialize(db);
        this.initialized = true;
      }
      return operation(db);
    } finally { db.close(); }
  }

  observe(services: Service[], now = Date.now()) {
    const events = this.withDb(db => {
      const queued = [];
      db.exec("BEGIN IMMEDIATE;");
      const read = db.prepare("SELECT * FROM email_alert_state WHERE service = ?");
      const save = db.prepare(`INSERT OR REPLACE INTO email_alert_state
        (service, incident, confirmed, first_bad, candidate, since, samples, last_seen, lag, lag_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const clear = db.prepare("DELETE FROM email_alert_state WHERE service = ?");
      const enqueue = db.prepare("INSERT INTO email_alert_outbox (id, service, subject, text, created, next_try) VALUES (?, ?, ?, ?, ?, ?)");
      for (const service of services) {
        const last = read.get(service.id) as ServiceState | undefined;
        if (now === last?.last_seen) continue;
        const sample = observation(service, this.config);
        let incident = last?.incident ?? null, confirmed = last?.confirmed ?? null;
        if (!incident && (!sample || sample === "healthy")) {
          if (last) clear.run(service.id);
          continue;
        }
        const timely = last && last.last_seen !== null && now > last.last_seen && now - last.last_seen <= this.maxSampleGapMs;
        const same = timely && last.candidate === sample;
        // Preserve OPEN on consecutive failures even if HTTP failure and transport failure alternate.
        const continuingFailure = timely && !incident && (sample === "offline" || sample === "degraded")
          && (last.candidate === "offline" || last.candidate === "degraded");
        const since = same ? last.since : now;
        const samples = same || continuingFailure ? last.samples + 1 : 1;
        const firstBad = incident || continuingFailure ? last?.first_bad ?? since : since;
        const recovering = sample === "healthy";
        const checks = recovering ? Math.max(service.kind === "ckbadger" ? 2 : 1, this.config.recoveryChecks)
          : this.config.failureChecks;
        const sustained = sample !== "reachable-but-lagging" || (samples >= 2 && now - since >= this.config.lagSeconds * 1000);
        if (sample && sample !== confirmed && samples >= checks && sustained) {
          // With an expired legacy OPEN, confirming offline/degraded establishes the
          // missing baseline. Neither state proves the fault changed since that OPEN.
          const baseline = incident && !confirmed && (sample === "offline" || sample === "degraded");
          if (!baseline) {
            const event = recovering ? "RECOVERED" : incident ? "CHANGED" : "OPEN";
            incident ??= randomUUID();
            const state = recovering ? (service.kind === "ckbadger" ? "synced" : service.state) : sample;
            const mail = mailFor(service, event, incident, firstBad, now, last, state, since, this.config.statusUrl);
            enqueue.run(mail.id, service.id, mail.subject, mail.text, now, now);
            queued.push({ event, event_id: mail.id, service_id: service.id, state });
          }
          if (recovering) {
            clear.run(service.id);
            continue;
          }
          confirmed = sample;
        }
        const lagging = sample === "reachable-but-lagging";
        save.run(service.id, incident, confirmed, firstBad, sample, since, samples, now,
          lagging ? service.syncTipLag! : last?.lag ?? null, lagging ? now : last?.lag_at ?? null);
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
