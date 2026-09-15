---
kanban-plugin: board
updated: 2026-09-12
---

# mk-dashboard

One card per line, ranked top-down inside each column. `#p0`..`#p3` = priority, `[[name]]` = notes/name.md.

## Now

## Next

- [ ] **Audit trail** every action (start/stop/restart, prune, update, snapshot, restore, check run) writes an activity entry with the actor (identity email or via) and the outcome; shown in Activity and per container #p1 #alerts
- [ ] **Databases list search + row filter** search box on the Databases table (like Containers) and a text filter on the Tables tab rows #p3 #sqlite [[plan-sqlite-console]]
- [ ] **Image update awareness** compare each container's image repo digest with a HEAD on the registry manifest (ghcr, docker hub, a self-hosted registry); badge on the container and an info alert when behind #p2
- [ ] **Alert snooze / mute** acknowledge an alert for N hours or mute a title, kept in the data dir; snoozed alerts leave the list and do not notify until they expire #p2 #alerts
- [ ] **Off-box heartbeat** the dashboard pings a receiver every minute and the receiver alerts when the beat stops — the one alert the dashboard cannot send itself (e.g. the box itself hangs or loses its disk); the receiver runs on another machine #p2 #alerts
- [ ] **Stack actions** start / stop / restart a whole compose project from the Stacks page, with the same confirm flow as containers #p2
- [ ] **Client tests** a first set of Angular component tests: alerts list, container actions, the SQL console; run in CI next to the server suite #p2 #tests
- [ ] **Bigger history stores** alert history (500) and docker events (1000) are a few days on a busy box; raise the caps or roll them by age (30 days) #p3

## Later

## Done
- [x] **NAS source (mk-nas)** when DASH_NAS_SOCKET is set, mount /run/mk-nas.sock, call the read-only health verb (newline JSON, see mk-nas shared/types.ts) on the sampler's timer; alerts: pool not ONLINE (danger), pool ≥ 90% (warning), disk SMART failed / reallocated / pending (danger); a Storage card on the overview; nothing changes without the variable #p2 [[nas-source-mk-nas]]
- [x] **Metric history** keep host and container CPU/memory/network samples in a SQLite table in the data dir, downsampled (per minute for a day, per hour for a month); charts get a range picker (1h / 24h / 7d / 30d) instead of the 12-minute in-memory ring #p1 #history [[metric-history]]
- [x] **SQLite explicit list** DASH_SQLITE env var ([{ stack, path, label }]) for database files outside the stacks convention, documented in README and compose #p3 #sqlite [[plan-sqlite-console]]
- [x] **SQLite immutable fallback** open with immutable=1 when the -shm file is unwritable on a read-only mount, and show a "may be slightly behind" note on the detail page #p3 #sqlite [[plan-sqlite-console]]
- [x] **SQLite query timeout** the plan says 5 s but the query and integrity routes have no deadline; the driver is synchronous, so run the statement in a worker thread (or use a progress handler) and abort past the limit #p3 #sqlite [[plan-sqlite-console]]
- [x] **SQLite alerts** through the existing alert pipeline: integrity check failed (scheduled, nightly), WAL larger than N MB for an hour, no snapshot for N hours joining the stale-backup alert [[plan-sqlite-console]] #p3 #sqlite
- [x] **SQLite console — health** integrity_check on demand, page/freelist counts, journal mode, advice card [[plan-sqlite-console]] #p3 #sqlite
- [x] **SQLite console — query + export** one SELECT/EXPLAIN/PRAGMA, 5 s timeout, 1,000-row cap, CSV/JSON export [[plan-sqlite-console]] #p3 #sqlite
- [x] **SQLite console — snapshots + restore** Snapshot now via node:sqlite backup() into the backups dir; restore = stop container, copy over (keep .before-restore), drop -wal/-shm, start; confirm dialog names the steps; activity entry [[plan-sqlite-console]] #p2 #sqlite
- [x] **SQLite console — discovery + browse** find *.db under /stacks (ro mount), attribute to stack + container, Databases list (size, WAL, modified, tables, last snapshot), detail: tables, schema, paged rows; read-only connections opened per request [[plan-sqlite-console]] #p2 #sqlite
