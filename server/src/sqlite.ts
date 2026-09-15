/**
 * The SQLite console: find every SQLite file under the stacks directories,
 * look inside (tables, rows, one read-only query), keep snapshots and put one
 * back. Every read opens its own read-only connection and closes it; the two
 * writes — snapshot and restore — are the only ones, and restore stops the
 * owning container first. Files are addressed by their host path, and only
 * paths the discovery found are ever opened.
 */
import { fork } from 'node:child_process';
import { DatabaseSync, backup } from 'node:sqlite';
import {
  access,
  constants,
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config, SqliteEntry } from './config.ts';
import type { DockerClient } from './docker.ts';
import type { SqliteJob, SqliteJobResult } from './sqlite-worker.ts';
import type {
  ContainerState,
  SqliteDb,
  SqliteDbDetail,
  SqliteHealth,
  SqliteQueryResult,
  SqliteRows,
  SqliteSnapshot,
  SqliteTable,
} from '../../shared/types.ts';

const HEADER = Buffer.from('SQLite format 3\0');
const EXT = new Set(['.db', '.sqlite', '.sqlite3']);
const SKIP = new Set(['node_modules', '.git', 'thumbs', 'cache', 'tmp']);
const ROW_CAP = 1000;
const SQLITE_CANTOPEN = 14;
const WORKER = fileURLToPath(new URL('./sqlite-worker.ts', import.meta.url));

interface Dir {
  host: string;
  local: string;
}

interface Found {
  host: string;
  local: string;
  dir: Dir;
  /** Set for files named in DASH_SQLITE. */
  stack?: string;
  label?: string;
}

export class SqliteConsole {
  private readonly dirs: Dir[];
  private readonly explicit: SqliteEntry[];
  private readonly hostRoot: string;
  private readonly snapshotDir: string;
  private readonly docker: DockerClient | null;
  private readonly queryMs: number;
  private readonly integrityMs: number;
  private found = new Map<string, Found>();
  private foundAt = 0;
  private readonly missing = new Set<string>();

  constructor(
    cfg: Pick<
      Config,
      | 'sqliteDirs'
      | 'sqlite'
      | 'sqliteSnapshotDir'
      | 'hostRoot'
      | 'dataDir'
      | 'sqliteQueryMs'
      | 'sqliteIntegrityMs'
    >,
    docker: DockerClient | null,
  ) {
    this.explicit = cfg.sqlite;
    this.hostRoot = cfg.hostRoot;
    this.queryMs = cfg.sqliteQueryMs;
    this.integrityMs = cfg.sqliteIntegrityMs;
    this.dirs = cfg.sqliteDirs
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((spec) => {
        const [host, local] = spec.split(':');
        return {
          host: resolve('/', host),
          local: local ? resolve('/', local) : join(cfg.hostRoot, host),
        };
      });
    this.snapshotDir = cfg.sqliteSnapshotDir || join(cfg.dataDir || '/tmp', 'sqlite-snapshots');
    this.docker = docker;
  }

  /** Every SQLite file under the configured directories, three levels deep, plus the ones named in DASH_SQLITE. Cached for 30 s. */
  private async discover(): Promise<Map<string, Found>> {
    if (Date.now() - this.foundAt < 30_000) return this.found;
    const out = new Map<string, Found>();
    for (const dir of this.dirs) await walk(dir, dir.local, 0, out);
    for (const e of this.explicit) {
      const host = resolve('/', e.path);
      const local = this.localFor(host);
      if (!(await isSqlite(local))) {
        if (!this.missing.has(host)) console.warn(`DASH_SQLITE: ${host} is not a SQLite file (looked at ${local})`);
        this.missing.add(host);
        continue;
      }
      this.missing.delete(host);
      const dir = { host: dirname(host), local: dirname(local) };
      out.set(host, { ...(out.get(host) ?? { host, local, dir }), stack: e.stack, label: e.label });
    }
    this.found = out;
    this.foundAt = Date.now();
    return out;
  }

