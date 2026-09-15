import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, copyFile, mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync, spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import Fastify, { type FastifyInstance } from 'fastify';
import { config } from '../src/config.ts';
import { SqliteConsole, Timeout, ownerOf } from '../src/sqlite.ts';
import { registerSqliteRoutes } from '../src/sqlite-routes.ts';
import type {
  Identity,
  SqliteDb,
  SqliteDbDetail,
  SqliteHealth,
  SqliteQueryResult,
  SqliteRows,
  SqliteSnapshot,
} from '../../shared/types.ts';

let base: string;
let app: FastifyInstance;
let sqlite: SqliteConsole;
let canAct = true;
const HOST = '/srv/stacks/wiki/data/wiki.db';

before(async () => {
  base = await mkdtemp(join(tmpdir(), 'mk-dash-sqlite-'));
  await mkdir(join(base, 'stacks', 'wiki', 'data'), { recursive: true });
  await mkdir(join(base, 'stacks', 'other', 'node_modules'), {
    recursive: true,
  });
  const db = new DatabaseSync(join(base, 'stacks', 'wiki', 'data', 'wiki.db'));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(
    'CREATE TABLE tasks (id INTEGER PRIMARY KEY, title TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, blob BLOB)',
  );
  db.exec(
    "INSERT INTO tasks (title, done, blob) VALUES ('milk', 0, x'0102'), ('eggs', 1, NULL), ('\"quoted\", with comma', 0, NULL)",
  );
  db.exec('CREATE VIEW open_tasks AS SELECT id, title FROM tasks WHERE done = 0');
  db.close();
  await writeFile(join(base, 'stacks', 'other', 'notes.db'), 'this is not sqlite at all');
  await writeFile(join(base, 'stacks', 'other', 'node_modules', 'x.db'), 'skipped anyway');
  await mkdir(join(base, 'elsewhere'));
  new DatabaseSync(join(base, 'elsewhere', 'app.db')).exec('CREATE TABLE k (v)');
  const cfg = {
    ...config,
    readonly: false,
    hostRoot: '/',
    dataDir: join(base, 'data'),
    sqliteDirs: `/srv/stacks:${join(base, 'stacks')}`,
    sqlite: [
      { path: join(base, 'elsewhere', 'app.db'), stack: 'elsewhere', label: 'App' },
      { path: '/nowhere/x.db' },
    ],
    sqliteSnapshotDir: join(base, 'snapshots'),
  };
  app = Fastify({ logger: false });
  app.decorateRequest('identity', undefined as unknown as Identity);
  app.addHook('onRequest', async (req) => {
    (req as { identity?: unknown }).identity = {
      email: 'admin@example.com',
      via: 'lan',
      canAct,
    };
  });
  sqlite = new SqliteConsole(cfg, null);
  registerSqliteRoutes(app, cfg, sqlite);
});
after(async () => {
  await app.close();
  await rm(base, { recursive: true, force: true });
});

test('discovery: real SQLite files only, attributed to a stack, with WAL size; DASH_SQLITE adds files elsewhere', async () => {
  const list = (await app.inject({ url: '/api/sqlite' })).json() as SqliteDb[];
  assert.deepEqual(
    list.map((d) => [d.path, d.stack, d.name, d.writable]),
    [
      [join(base, 'elsewhere', 'app.db'), 'elsewhere', 'App', true],
      [HOST, 'wiki', 'wiki.db', true],
    ],
    'a missing DASH_SQLITE path is left out',
  );
  assert.ok(list[1].size > 0);
  assert.equal(list[1].container, null, 'no docker in tests');
  assert.equal(
    (
      await app.inject({
        url: '/api/sqlite/db?path=/srv/stacks/other/notes.db',
      })
    ).statusCode,
    404,
    'not a database',
  );
  assert.equal(
    (await app.inject({ url: '/api/sqlite/db?path=/etc/passwd' })).statusCode,
    404,
    'only discovered paths open',
  );
});

test('detail: tables, views, columns, counts and pragmas', async () => {
  const d = (
    await app.inject({ url: `/api/sqlite/db?path=${encodeURIComponent(HOST)}` })
  ).json() as SqliteDbDetail;
  assert.deepEqual(
    d.tables.map((t) => [t.name, t.kind, t.rows]),
    [
      ['tasks', 'table', 3],
      ['open_tasks', 'view', null],
    ],
  );
  assert.deepEqual(
    d.tables[0].columns.map((c) => `${c.name}:${c.type}${c.pk ? ':pk' : ''}`),
    ['id:INTEGER:pk', 'title:TEXT', 'done:INTEGER', 'blob:BLOB'],
  );
  assert.equal(d.journalMode, 'wal');
  assert.ok(d.pageCount > 0 && d.pageSize > 0);
  assert.deepEqual(d.snapshots, []);
});

