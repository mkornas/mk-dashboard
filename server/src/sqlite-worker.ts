/**
 * Runs one read-only SQLite statement in a process of its own, so the API can
 * give up on it: the driver is synchronous and has no interrupt, and a slow
 * query or a long integrity check would otherwise hold the whole server. A
 * thread would not do — it cannot be stopped inside one long native step —
 * but a process can be killed. Forked by `SqliteConsole` with the job as the
 * first argument; sends one IPC message and exits.
 */
import type { DatabaseSync } from 'node:sqlite';
import { cell, openReadOnly } from './sqlite.ts';

export interface SqliteJob {
  path: string;
  sql: string;
  rowCap: number;
}

export interface SqliteJobResult {
  columns: string[];
  rows: unknown[][];
  truncated: boolean;
}

const job = JSON.parse(process.argv[2] ?? '{}') as SqliteJob;
const send = (m: { result?: SqliteJobResult; error?: string }) => process.send?.(m);
let db: DatabaseSync | null = null;
try {
  db = openReadOnly(job.path).db;
  const stmt = db.prepare(job.sql);
  const columns = stmt.columns().map((c) => c.name);
  const rows: unknown[][] = [];
  let truncated = false;
  for (const r of stmt.iterate() as Iterable<Record<string, unknown>>) {
    if (rows.length >= job.rowCap) {
      truncated = true;
      break;
    }
    rows.push(columns.map((c) => cell(r[c])));
  }
  send({ result: { columns, rows, truncated } });
} catch (e) {
  send({ error: (e as Error).message });
} finally {
  db?.close();
  process.disconnect();
}
