/**
 * Runtime configuration, all from the environment. Every path has a sensible
 * default for running on the host itself; the Docker image overrides the host
 * paths to the read-only mounts (see docker-compose.yml).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { CheckConfig } from '../../shared/types.ts';

const here = dirname(fileURLToPath(import.meta.url));

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function envInt(name: string, fallback: number): number {
  const n = Number.parseInt(env(name, ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function envBool(name: string, fallback = false): boolean {
  const v = env(name, '').toLowerCase();
  if (v === '') return fallback;
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function readVersion(): string {
  try {
    return JSON.parse(readFileSync(resolve(here, '../package.json'), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const config = {
  app: 'mk-dashboard',
  version: readVersion(),
  build: env('BUILD_SHA', env('DASH_BUILD', 'dev')),
  port: envInt('PORT', 8800),
  host: env('HOST', '0.0.0.0'),

  /** Where the built Angular app lives (served as the SPA). Empty = API only. */
  staticDir: env('DASH_STATIC_DIR', resolve(here, '../../client/dist/client/browser')),

  dockerSocket: env('DOCKER_SOCKET', '/var/run/docker.sock'),
  dockerApiVersion: env('DOCKER_API_VERSION', 'v1.44'),

  /** Host filesystem views. On the host itself these are just /proc, /sys, /. */
  hostProc: env('HOST_PROC', '/proc'),
  hostSys: env('HOST_SYS', '/sys'),
  hostRoot: env('HOST_ROOT', '/'),
  /** Hostname override (inside a container os.hostname() is the container id). */
  hostName: env('DASH_HOSTNAME', ''),
  /** The suite's app registry (JSON) behind the header's app switcher; empty = no switcher. */
  appsUrl: parseAppsUrl(env('DASH_APPS_URL', '')),
  /** NAS mode: the mk-nas agent's socket mounted in; its health becomes alerts and a page. Empty = off. */
  nasSocket: env('DASH_NAS_SOCKET', ''),
  /** NAS mode for a NAS on another box: the mk-drive there (its monitor route) and the token it was given. Wins over the socket. */
  nasUrl: env('DASH_NAS_URL', ''),
  nasToken: env('DASH_NAS_TOKEN', ''),

  /** Backups directory as seen through hostRoot (e.g. /srv/backups). */
  backupDir: env('DASH_BACKUP_DIR', '/srv/backups'),
  backupLog: env('DASH_BACKUP_LOG', ''),
  backupStaleHours: envInt('DASH_BACKUP_STALE_HOURS', 12),

  /** Where SQLite files are looked for: `host path[:path as seen by the dashboard]`, comma-separated. The default reads /srv/stacks through the host-root mount (read-only, so no restore); mount it read-write and name that mount for restores. */
  sqliteDirs: env('DASH_SQLITE_DIRS', '/srv/stacks'),
  /** SQLite files outside the stacks convention: JSON `[{ "path", "stack"?, "label"? }]`, host paths. */
  sqlite: parseSqliteList(env('DASH_SQLITE', '')),
  /** Where snapshots are written; defaults to the data dir. */
  sqliteSnapshotDir: env('DASH_SQLITE_SNAPSHOTS', ''),
  /** A console query is given up on after this long; the integrity check (on demand and nightly) after `sqliteIntegrityMs`. */
  sqliteQueryMs: envInt('DASH_SQLITE_QUERY_MS', 5_000),
  sqliteIntegrityMs: envInt('DASH_SQLITE_INTEGRITY_MS', 120_000),
  /** SQLite alerts: a WAL above this size for an hour means checkpoints are stuck. */
  sqliteWalMb: envInt('DASH_SQLITE_WAL_MB', 64),
  /** A database whose newest snapshot is older than this counts as stale; 0 = never. */
  sqliteSnapshotStaleHours: envInt('DASH_SQLITE_SNAPSHOT_STALE_HOURS', 0),
  /** Local hour (0–23) of the nightly integrity check; `off` disables it. */
  sqliteIntegrityHour: parseHour(env('DASH_SQLITE_INTEGRITY_HOUR', '4')),

  /** Watchtower HTTP API for "update now"; empty disables the action. */
  watchtowerUrl: env('WATCHTOWER_URL', ''),
  watchtowerToken: env('WATCHTOWER_TOKEN', ''),

  /** Disable every mutating action. */
  readonly: envBool('DASH_READONLY', false),

  /** Optional HTTP basic auth. Both must be set to enable. */
  user: env('DASH_USER', ''),
  password: env('DASH_PASSWORD', ''),

  sampleMs: envInt('DASH_SAMPLE_MS', 3000),
  historyPoints: envInt('DASH_HISTORY_POINTS', 240),
  /** How long the stored per-hour history goes back (per-minute history keeps two days). */
  historyDays: envInt('DASH_HISTORY_DAYS', 30),

  /** Fallback links per stack/container name when labels are not used: JSON object. */
  links: parseLinks(env('DASH_LINKS', '')),

  /** Container names never shown (comma-separated). */
  hide: env('DASH_HIDE', '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  /** Where events / alert history persist (JSONL). Empty = memory only. */
  dataDir: env('DASH_DATA_DIR', ''),

  /** Reachability checks: JSON array in DASH_CHECKS or a JSON file. */
  checks: parseChecks(env('DASH_CHECKS', ''), env('DASH_CHECKS_FILE', '')),
  /** Also probe every container's mk-dashboard.url label. */
  autoChecks: envBool('DASH_AUTO_CHECKS', true),
  checkIntervalMs: envInt('DASH_CHECK_INTERVAL_MS', 60_000),
  checkTimeoutMs: envInt('DASH_CHECK_TIMEOUT_MS', 8_000),
  /** Warn when a certificate expires within this many days. */
  certWarnDays: envInt('DASH_CERT_WARN_DAYS', 14),

  /** Notifications: an alert must persist this long before it is sent. */
  notifyAfterMs: envInt('DASH_NOTIFY_AFTER_MS', 60_000),
  notifyMinLevel: (env('DASH_NOTIFY_MIN_LEVEL', 'warning') as 'info' | 'warning' | 'danger'),
  telegramToken: env('DASH_TELEGRAM_BOT_TOKEN', ''),
  telegramChatId: env('DASH_TELEGRAM_CHAT_ID', ''),
  webhookUrl: env('DASH_WEBHOOK_URL', ''),

  /** Cloudflare Access: team name (or full <team>.cloudflareaccess.com) and the application audience tag. */
  accessTeam: env('DASH_ACCESS_TEAM', ''),
  accessAud: env('DASH_ACCESS_AUD', ''),
  /** Emails allowed to run actions; empty = every signed-in user. */
  adminEmails: env('DASH_ADMIN_EMAILS', '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  /** Single sign-on through an OpenID Connect provider (Pocket ID, Authelia, …); all three enable it. */
  oidcIssuer: env('DASH_OIDC_ISSUER', ''),
  oidcClientId: env('DASH_OIDC_CLIENT_ID', ''),
  oidcClientSecret: env('DASH_OIDC_CLIENT_SECRET', ''),
  /** What the provider is called in the UI. */
  oidcName: env('DASH_OIDC_NAME', 'Single sign-on'),
  /** Emails the provider may sign in with; empty = DASH_ADMIN_EMAILS. Nobody else gets in. */
  oidcEmails: env('DASH_OIDC_EMAILS', '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  /** Signs the sign-in cookies; generated once into DASH_DATA_DIR when unset. */
  cookieSecret: env('DASH_COOKIE_SECRET', ''),
  /** How long a single sign-on session lasts. */
  sessionDays: envInt('DASH_SESSION_DAYS', 30),
  /** Networks that may use the dashboard without an Access token (and whose proxies' X-Forwarded-For is believed). */
  trustedCidrs: env('DASH_TRUSTED_CIDRS', '127.0.0.0/8,::1/128,10.0.0.0/8,192.168.0.0/16')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  /** Web push (VAPID). Generated into the data dir when unset. */
  vapidPublic: env('DASH_VAPID_PUBLIC', ''),
  vapidPrivate: env('DASH_VAPID_PRIVATE', ''),
  vapidSubject: env('DASH_VAPID_SUBJECT', 'mailto:admin@localhost'),

  /** Mount points to ignore for disk usage (comma-separated prefixes). */
  ignoreMounts: env('DASH_IGNORE_MOUNTS', '/boot/efi,/snap')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
};

export interface SqliteEntry {
  path: string;
  stack?: string;
  label?: string;
}

function parseSqliteList(raw: string): SqliteEntry[] {
  if (!raw.trim()) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) throw new Error('not an array');
    return arr
      .filter((e) => e && typeof e.path === 'string' && e.path.startsWith('/'))
      .map((e) => ({
        path: e.path,
        stack: typeof e.stack === 'string' && e.stack ? e.stack : undefined,
        label: typeof e.label === 'string' && e.label ? e.label : undefined,
      }));
  } catch (e) {
    console.warn(`DASH_SQLITE is not valid JSON: ${(e as Error).message}`);
    return [];
  }
}