test('rows: paged, sortable, blobs summarised; unknown tables are 404', async () => {
  const r = (
    await app.inject({
      url: `/api/sqlite/rows?path=${encodeURIComponent(HOST)}&table=tasks&limit=2&sort=title&dir=desc`,
    })
  ).json() as SqliteRows;
  assert.deepEqual(r.columns, ['id', 'title', 'done', 'blob']);
  assert.equal(r.total, 3);
  assert.deepEqual(
    r.rows.map((row) => row[1]),
    ['milk', 'eggs'],
  );
  assert.equal(r.rows[0][3], '<blob 2 B>');
  const next = (
    await app.inject({
      url: `/api/sqlite/rows?path=${encodeURIComponent(HOST)}&table=tasks&limit=2&offset=2&sort=title&dir=desc`,
    })
  ).json() as SqliteRows;
  assert.deepEqual(
    next.rows.map((row) => row[1]),
    ['"quoted", with comma'],
  );
  assert.equal(
    (
      await app.inject({
        url: `/api/sqlite/rows?path=${encodeURIComponent(HOST)}&table=nope`,
      })
    ).statusCode,
    404,
  );
});

test('query: read-only statements only, capped, timed', async () => {
  const post = (sql: string) =>
    app.inject({
      method: 'POST',
      url: '/api/sqlite/query',
      payload: { path: HOST, sql },
    });
  const ok = (
    await post('SELECT title FROM tasks WHERE done = 0 ORDER BY id')
  ).json() as SqliteQueryResult;
  assert.deepEqual(
    ok.rows.map((r) => r[0]),
    ['milk', '"quoted", with comma'],
  );
  assert.equal(ok.truncated, false);
  assert.ok(ok.ms >= 0);
  assert.equal((await post('PRAGMA table_info(tasks)')).statusCode, 200);
  for (const bad of [
    'DELETE FROM tasks',
    'UPDATE tasks SET done = 1',
    'SELECT 1; DROP TABLE tasks',
    'PRAGMA journal_mode = DELETE',
    'PRAGMA user_version = 9',
    'SELECT * FROM nope',
    '',
  ]) {
    const res = await post(bad);
    assert.equal(res.statusCode, 400, bad);
  }
  assert.equal(
    (
      await app.inject({
        url: `/api/sqlite/rows?path=${encodeURIComponent(HOST)}&table=tasks`,
      })
    ).json().total,
    3,
    'nothing was written',
  );
});