  /** Where a host path is seen from here: through a DASH_SQLITE_DIRS mapping when one covers it, else the host-root mount. */
  private localFor(host: string): string {
    const dir = this.dirs.find((d) => host === d.host || host.startsWith(d.host + '/'));
    return dir ? join(dir.local, host.slice(dir.host.length)) : join(this.hostRoot, host);
  }

  private async lookup(hostPath: string): Promise<Found> {
    const f = (await this.discover()).get(hostPath);
    if (!f) throw new NotFound(`no database at ${hostPath}`);
    return f;
  }

  /** Which container has the file's directory mounted (matched on the host path). */
  private async containers(): Promise<
    Array<{
      id: string;
      name: string;
      state: ContainerState;
      stack: string | null;
      mounts: string[];
    }>
  > {
    if (!this.docker) return [];
    try {
      const list = await this.docker.get<
        Array<{
          Id: string;
          Names: string[];
          State: string;
          Labels: Record<string, string>;
          Mounts: Array<{ Source?: string }>;
        }>
      >('/containers/json?all=1');
      return list.map((c) => ({
        id: c.Id,
        name: (c.Names[0] ?? '').replace(/^\//, ''),
        state: c.State as ContainerState,
        stack: c.Labels?.['com.docker.compose.project'] ?? null,
        mounts: (c.Mounts ?? []).map((m) => m.Source ?? '').filter(Boolean),
      }));
    } catch {
      return [];
    }
  }

  async list(): Promise<SqliteDb[]> {
    const [found, containers] = await Promise.all([this.discover(), this.containers()]);
    const out: SqliteDb[] = [];
    for (const f of found.values()) out.push(await this.describe(f, containers));
    return out.sort(
      (a, b) => (a.stack ?? '~').localeCompare(b.stack ?? '~') || a.name.localeCompare(b.name),
    );
  }

  private async describe(
    f: Found,
    containers: Awaited<ReturnType<SqliteConsole['containers']>>,
  ): Promise<SqliteDb> {
    const st = await stat(f.local);
    const wal = await stat(f.local + '-wal').catch(() => null);
    const owner = ownerOf(f.host, containers);
    const rel = f.host.slice(f.dir.host.length).replace(/^\//, '');
    const stack = f.stack ?? owner?.stack ?? (rel.includes('/') ? rel.split('/')[0] : null);
    let writable = false;
    try {
      await access(dirname(f.local), constants.W_OK);
      writable = true;
    } catch {
      /* read-only mount */
    }
    const snaps = await this.snapshots(f.host);
    return {
      path: f.host,
      name: f.label ?? basename(f.host),
      stack,
      container: owner ? { id: owner.id, name: owner.name, state: owner.state } : null,
      size: st.size,
      walSize: wal?.size ?? 0,
      mtime: st.mtimeMs,
      writable,
      lastSnapshot: snaps[0] ?? null,
    };
  }

  /** A read-only connection for one call; `immutable` tells whether the WAL had to be left out. */
  private async open<T>(hostPath: string, fn: (db: DatabaseSync, immutable: boolean) => T): Promise<T> {
    const f = await this.lookup(hostPath);
    const { db, immutable } = openReadOnly(f.local);
    try {
      return fn(db, immutable);
    } finally {
      db.close();
    }
  }

  async detail(hostPath: string): Promise<SqliteDbDetail> {
    const f = await this.lookup(hostPath);
    const base = await this.describe(f, await this.containers());
    return this.open(hostPath, (db, immutable) => {
      const one = (sql: string) => (db.prepare(sql).get() as Record<string, unknown>) ?? {};
      const tables: SqliteTable[] = [];
      for (const t of db
        .prepare(
          "SELECT name, type, sql FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name",
        )
        .all() as { name: string; type: 'table' | 'view'; sql: string }[]) {
        const columns = (
          db.prepare(`PRAGMA table_info(${quote(t.name)})`).all() as {
            name: string;
            type: string;
            pk: number;
            notnull: number;
          }[]
        ).map((c) => ({
          name: c.name,
          type: c.type,
          pk: c.pk > 0,
          notNull: !!c.notnull,
        }));
        let rows: number | null = null;
        if (t.type === 'table') {
          try {
            rows = Number(
              (db.prepare(`SELECT COUNT(*) AS n FROM ${quote(t.name)}`).get() as { n: number }).n,
            );
          } catch {
            rows = null;
          }
        }
        tables.push({
          name: t.name,
          kind: t.type,
          rows,
          columns,
          sql: t.sql ?? '',
        });
      }
      return {
        ...base,
        tables,
        pageSize: Number(one('PRAGMA page_size').page_size ?? 0),
        pageCount: Number(one('PRAGMA page_count').page_count ?? 0),
        freelistCount: Number(one('PRAGMA freelist_count').freelist_count ?? 0),
        journalMode: String(one('PRAGMA journal_mode').journal_mode ?? ''),
        userVersion: Number(one('PRAGMA user_version').user_version ?? 0),
        immutable,
        snapshots: [] as SqliteSnapshot[],
      };
    }).then(async (d) => ({ ...d, snapshots: await this.snapshots(hostPath) }));
  }

  async rows(
    hostPath: string,
    table: string,
    opts: {
      offset?: number;
      limit?: number;
      sort?: string;
      dir?: 'asc' | 'desc';
    } = {},
  ): Promise<SqliteRows> {
    return this.open(hostPath, (db) => {
      const exists = db
        .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name = ?")
        .get(table);
      if (!exists) throw new NotFound(`no table ${table}`);
      const columns = (
        db.prepare(`PRAGMA table_info(${quote(table)})`).all() as {
          name: string;
        }[]
      ).map((c) => c.name);
      const limit = Math.min(500, Math.max(1, opts.limit ?? 100));
      const offset = Math.max(0, opts.offset ?? 0);
      const order =
        opts.sort && columns.includes(opts.sort)
          ? ` ORDER BY ${quote(opts.sort)} ${opts.dir === 'desc' ? 'DESC' : 'ASC'}`
          : '';
      const total = Number(
        (
          db.prepare(`SELECT COUNT(*) AS n FROM ${quote(table)}`).get() as {
            n: number;
          }
        ).n,
      );
      const rows = (
        db
          .prepare(`SELECT * FROM ${quote(table)}${order} LIMIT ? OFFSET ?`)
          .all(limit, offset) as Record<string, unknown>[]
      ).map((r) => columns.map((c) => cell(r[c])));
      return { columns, rows, total, offset, limit };
    });
  }

  /** One read-only statement: SELECT / WITH / EXPLAIN / PRAGMA, capped at 1,000 rows, given up on after `DASH_SQLITE_QUERY_MS`. */
  async query(hostPath: string, sql: string): Promise<SqliteQueryResult> {
    const text = sql.trim().replace(/;\s*$/, '');
    if (!text) throw new BadQuery('empty statement');
    if (text.includes(';')) throw new BadQuery('one statement at a time');
    if (!/^(select|with|explain|pragma)\b/i.test(text))
      throw new BadQuery('only SELECT, WITH, EXPLAIN and PRAGMA run here');
    if (
      /^pragma\s+\w+\s*=/i.test(text) ||
      /^pragma\s+(writable_schema|journal_mode|synchronous)\b/i.test(text)
    )
      throw new BadQuery('that PRAGMA writes');
    const f = await this.lookup(hostPath);
    const started = Date.now();
    const r = await runIsolated({ path: f.local, sql: text, rowCap: ROW_CAP }, this.queryMs);
    return { ...r, ms: Date.now() - started };
  }

  /** `PRAGMA integrity_check`, in its own process, given up on after `DASH_SQLITE_INTEGRITY_MS`. */
  async health(hostPath: string): Promise<SqliteHealth> {
    const f = await this.lookup(hostPath);
    const started = Date.now();
    const r = await runIsolated(
      { path: f.local, sql: 'PRAGMA integrity_check', rowCap: 20 },
      this.integrityMs,
    );
    const lines = r.rows.map((row) => String(row[0]));
    return {
      integrity: lines,
      ok: lines.length === 1 && lines[0] === 'ok',
      ms: Date.now() - started,
      checkedAt: Date.now(),
    };
  }

  // ---- snapshots ----

  private snapshotFolder(hostPath: string): string {
    return join(this.snapshotDir, hostPath.replace(/^\/+/, '').replace(/\//g, '__'));
  }

  async snapshots(hostPath: string): Promise<SqliteSnapshot[]> {
    const dir = this.snapshotFolder(hostPath);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return [];
    }
    const out: SqliteSnapshot[] = [];
    for (const n of names) {
      if (!n.endsWith('.db')) continue;
      const s = await stat(join(dir, n)).catch(() => null);
      if (s) out.push({ file: n, size: s.size, at: s.mtimeMs });
    }
    return out.sort((a, b) => b.at - a.at);
  }

  /** A consistent copy through SQLite's online backup, even while the app writes. */
  async snapshot(hostPath: string): Promise<SqliteSnapshot> {
    const f = await this.lookup(hostPath);
    const dir = this.snapshotFolder(hostPath);
    await mkdir(dir, { recursive: true });
    const name = `${basename(hostPath).replace(/\.[^.]+$/, '')}.${new Date().toISOString().replace(/[:.]/g, '-')}.db`;
    const dest = join(dir, name);
    const { db } = openReadOnly(f.local);
    try {
      await backup(db, dest);
    } finally {
      db.close();
    }
    const s = await stat(dest);
    return { file: name, size: s.size, at: s.mtimeMs };
  }

  /**
   * Put a snapshot back: stop the owning container, keep the current file as
   * `.before-restore`, copy the snapshot over, drop `-wal`/`-shm`, start the
   * container again. Refused when the file's directory is not writable.
   */
  async restore(hostPath: string, file: string): Promise<{ stopped: string | null; kept: string }> {
    const f = await this.lookup(hostPath);
    if (!/^[\w.-]+\.db$/.test(file)) throw new BadQuery('bad snapshot name');
    const src = join(this.snapshotFolder(hostPath), file);
    await stat(src).catch(() => {
      throw new NotFound(`no snapshot ${file}`);
    });
    try {
      await access(dirname(f.local), constants.W_OK);
    } catch {
      throw new NotWritable(
        `${dirname(hostPath)} is mounted read-only here; mount it read-write and name it in DASH_SQLITE_DIRS to restore`,
      );
    }
    const owner = ownerOf(f.host, await this.containers());
    let stopped: string | null = null;
    if (owner && owner.state === 'running' && this.docker) {
      await this.docker.post(`/containers/${encodeURIComponent(owner.id)}/stop?t=15`);
      stopped = owner.name;
    }
    try {
      const kept = f.local + '.before-restore';
      await rm(kept, { force: true });
      await rename(f.local, kept);
      await copyFile(src, f.local);
      await rm(f.local + '-wal', { force: true });
      await rm(f.local + '-shm', { force: true });
      return { stopped, kept: basename(kept) };
    } finally {
      if (stopped && this.docker)
        await this.docker
          .post(`/containers/${encodeURIComponent(owner!.id)}/start`)
          .catch(() => {});
      this.foundAt = 0;
    }
  }

  /** CSV of one table, streamed as text (small tables only — it is an export, not a backup). */
  async exportTable(hostPath: string, table: string, format: 'csv' | 'json'): Promise<string> {
    const r = await this.rows(hostPath, table, { limit: 500, offset: 0 });
    const all: unknown[][] = [];
    let offset = 0;
    while (offset < r.total && all.length < 50_000) {
      const page = offset === 0 ? r : await this.rows(hostPath, table, { limit: 500, offset });
      all.push(...page.rows);
      offset += 500;
    }
    if (format === 'json')
      return JSON.stringify(
        all.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]]))),
        null,
        2,
      );
    const esc = (v: unknown) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return (
      [r.columns.map(esc).join(','), ...all.map((row) => row.map(esc).join(','))].join('\n') + '\n'
    );
  }
}

