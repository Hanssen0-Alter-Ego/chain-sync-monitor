"""SQLite availability samples, aggregated into UTC minutes."""
from __future__ import annotations

import sqlite3
import time
from contextlib import closing
from pathlib import Path

WINDOWS = (24 * 60 * 60, 7 * 24 * 60 * 60)
RETENTION_MINUTES = 8 * 24 * 60
UNAVAILABLE_MESSAGE = "无法读取或写入可用率历史，实时同步检查仍在运行。"


def availability(stats=()) -> dict:
    # Missing observations are not assigned either an up or a down outcome.
    return {"windows": [
        {
            "seconds": seconds,
            "ratio": available / total if total else None,
            "available": available,
            "total": total,
        }
        for seconds, (available, total) in zip(WINDOWS, stats or ((0, 0),) * len(WINDOWS))
    ]}


class HistoryStore:
    """One writer per monitor, with a short transactional write and a minute summary cache."""

    def __init__(self, path: Path):
        self.path = path
        self.minute: int | None = None
        self.summary: dict[str, tuple[tuple[int, int], ...]] = {}

    def observe(self, outcomes: dict[str, bool], *, timestamp: float | None = None) -> dict[str, dict]:
        minute = int((time.time() if timestamp is None else timestamp) // 60)
        rebuild = self.minute != minute
        try:
            with closing(sqlite3.connect(self.path, timeout=1)) as connection, connection:
                connection.execute("""
                    CREATE TABLE IF NOT EXISTS availability_by_minute (
                        minute INTEGER NOT NULL,
                        service TEXT NOT NULL,
                        available INTEGER NOT NULL CHECK (available >= 0 AND available <= total),
                        total INTEGER NOT NULL CHECK (total > 0),
                        PRIMARY KEY (minute, service)
                    ) WITHOUT ROWID
                """)
                connection.executemany("""
                    INSERT INTO availability_by_minute (minute, service, available, total)
                    VALUES (?, ?, ?, 1)
                    ON CONFLICT (minute, service) DO UPDATE SET
                        available = available + excluded.available,
                        total = total + excluded.total
                """, ((minute, service, int(success)) for service, success in outcomes.items()))
                if rebuild:
                    # The current (possibly partial) bucket and the preceding N-1 minute
                    # buckets form each window, so the left cutoff is rounded by <60s.
                    day, week = (minute - seconds // 60 + 1 for seconds in WINDOWS)
                    connection.execute("DELETE FROM availability_by_minute WHERE minute < ?",
                                       (minute - RETENTION_MINUTES + 1,))
                    summary = {
                        service: ((day_up, day_total), (week_up, week_total))
                        for service, day_up, day_total, week_up, week_total in connection.execute("""
                            SELECT service,
                                COALESCE(SUM(available) FILTER (WHERE minute >= ?), 0),
                                COALESCE(SUM(total) FILTER (WHERE minute >= ?), 0),
                                SUM(available), SUM(total)
                            FROM availability_by_minute
                            WHERE minute BETWEEN ? AND ?
                            GROUP BY service
                        """, (day, day, week, minute))
                    }
                else:
                    summary = self.summary.copy()
                    for service, success in outcomes.items():
                        previous = summary.get(service, ((0, 0),) * len(WINDOWS))
                        summary[service] = tuple((up + int(success), total + 1) for up, total in previous)
        except (sqlite3.Error, OSError):
            self.minute = None
            self.summary = {}
            raise RuntimeError(UNAVAILABLE_MESSAGE) from None
        # Advance the in-memory view only after commit succeeds.
        self.minute, self.summary = minute, summary
        return {service: availability(stats) for service, stats in summary.items()}