test('query: a statement that never finishes is given up on, and its process killed', async () => {
  const slow = new SqliteConsole({ ...config, hostRoot: '/', dataDir: join(base, 'data'), sqliteDirs: `/srv/stacks:${join(base, 'stacks')}`, sqliteSnapshotDir: join(base, 'snapshots'), sqliteQueryMs: 300 }, null);
  const started = Date.now();
  await assert.rejects(
    slow.query(HOST, 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c'),
    (e: unknown) => e instanceof Timeout && /gave up after 0 s/.test((e as Error).message),
  );
  assert.ok(Date.now() - started < 2000, 'the deadline, not the query, ended it');
  await new Promise((r) => setTimeout(r, 200));
  const children = execSync(`pgrep -f 'sqlite-worker[.]ts' -P ${process.pid} || true`).toString().trim();
  assert.equal(children, '', 'no worker left running');
});

test('immutable fallback: a WAL database whose -shm cannot be used is read without the WAL, and says so', async () => {
  // a writer in another process keeps -wal and -shm alive; a copy without the -shm in a directory nobody can write to is what a read-only mount looks like
  const dir = join(base, 'stacks', 'locked');
  await mkdir(dir, { recursive: true });
  const writer = spawn(process.execPath, ['-e', `const {DatabaseSync}=require('node:sqlite'); const w=new DatabaseSync(${JSON.stringify(join(dir, 'live.db'))}); w.exec("PRAGMA journal_mode=WAL; CREATE TABLE a(x); INSERT INTO a VALUES (1)"); w.exec("PRAGMA wal_checkpoint(TRUNCATE)"); w.exec("INSERT INTO a VALUES (2)"); console.log('ready'); setTimeout(()=>{}, 20000)`], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise<void>((r) => writer.stdout.once('data', () => r()));
  try {
    await mkdir(join(base, 'stacks', 'ro'));
    for (const f of ['live.db', 'live.db-wal']) await copyFile(join(dir, f), join(base, 'stacks', 'ro', f));
    await chmod(join(base, 'stacks', 'ro'), 0o555);
    Reflect.set(sqlite, 'foundAt', 0); // discovery is cached for 30 s; the files are new
    const path = '/srv/stacks/ro/live.db';
    const detail = (await app.inject({ url: `/api/sqlite/db?path=${encodeURIComponent(path)}` })).json() as SqliteDbDetail;
    assert.equal(detail.immutable, true);
    assert.equal(detail.tables[0]?.rows, 1, 'the checkpointed row, not the one still in the WAL');
    const q = (await app.inject({ method: 'POST', url: '/api/sqlite/query', payload: { path, sql: 'SELECT count(*) AS n FROM a' } })).json() as SqliteQueryResult;
    assert.deepEqual(q.rows, [[1]], 'the worker falls back the same way');
    const live = (await app.inject({ url: `/api/sqlite/db?path=${encodeURIComponent('/srv/stacks/locked/live.db')}` })).json() as SqliteDbDetail;
    assert.equal(live.immutable, false, 'a usable -shm is read normally');
    assert.equal(live.tables[0]?.rows, 2);
  } finally {
    writer.kill();
    await chmod(join(base, 'stacks', 'ro'), 0o755).catch(() => {});
    for (const d of ['ro', 'locked']) await rm(join(base, 'stacks', d), { recursive: true, force: true });
    Reflect.set(sqlite, 'foundAt', 0);
  }
});

test('export: csv with quoting, json objects', async () => {
  const csv = await app.inject({
    url: `/api/sqlite/export?path=${encodeURIComponent(HOST)}&table=tasks&format=csv`,
  });
  assert.match(String(csv.headers['content-disposition']), /tasks\.csv/);
  assert.equal(csv.body.split('\n')[0], 'id,title,done,blob');
  assert.ok(csv.body.includes('"""quoted"", with comma"'));
  const json = (
    await app.inject({
      url: `/api/sqlite/export?path=${encodeURIComponent(HOST)}&table=open_tasks&format=json`,
    })
  ).json() as { title: string }[];
  assert.deepEqual(
    json.map((r) => r.title),
    ['milk', '"quoted", with comma'],
  );
});

test('health: integrity_check', async () => {
  const h = (
    await app.inject({
      url: `/api/sqlite/health?path=${encodeURIComponent(HOST)}`,
    })
  ).json() as SqliteHealth;
  assert.equal(h.ok, true);
  assert.deepEqual(h.integrity, ['ok']);
});

test('snapshot and restore: a consistent copy, then the file put back with the old one kept', async () => {
  canAct = false;
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/sqlite/snapshot',
        payload: { path: HOST },
      })
    ).statusCode,
    403,
  );
  canAct = true;
  const snap = (
    await app.inject({
      method: 'POST',
      url: '/api/sqlite/snapshot',
      payload: { path: HOST },
    })
  ).json() as SqliteSnapshot;
  assert.match(snap.file, /^wiki\..*\.db$/);
  assert.ok(snap.size > 0);
  const listed = (await app.inject({ url: '/api/sqlite' })).json() as SqliteDb[];
  assert.equal(listed.find((d) => d.path === HOST)?.lastSnapshot?.file, snap.file);
  // change the live database, then restore the snapshot
  const live = join(base, 'stacks', 'wiki', 'data', 'wiki.db');
  const db = new DatabaseSync(live);
  db.exec("INSERT INTO tasks (title) VALUES ('added after the snapshot')");
  db.close();
  assert.equal(
    (
      await app.inject({
        url: `/api/sqlite/rows?path=${encodeURIComponent(HOST)}&table=tasks`,
      })
    ).json().total,
    4,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/sqlite/restore',
        payload: { path: HOST, file: '../etc/passwd' },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/sqlite/restore',
        payload: { path: HOST, file: 'wiki.nope.db' },
      })
    ).statusCode,
    404,
  );
  const res = await app.inject({
    method: 'POST',
    url: '/api/sqlite/restore',
    payload: { path: HOST, file: snap.file },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.match(res.json().message, /before-restore/);
  assert.equal(
    (
      await app.inject({
        url: `/api/sqlite/rows?path=${encodeURIComponent(HOST)}&table=tasks`,
      })
    ).json().total,
    3,
    'back to the snapshot',
  );
  const kept = new DatabaseSync(live + '.before-restore', { readOnly: true });
  assert.equal(
    (kept.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n,
    4,
    'the replaced file is kept',
  );
  kept.close();
  assert.ok(
    (await readFile(live)).subarray(0, 16).toString('latin1').startsWith('SQLite format 3'),
  );
});

test('ownerOf: the most specific mount wins and a whole-root mount never does', () => {
  const dash = { name: 'mk-dashboard', mounts: ['/', '/proc', '/srv/stacks/mk-dashboard/data'] };
  const drive = { name: 'mk-drive', mounts: ['/srv/stacks/mk-drive/data', '/mnt/nas/drive'] };
  const sync = { name: 'notes-sync', mounts: ['/srv/stacks/notes'] };
  assert.equal(
    ownerOf('/srv/stacks/mk-drive/data/mk-drive.db', [dash, drive, sync])?.name,
    'mk-drive',
  );
  assert.equal(
    ownerOf('/srv/stacks/notes/boards/x.db', [dash, drive, sync])?.name,
    'notes-sync',
  );
  assert.equal(
    ownerOf('/srv/stacks/other/data/other.db', [dash, drive, sync]),
    null,
    'nothing but the root mount matches',
  );
  assert.equal(
    ownerOf('/srv/stacks/mk-drive/data-old/x.db', [drive]),
    null,
    'a sibling with the same prefix is not inside',
  );
});
