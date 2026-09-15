# Plan: the SQLite console — every app's database, in one place

Written 2026-09-11. The dashboard already knows every stack on the box, the
backups directory and the docker socket. Most stacks keep their state in one
SQLite file. This adds a **Databases** page: find them, look inside, snapshot
and restore, and alert when something is off. Read-only by default; the two
writes (snapshot, restore) go through explicit confirmation like every other
disruptive action here.

## Why

Many self-hosted apps (mk-drive among them) embed SQLite. The
questions are always the same and today need `docker exec … node -e`: what is
in this table, how big is it, is the WAL checkpointing, when was it last
backed up, can I roll back to yesterday. The idea of a "SQLite service" that
apps would talk to was considered and dropped (see the mk-kit plan); the
operations console is the part worth having.

## Discovery

- Mount the stacks' data read-only: `/srv/stacks:/stacks:ro`
  (`DASH_SQLITE_DIRS`, comma-separated; default `/stacks`). Walk two levels
  for `*.db`, `*.sqlite`, `*.sqlite3`, confirm by the 16-byte header.
- Attribute each file to a stack by path (`/stacks/<stack>/…`), then to the
  container whose mounts include that host path (docker inspect), so the page
  can link the container and stop/start it for a restore.
- Optional explicit list `DASH_SQLITE` (`[{ "stack", "path", "label" }]`) for
  files outside the convention.

## Pages

**Databases** (list): file, stack, container, size, WAL size and age of the
last checkpoint, modified, tables, last snapshot (from the backups dir),
integrity status (last run). Sortable, searchable, like Containers.

**Database** (detail):
- *Tables*: name, row count, size estimate; click → schema (`CREATE …`) and
  rows, paged, sortable, with a filter; blobs shown as size; JSON columns
  pretty-printed.
- *Query*: one statement, `SELECT`/`EXPLAIN`/`PRAGMA` only (parsed, not
  trusted), 5 s timeout, 1,000-row cap, export the result as CSV or JSON.
- *Snapshots*: "Snapshot now" → `node:sqlite`'s `backup()` into
  `<backup dir>/<stack>/<file>.<ISO time>.db` (the only write outside the
  confirm flow); list of existing snapshots with size and age; *Restore* =
  stop the container, copy the snapshot over the file (keep the old one as
  `.before-restore`), remove `-wal`/`-shm`, start the container — confirm
  dialog names all three steps.
- *Health*: `PRAGMA integrity_check` (on demand, timed), `page_count`,
  `freelist_count`, journal mode, user_version, `VACUUM` advice.

## Alerts (the existing pipeline)

- integrity check failed; WAL larger than N MB for longer than an hour
  (checkpoint stuck); a database that stopped changing while its container
  runs (optional); no snapshot for N hours joins the existing stale-backup
  alert.

## How it opens files safely

- `new DatabaseSync(path, { readOnly: true })` for every read; WAL readers
  need the `-shm`, so the mount must be readable by the dashboard's uid
  (it is: same uid as the stacks). `immutable=1` fallback when `-shm` is
  unwritable, with a "may be slightly behind" note.
- Never hold a connection open across requests: open, run, close.
- Row editing is out of scope for the first version; if it comes, it is
  `DASH_SQLITE_WRITE=true`, per-row, with the statement shown before it runs.

## Phases

1. **Discovery + list + tables/schema/rows**, read-only. 1–2 days.
2. **Snapshots + restore** through the container stop/start, with the confirm
   flow and an activity entry. 1 day.
3. **Query + export**. ½ day.
4. **Health + alerts**. ½ day.
5. **Row edit** behind the env flag — only if it is missed.

## Not planned

Multi-tenant databases, an HTTP API for other apps to read these files,
schema migration tooling. The app owns its schema; the console looks in.

- 2026-09-12 06:28 — Shipped: server/src/sqlite.ts + sqlite-routes.ts, pages databases.ts + database-detail.ts. Discovery walks DASH_SQLITE_DIRS (default /srv/stacks via the host-root mount) three levels deep, header-checked; owner container matched on mount source paths from /containers/json; list shows size, WAL, changed, last snapshot, writability. Detail: tables + views with counts/columns/schema, paged sortable rows (blobs summarised), pragmas. Read-only connection per request; only discovered paths open. 7 tests. — main @ 22601a0 Databases: the SQLite console
- 2026-09-12 06:28 — Shipped with the same commit: POST /api/sqlite/snapshot (node:sqlite backup() into DASH_SQLITE_SNAPSHOTS, default <data>/sqlite-snapshots), POST /api/sqlite/restore (stop owner container if running, keep .before-restore, copy, drop -wal/-shm, start; 409 with a DASH_SQLITE_DIRS hint on a read-only mount; snapshot names validated). Confirm dialog lists the steps. Tested end to end without docker. — main @ 22601a0 Databases: the SQLite console
- 2026-09-12 06:28 — Shipped: POST /api/sqlite/query (SELECT/WITH/EXPLAIN/PRAGMA only, single statement, writing PRAGMAs refused, 1,000-row cap, ms), GET /api/sqlite/export (csv with quoting / json objects). Query tab with ⌘↵. — main @ 22601a0 Databases: the SQLite console
- 2026-09-12 06:28 — Shipped: GET /api/sqlite/health (PRAGMA integrity_check, first 20 lines, timed) + the Health tab; pragmas on the facts strip. — main @ 22601a0 Databases: the SQLite console
- 2026-09-12 08:56 — Shipped server/src/sqlite-monitor.ts + sampler wiring: WAL > DASH_SQLITE_WAL_MB for an hour, snapshot older than DASH_SQLITE_SNAPSHOT_STALE_HOURS (default off), nightly integrity check at DASH_SQLITE_INTEGRITY_HOUR (4, off disables) → danger. Documented in README + compose. 4 tests, suite 36/36, typecheck clean. Alerts link to /databases (router links can't carry the detail page's query string). Not deployed yet. — main @ df881ce Databases: SQLite alerts through the alert pipeline
- 2026-09-12 09:52 — Shipped server/src/sqlite-worker.ts: one statement per forked process, SIGKILL past DASH_SQLITE_QUERY_MS (5 s) / DASH_SQLITE_INTEGRITY_MS (120 s) → 408. Child process, not a worker thread: node:sqlite has no interrupt and a thread can't be stopped mid native step. Bad statements now 400. Test: an infinite recursive CTE is given up on in 0.3 s and no worker is left. Suite 37/37, typecheck clean. Not pushed/deployed. — main @ 8a3c2a2 Databases: queries and the integrity check run in a killable process with a deadline
- 2026-09-12 12:26 — Shipped openReadOnly() in server/src/sqlite.ts: probe the first statement, on SQLITE_CANTOPEN (errcode 14) reopen file:…?immutable=1; used by the console, the query worker and snapshots. SqliteDbDetail.immutable + a warning mk-alert on the detail page. Verified the failure mode empirically: unreadable or missing -shm in a read-only dir fails on the first statement, not on open. Test with a writer in another process. Suite 38/38, both typechecks + client build clean. Not deployed. — main @ 9997039 Databases: read a WAL database without its WAL when the -shm cannot be used
- 2026-09-12 12:43 — Shipped: config.sqlite (DASH_SQLITE JSON [{ path, stack?, label? }]), merged into SqliteConsole.discover() with header check; local path via a DASH_SQLITE_DIRS mapping or hostRoot; stack/label override. Missing path warned once. README + compose + empty-state text. Suite 38/38, typecheck clean. Not deployed. — main @ 083e4f3 Databases: DASH_SQLITE names database files outside the stacks directories
