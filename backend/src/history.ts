import { DatabaseSync } from "node:sqlite";
import type { Availability, AvailabilityBin } from "../../shared/status.js";

const windows = [24 * 60 * 60, 7 * 24 * 60 * 60];
const binMinutes = 120;
const binCount = 12;
const retention = 8 * 24 * 60;
export const historyError = "无法读取或写入可用率历史，实时同步检查仍在运行。";
type Counts = readonly [up: number, total: number];
type Summary = Record<string, [Counts, Counts]>;
export function availability(counts: [Counts, Counts] = [[0, 0], [0, 0]], dayBins?: AvailabilityBin[]): Availability {
  return { dayBins, windows: windows.map((seconds, index) => {
    const [available, total] = counts[index];
    return { seconds, ratio: total ? available / total : null, available, total };
  }) };
}
export class HistoryStore {
  private minute?: number;
  private summary: Summary = {};
  private bins: Record<string, AvailabilityBin[]> = {};
  constructor(private readonly path: string) {}
  observe(outcomes: Map<string, boolean>, now = Date.now()): Record<string, Availability> {
    const minute = Math.floor(now / 60_000);
    let summary: Summary;
    let bins: Record<string, AvailabilityBin[]>;
    const dayStart = minute - binMinutes * binCount + 1;
    const emptyBins = () => Array.from({ length: binCount }, (_, i) => ({ startMinute: dayStart + i * binMinutes, available: 0, total: 0 }));
    try {
      const db = new DatabaseSync(this.path);
      try {
        db.exec(`
          PRAGMA busy_timeout = 1000;
          CREATE TABLE IF NOT EXISTS availability_by_minute (
            minute INTEGER NOT NULL,
            service TEXT NOT NULL,
            available INTEGER NOT NULL CHECK (available >= 0 AND available <= total),
            total INTEGER NOT NULL CHECK (total > 0),
            PRIMARY KEY (minute, service)
          ) WITHOUT ROWID;
          BEGIN IMMEDIATE;
        `);
        const add = db.prepare(`
          INSERT INTO availability_by_minute (minute, service, available, total) VALUES (?, ?, ?, 1)
          ON CONFLICT (minute, service) DO UPDATE SET
            available = available + excluded.available, total = total + excluded.total
        `);
        for (const [id, success] of outcomes) add.run(minute, id, Number(success));
        if (this.minute !== minute) {
          const [day, week] = windows.map(seconds => minute - seconds / 60 + 1);
          db.prepare("DELETE FROM availability_by_minute WHERE minute < ?").run(minute - retention + 1);
          const rows = db.prepare(`
            SELECT service, COALESCE(SUM(available) FILTER (WHERE minute >= ?), 0) day_up,
              COALESCE(SUM(total) FILTER (WHERE minute >= ?), 0) day_total,
              SUM(available) week_up, SUM(total) week_total
            FROM availability_by_minute WHERE minute BETWEEN ? AND ? GROUP BY service
          `).all(day, day, week, minute);
          summary = Object.fromEntries(rows.map(row => [row.service as string, [
            [row.day_up as number, row.day_total as number], [row.week_up as number, row.week_total as number],
          ]]));
          bins = Object.create(null);
          const binRows = db.prepare(`
            SELECT service, CAST((minute - ?) / ? AS INTEGER) bin, SUM(available) up, SUM(total) total
            FROM availability_by_minute WHERE minute BETWEEN ? AND ? GROUP BY service, bin
          `).all(dayStart, binMinutes, dayStart, minute);
          for (const row of binRows) {
            const bin = (bins[row.service as string] ??= emptyBins())[row.bin as number];
            bin.available = row.up as number;
            bin.total = row.total as number;
          }
        } else {
          bins = Object.assign(Object.create(null), this.bins);
          summary = { ...this.summary };
          for (const [id, success] of outcomes) {
            const nextBins = [...(bins[id] ?? emptyBins())];
            const last = nextBins[binCount - 1];
            nextBins[binCount - 1] = { ...last, available: last.available + Number(success), total: last.total + 1 };
            bins[id] = nextBins;
            const [day, week] = Object.hasOwn(summary, id) ? summary[id] : [[0, 0], [0, 0]];
            summary[id] = [[day[0] + Number(success), day[1] + 1], [week[0] + Number(success), week[1] + 1]];
          }
        }
        db.exec("COMMIT");
      } finally {
        db.close(); // Uncommitted transactions are rolled back on close.
      }
    } catch {
      this.minute = undefined;
      this.summary = {};
      this.bins = {};
      throw new Error(historyError);
    }
    this.minute = minute;
    this.summary = summary;
    this.bins = bins;
    return Object.fromEntries(Object.entries(summary).map(([id, counts]) => [id, availability(counts, bins[id] ?? emptyBins())]));
  }
}
