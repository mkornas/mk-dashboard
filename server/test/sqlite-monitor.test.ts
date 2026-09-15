import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../src/config.ts';
import { SqliteConsole } from '../src/sqlite.ts';
import { SqliteMonitor } from '../src/sqlite-monitor.ts';

let base: string;
let sqlite: SqliteConsole;
let monitor: SqliteMonitor;
const HOUR = 3_600_000;
/** Noon on a fixed day, local time; the integrity hour is 4, so the next run is due the following morning. */
const T0 = new Date(2026, 0, 1, 12).getTime();
const GOOD = '/srv/stacks/wiki/data/wiki.db';
const BAD = '/srv/stacks/other/big.db';

before(async () => {
  base = await mkdtemp(join(tmpdir(), 'mk-dash-sqlite-mon-'));
  await mkdir(join(base, 'stacks', 'wiki', 'data'), { recursive: true });
  await mkdir(join(base, 'stacks', 'other'), { recursive: true });
  let db = new DatabaseSync(join(base, 'stacks', 'wiki', 'data', 'wiki.db'));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec("CREATE TABLE tasks (id INTEGER PRIMARY KEY, title TEXT); INSERT INTO tasks (title) VALUES ('milk')");
  db.close();
  db = new DatabaseSync(join(base, 'stacks', 'other', 'big.db'));
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, body TEXT)');
  const ins = db.prepare('INSERT INTO t (body) VALUES (?)');
  for (let i = 0; i < 400; i++) ins.run('x'.repeat(100));
  db.close();
  const cfg = {
    ...config,
    hostRoot: '/',
    dataDir: join(base, 'data'),
    sqliteDirs: `/srv/stacks:${join(base, 'stacks')}`,
    sqliteSnapshotDir: join(base, 'snapshots'),
    sqliteWalMb: 1,
    sqliteSnapshotStaleHours: 24,
    sqliteIntegrityHour: 4,
  };
  sqlite = new SqliteConsole(cfg, null);
  monitor = new SqliteMonitor(cfg, sqlite, T0);
});
after(async () => {
  await rm(base, { recursive: true, force: true });
});

test('nothing to say about healthy, small, unsnapshotted databases', async () => {
  await monitor.refresh(T0);
  assert.deepEqual(monitor.alerts(T0), []);
});

test('WAL above the limit is an alert only after an hour, and clears when it shrinks', async () => {
  const wal = join(base, 'stacks', 'other', 'big.db-wal');
  await writeFile(wal, Buffer.alloc(2 * 1024 * 1024));
  await monitor.refresh(T0);
  assert.deepEqual(monitor.alerts(T0 + 30 * 60_000), [], 'not yet');
  const [a] = monitor.alerts(T0 + 61 * 60_000);
  assert.equal(a.title, 'WAL of other/big.db is not checkpointing');
  assert.equal(a.level, 'warning');
  assert.match(a.detail ?? '', /^2 MB for 1h 1m \(limit 1 MB\)$/);
  assert.equal(a.since, T0);
  await rm(wal);
  await monitor.refresh(T0 + 2 * HOUR);
  assert.deepEqual(monitor.alerts(T0 + 3 * HOUR), []);
});

test('the integrity check runs once the configured hour has passed and flags a corrupt file', async () => {
  const fh = await open(join(base, 'stacks', 'other', 'big.db'), 'r+');
  await fh.write(Buffer.alloc(512, 0xff), 0, 512, 4096 * 2 + 8);
  await fh.close();
  await monitor.refresh(T0 + HOUR); // 13:00 the same day: not due
  assert.deepEqual(monitor.alerts(T0 + HOUR), []);
  await monitor.refresh(T0 + 24 * HOUR); // noon the next day: 04:00 has passed
  const alerts = monitor.alerts(T0 + 24 * HOUR).filter((a) => a.level === 'danger');
  assert.equal(alerts.length, 1, JSON.stringify(monitor.alerts(T0 + 24 * HOUR)));
  assert.equal(alerts[0].title, 'other/big.db failed its integrity check');
  assert.ok(alerts[0].detail, 'names the first problem');
  assert.equal(alerts[0].since, T0 + 24 * HOUR);
  await monitor.refresh(T0 + 25 * HOUR); // not due again until tomorrow: the result stays
  assert.equal(monitor.alerts(T0 + 25 * HOUR).filter((a) => a.level === 'danger').length, 1);
});

test('a snapshot older than the limit is stale; a database never snapshotted is not', async () => {
  // real clock from here on: the snapshot's age comes from the file's mtime
  await sqlite.snapshot(GOOD);
  const t = Date.now();
  await monitor.refresh(t);
  assert.deepEqual(monitor.alerts(t + 23 * HOUR).filter((a) => a.level === 'warning'), []);
  const alerts = monitor.alerts(t + 25 * HOUR).filter((a) => a.level === 'warning');
  assert.deepEqual(
    alerts.map((a) => [a.level, a.title, a.detail]),
    [['warning', 'Snapshot of wiki/wiki.db is stale', 'Newest snapshot is 25 h old (limit 24 h)']],
  );
});
