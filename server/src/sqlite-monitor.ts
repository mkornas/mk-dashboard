/**
 * SQLite alerts, fed into the sampler's alert list: a WAL that stays large
 * (the app's checkpoints are stuck), a snapshot older than the limit, and a
 * nightly integrity check. `refresh()` re-reads the files off the sampling
 * path every few minutes; `alerts()` is synchronous and only looks at what
 * the last refresh saw.
 */
import type { Config } from './config.ts';
import { fmtDuration } from './notify.ts';
import type { SqliteConsole } from './sqlite.ts';
import type { Alert, SqliteDb } from '../../shared/types.ts';

/** How long the WAL has to stay above the limit before it is an alert. */
const WAL_FOR_MS = 60 * 60_000;
const LINK = '/databases';

interface Watched {
  db: SqliteDb;
  /** When the WAL first exceeded the limit; unset while it is small. */
  walBigSince?: number;
  /** The last scheduled integrity check. */
  integrity?: { ok: boolean; lines: string[]; at: number };
}

export class SqliteMonitor {
  private readonly cfg: Pick<Config, 'sqliteWalMb' | 'sqliteSnapshotStaleHours' | 'sqliteIntegrityHour'>;
  private readonly console: SqliteConsole;
  private readonly watched = new Map<string, Watched>();
  private integrityAt: number;

  constructor(cfg: SqliteMonitor['cfg'], console: SqliteConsole, now = Date.now()) {
    this.cfg = cfg;
    this.console = console;
    this.integrityAt = now; // the first nightly check is the next one, not one on boot
  }

  /** Re-read every database's size, WAL and snapshots; run the integrity check when its hour has passed. */
  async refresh(now = Date.now()): Promise<void> {
    const seen = new Set<string>();
    for (const db of await this.console.list()) {
      seen.add(db.path);
      const w = this.watched.get(db.path) ?? { db };
      w.db = db;
      if (db.walSize > this.cfg.sqliteWalMb * 1024 * 1024) w.walBigSince ??= now;
      else delete w.walBigSince;
      this.watched.set(db.path, w);
    }
    for (const path of this.watched.keys()) if (!seen.has(path)) this.watched.delete(path);
    if (this.integrityDue(now)) await this.checkIntegrity(now);
  }

  /** Due once the configured hour has come round since the last run. */
  private integrityDue(now: number): boolean {
    const hour = this.cfg.sqliteIntegrityHour;
    if (hour === null) return false;
    const last = new Date(now);
    last.setHours(hour, 0, 0, 0);
    if (last.getTime() > now) last.setDate(last.getDate() - 1);
    return this.integrityAt < last.getTime();
  }

  /** `PRAGMA integrity_check` on every database, one after the other, each in its own process with a deadline. */
  async checkIntegrity(now = Date.now()): Promise<void> {
    this.integrityAt = now;
    for (const w of this.watched.values()) {
      try {
        const h = await this.console.health(w.db.path);
        w.integrity = { ok: h.ok, lines: h.integrity, at: now };
      } catch (e) {
        w.integrity = { ok: false, lines: [(e as Error).message], at: now };
      }
      if (!w.integrity.ok) console.warn(`sqlite: ${w.db.path} failed its integrity check: ${w.integrity.lines[0]}`);
    }
  }

  alerts(now = Date.now()): Alert[] {
    const out: Alert[] = [];
    const staleMs = this.cfg.sqliteSnapshotStaleHours * 3_600_000;
    for (const w of this.watched.values()) {
      const name = w.db.stack ? `${w.db.stack}/${w.db.name}` : w.db.name;
      if (w.integrity && !w.integrity.ok)
        out.push({ level: 'danger', title: `${name} failed its integrity check`, detail: w.integrity.lines[0], link: LINK, since: w.integrity.at });
      if (w.walBigSince !== undefined && now - w.walBigSince >= WAL_FOR_MS)
        out.push({
          level: 'warning',
          title: `WAL of ${name} is not checkpointing`,
          detail: `${Math.round(w.db.walSize / 1024 / 1024)} MB for ${fmtDuration(now - w.walBigSince)} (limit ${this.cfg.sqliteWalMb} MB)`,
          link: LINK,
          since: w.walBigSince,
        });
      if (staleMs && w.db.lastSnapshot && now - w.db.lastSnapshot.at > staleMs)
        out.push({
          level: 'warning',
          title: `Snapshot of ${name} is stale`,
          detail: `Newest snapshot is ${Math.round((now - w.db.lastSnapshot.at) / 3_600_000)} h old (limit ${this.cfg.sqliteSnapshotStaleHours} h)`,
          link: LINK,
        });
    }
    return out;
  }
}