/**
 * A read-only connection. A WAL database needs its `-shm` file to be usable;
 * on a read-only mount, or when another uid owns it, the open succeeds but
 * the first statement fails with SQLITE_CANTOPEN. Then the file is opened
 * `immutable`: a consistent view of the main file that leaves out whatever
 * still sits in the WAL, so it may be slightly behind the app.
 */
export function openReadOnly(local: string): { db: DatabaseSync; immutable: boolean } {
  const db = new DatabaseSync(local, { readOnly: true });
  try {
    db.prepare('SELECT 1 FROM sqlite_master LIMIT 1').get();
    return { db, immutable: false };
  } catch (e) {
    db.close();
    if ((e as { errcode?: number }).errcode !== SQLITE_CANTOPEN) throw e;
    const uri = `file:${local.split('/').map(encodeURIComponent).join('/')}?immutable=1`;
    return { db: new DatabaseSync(uri, { readOnly: true }), immutable: true };
  }
}

/**
 * Run one statement in a forked process (see sqlite-worker.ts) and kill it
 * past the deadline. A bad statement comes back as `BadQuery`, the deadline as
 * `Timeout`.
 */
function runIsolated(job: SqliteJob, timeoutMs: number): Promise<SqliteJobResult> {
  return new Promise((resolve, reject) => {
    const child = fork(WORKER, [JSON.stringify(job)], {
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Timeout(`gave up after ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);
    child.once('message', (m: { result?: SqliteJobResult; error?: string }) => {
      clearTimeout(timer);
      if (m.result) resolve(m.result);
      else reject(new BadQuery(m.error ?? 'no result'));
    });
    child.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`sqlite worker exited with ${signal ?? code}`)); // a no-op once a message or the deadline settled it
    });
  });
}

/**
 * The container that has the file's directory mounted: the one with the most
 * specific mount source. A container that mounts the whole host root (this
 * dashboard does) is never the owner of anything.
 */
export function ownerOf<C extends { mounts: string[] }>(
  hostPath: string,
  containers: C[],
): C | null {
  let best: { c: C; len: number } | null = null;
  for (const c of containers) {
    for (const raw of c.mounts) {
      const m = raw.replace(/\/+$/, '');
      if (m.length < 2) continue;
      if (hostPath !== m && !hostPath.startsWith(m + '/')) continue;
      if (!best || m.length > best.len) best = { c, len: m.length };
    }
  }
  return best?.c ?? null;
}

async function walk(
  dir: Dir,
  local: string,
  depth: number,
  out: Map<string, Found>,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(local, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(local, e.name);
    if (e.isDirectory()) {
      if (depth < 3 && !SKIP.has(e.name) && !e.name.startsWith('.'))
        await walk(dir, p, depth + 1, out);
      continue;
    }
    if (!e.isFile() || !EXT.has(e.name.slice(e.name.lastIndexOf('.')))) continue;
    if (!(await isSqlite(p))) continue;
    const host = join(dir.host, p.slice(dir.local.length));
    out.set(host, { host, local: p, dir });
  }
}

async function isSqlite(p: string): Promise<boolean> {
  try {
    const buf = await readFile(p, { encoding: null, flag: 'r' }).then((b) => b.subarray(0, 16));
    return buf.equals(HEADER);
  } catch {
    return false;
  }
}

function quote(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Cells the JSON can carry: BLOBs become a size note, bigints numbers or strings. */
export function cell(v: unknown): unknown {
  if (v instanceof Uint8Array) return `<blob ${v.byteLength} B>`;
  if (typeof v === 'bigint') return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  return v;
}

export class NotFound extends Error {}
export class BadQuery extends Error {}
export class NotWritable extends Error {}
export class Timeout extends Error {}
