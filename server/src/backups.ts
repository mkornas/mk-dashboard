/**
 * Backup freshness: one subdirectory per app under the backups dir, newest
 * file's age decides "stale". Optional log tail.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from './config.ts';
import type { BackupSet, BackupsInfo } from '../../shared/types.ts';

async function walk(dir: string, depth = 0): Promise<Array<{ name: string; size: number; mtime: number }>> {
  const out: Array<{ name: string; size: number; mtime: number }> = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (depth < 4) out.push(...(await walk(p, depth + 1)));
    } else if (e.isFile()) {
      try {
        const s = await stat(p);
        out.push({ name: e.name, size: s.size, mtime: s.mtimeMs });
      } catch {
        /* vanished */
      }
    }
  }
  return out;
}

export async function readBackups(cfg: Config): Promise<BackupsInfo> {
  const dir = join(cfg.hostRoot, cfg.backupDir);
  const info: BackupsInfo = { dir: cfg.backupDir, available: false, staleAfterHours: cfg.backupStaleHours, sets: [], log: [] };
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return info;
  }
  info.available = true;
  const now = Date.now();
  const logPath = cfg.backupLog ? join(cfg.hostRoot, cfg.backupLog) : join(dir, 'backup.log');
  let lastRuns = new Map<string, number>();
  try {
    const raw = await readFile(logPath, 'utf8');
    const lines = raw.trimEnd().split('\n');
    info.log = lines.slice(-60);
    lastRuns = parseLastRuns(lines);
  } catch {
    /* no log */
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const files = await walk(join(dir, e.name));
    const latest = files.sort((a, b) => b.mtime - a.mtime)[0];
    const lastRun = lastRuns.get(e.name);
    // mirrors (rsync -a) keep the source mtimes, so the log line is the better clock when there is one
    const freshest = Math.max(latest?.mtime ?? 0, lastRun ?? 0);
    const ageHours = freshest ? (now - freshest) / 3_600_000 : undefined;
    const set: BackupSet = {
      name: e.name,
      path: join(cfg.backupDir, e.name),
      files: files.length,
      totalSize: files.reduce((a, f) => a + f.size, 0),
      latest,
      lastRun,
      ageHours,
      stale: files.length > 0 && ageHours !== undefined && ageHours > cfg.backupStaleHours,
    };
    info.sets.push(set);
  }
  info.sets.sort((a, b) => a.name.localeCompare(b.name));
  return info;
}

/** `2026-09-08T18:30:01+02:00 wiki: 1.2M` → wiki ran at that time. Newest line per name wins. */
export function parseLastRuns(lines: string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of lines) {
    const m = /^(\d{4}-\d{2}-\d{2}[T ][\d:.+\-Z]+)\s+([\w.-]+):/.exec(line);
    if (!m) continue;
    const t = Date.parse(m[1]);
    if (!Number.isFinite(t)) continue;
    if ((out.get(m[2]) ?? 0) < t) out.set(m[2], t);
  }
  return out;
}
