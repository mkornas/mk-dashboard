/**
 * Long metric history in SQLite (`<data dir>/history.db`). Every sample is
 * averaged into its minute for the host and for each running container (by
 * name, which survives a re-create); minutes are rolled up into hours when
 * the hour turns. Minutes are kept for two days, hours for DASH_HISTORY_DAYS.
 * The sampler's in-memory ring stays the live per-sample view; this is what
 * the charts' range picker reads.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Config } from './config.ts';
import type { ContainerHistory, HistoryRange, HostHistory, Snapshot } from '../../shared/types.ts';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const MINUTES_KEPT = 2 * DAY;

export const RANGES: Record<HistoryRange, { ms: number; step: number }> = {
  '1h': { ms: HOUR, step: MINUTE },
  '24h': { ms: DAY, step: MINUTE },
  '7d': { ms: 7 * DAY, step: HOUR },
  '30d': { ms: 30 * DAY, step: HOUR },
};

export function isRange(v: unknown): v is HistoryRange {
  return typeof v === 'string' && v in RANGES;
}

interface Acc {
  n: number;
  cpu: number;
  mem: number;
  rx: number;
  tx: number;
}

export class HistoryStore {
  private readonly db: DatabaseSync;
  private readonly days: number;
  private minute = 0;
  private hour = 0;
  private hostAcc: Acc = { n: 0, cpu: 0, mem: 0, rx: 0, tx: 0 };
  private readonly containers = new Map<string, Acc>();

  constructor(cfg: Pick<Config, 'dataDir' | 'historyDays'>) {
    this.days = cfg.historyDays;
    let file = ':memory:';
    if (cfg.dataDir) {
      mkdirSync(cfg.dataDir, { recursive: true });
      file = join(cfg.dataDir, 'history.db');
    }
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS host_minute (t INTEGER PRIMARY KEY, cpu REAL NOT NULL, mem REAL NOT NULL, net_rx REAL NOT NULL, net_tx REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS host_hour   (t INTEGER PRIMARY KEY, cpu REAL NOT NULL, mem REAL NOT NULL, net_rx REAL NOT NULL, net_tx REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS container_minute (name TEXT NOT NULL, t INTEGER NOT NULL, cpu REAL NOT NULL, mem REAL NOT NULL, PRIMARY KEY (name, t));
      CREATE TABLE IF NOT EXISTS container_hour   (name TEXT NOT NULL, t INTEGER NOT NULL, cpu REAL NOT NULL, mem REAL NOT NULL, PRIMARY KEY (name, t));
    `);
  }

  /** Fold one snapshot into the current minute; the minute before is written when a new one starts. */
  record(s: Snapshot): void {
    const minute = Math.floor(s.t / MINUTE) * MINUTE;
    if (this.minute && minute !== this.minute) this.flush(minute);
    this.minute = minute;
    const h = this.hostAcc;
    h.n++;
    h.cpu += s.host.cpu.percent;
    h.mem += s.host.memory.percent;
    h.rx += s.host.netRxRate;
    h.tx += s.host.netTxRate;
    for (const c of s.containers) {
      if (!c.stats) continue;
      let a = this.containers.get(c.name);
      if (!a) {
        a = { n: 0, cpu: 0, mem: 0, rx: 0, tx: 0 };
        this.containers.set(c.name, a);
      }
      a.n++;
      a.cpu += c.stats.cpuPercent;
      a.mem += c.stats.memUsage;
    }
  }

  /** Write the accumulated minute; roll up and prune when the hour turned. `next` is the minute that just started. */
  flush(next = this.minute + MINUTE): void {
    if (this.hostAcc.n) {
      const h = this.hostAcc;
      this.db
        .prepare('INSERT OR REPLACE INTO host_minute VALUES (?, ?, ?, ?, ?)')
        .run(this.minute, h.cpu / h.n, h.mem / h.n, h.rx / h.n, h.tx / h.n);
      const ins = this.db.prepare('INSERT OR REPLACE INTO container_minute VALUES (?, ?, ?, ?)');
      for (const [name, a] of this.containers) ins.run(name, this.minute, a.cpu / a.n, a.mem / a.n);
    }
    this.hostAcc = { n: 0, cpu: 0, mem: 0, rx: 0, tx: 0 };
    this.containers.clear();
    const hour = Math.floor(next / HOUR) * HOUR;
    if (hour !== this.hour) {
      this.rollup(hour);
      this.hour = hour;
    }
  }

  /** Every finished hour from the minutes still kept (idempotent), then prune. */
  private rollup(currentHour: number): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO host_hour
         SELECT (t / ${HOUR}) * ${HOUR}, AVG(cpu), AVG(mem), AVG(net_rx), AVG(net_tx) FROM host_minute WHERE t < ? GROUP BY 1`,
      )
      .run(currentHour);
    this.db
      .prepare(
        `INSERT OR REPLACE INTO container_hour
         SELECT name, (t / ${HOUR}) * ${HOUR}, AVG(cpu), AVG(mem) FROM container_minute WHERE t < ? GROUP BY name, 2`,
      )
      .run(currentHour);
    this.db.prepare('DELETE FROM host_minute WHERE t < ?').run(currentHour - MINUTES_KEPT);
    this.db.prepare('DELETE FROM container_minute WHERE t < ?').run(currentHour - MINUTES_KEPT);
    this.db.prepare('DELETE FROM host_hour WHERE t < ?').run(currentHour - this.days * DAY);
    this.db.prepare('DELETE FROM container_hour WHERE t < ?').run(currentHour - this.days * DAY);
  }

  host(range: HistoryRange, now = Date.now()): HostHistory {
    const { ms, step } = RANGES[range];
    const table = step === MINUTE ? 'host_minute' : 'host_hour';
    const rows = this.db
      .prepare(`SELECT t, cpu, mem, net_rx AS netRx, net_tx AS netTx FROM ${table} WHERE t >= ? ORDER BY t`)
      .all(now - ms) as Array<{ t: number; cpu: number; mem: number; netRx: number; netTx: number }>;
    return { range, step, points: rows.map((r) => ({ t: r.t, cpu: round1(r.cpu), mem: round1(r.mem), netRx: Math.round(r.netRx), netTx: Math.round(r.netTx) })) };
  }

  container(name: string, range: HistoryRange, now = Date.now()): ContainerHistory {
    const { ms, step } = RANGES[range];
    const table = step === MINUTE ? 'container_minute' : 'container_hour';
    const rows = this.db
      .prepare(`SELECT t, cpu, mem FROM ${table} WHERE name = ? AND t >= ? ORDER BY t`)
      .all(name, now - ms) as Array<{ t: number; cpu: number; mem: number }>;
    return { range, step, points: rows.map((r) => ({ t: r.t, cpu: round1(r.cpu), mem: Math.round(r.mem) })) };
  }

  close(): void {
    this.flush();
    this.db.close();
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