/** An absolute http(s) URL, so its origin can be allowed in the app's CSP. */
function parseAppsUrl(raw: string): string {
  if (!raw) return '';
  try {
    const u = new URL(raw);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.href;
  } catch {
    // reported below
  }
  console.warn(`DASH_APPS_URL ${raw} is not an http(s) URL; ignoring`);
  return '';
}

function parseHour(raw: string): number | null {
  if (raw.toLowerCase() === 'off') return null;
  const n = Number.parseInt(raw, 10);
  if (Number.isInteger(n) && n >= 0 && n <= 23) return n;
  console.warn(`DASH_SQLITE_INTEGRITY_HOUR ${raw} is not an hour (0–23) or off; using 4`);
  return 4;
}

function parseLinks(raw: string): Record<string, string> {
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw);
    return typeof obj === 'object' && obj ? obj : {};
  } catch {
    console.warn('DASH_LINKS is not valid JSON; ignoring');
    return {};
  }
}

function parseChecks(raw: string, file: string): CheckConfig[] {
  let text = raw;
  if (!text && file) {
    try {
      text = readFileSync(file, 'utf8');
    } catch (e) {
      console.warn(`DASH_CHECKS_FILE ${file}: ${(e as Error).message}`);
      return [];
    }
  }
  if (!text.trim()) return [];
  try {
    const arr = JSON.parse(text);
    if (!Array.isArray(arr)) throw new Error('not an array');
    return arr.filter((c) => c && typeof c.name === 'string' && (c.url || c.host));
  } catch (e) {
    console.warn(`checks config is not valid JSON: ${(e as Error).message}`);
    return [];
  }
}

export type Config = typeof config;
