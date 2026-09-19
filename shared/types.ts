/**
 * Types shared by the server (`server/`) and the client (`client/`).
 * The server produces these shapes; the client consumes them as-is.
 */

export interface Meta {
  app: string;
  version: string;
  build: string;
  hostname: string;
  readonly: boolean;
  /** Whether "update now" (watchtower) is configured. */
  watchtower: boolean;
  /** Configured notification channels. */
  channels: string[];
  /** Web push availability for this server. */
  push: PushSubscriptionInfo;
  sampleMs: number;
  historyPoints: number;
  /** Single sign-on is configured (the provider's display name). */
  sso?: { name: string };
  /** The suite's app registry (DASH_APPS_URL); the header shows an app switcher when set. */
  appsUrl?: string;
}

export interface HostInfo {
  hostname: string;
  os: string;
  kernel: string;
  arch: string;
  cpuModel: string;
  cpuCount: number;
  bootedAt: number;
  rebootRequired: boolean;
}

export interface CpuSample {
  /** Aggregate CPU busy % (0-100). */
  percent: number;
  /** Per-core busy % (0-100). */
  cores: number[];
  iowait: number;
  steal: number;
}

export interface MemorySample {
  total: number;
  used: number;
  available: number;
  buffers: number;
  cached: number;
  swapTotal: number;
  swapUsed: number;
  percent: number;
}

export interface LoadSample {
  one: number;
  five: number;
  fifteen: number;
  running: number;
  threads: number;
}

export interface Temperature {
  chip: string;
  label: string;
  celsius: number;
  high?: number;
  critical?: number;
}

export interface DiskUsage {
  device: string;
  mount: string;
  fstype: string;
  total: number;
  used: number;
  free: number;
  percent: number;
}

export interface NetInterface {
  name: string;
  rxBytes: number;
  txBytes: number;
  /** bytes per second, computed between samples */
  rxRate: number;
  txRate: number;
}

export interface HostSample {
  t: number;
  uptime: number;
  cpu: CpuSample;
  memory: MemorySample;
  load: LoadSample;
  temperatures: Temperature[];
  disks: DiskUsage[];
  net: NetInterface[];
  /** Aggregate rx/tx across the real interfaces (bytes/s). */
  netRxRate: number;
  netTxRate: number;
}

export type ContainerState =
  | "created"
  | "running"
  | "paused"
  | "restarting"
  | "removing"
  | "exited"
  | "dead";

export type HealthStatus = "healthy" | "unhealthy" | "starting" | "none";

export interface PortBinding {
  ip?: string;
  private: number;
  public?: number;
  type: string;
}

export interface ContainerSummary {
  id: string;
  name: string;
  image: string;
  imageId: string;
  state: ContainerState;
  /** Docker's human status, e.g. "Up 3 hours (healthy)". */
  status: string;
  health: HealthStatus;
  created: number;
  stack: string | null;
  service: string | null;
  ports: PortBinding[];
  /** From the mk-dashboard.* / dash.* labels. */
  url?: string;
  description?: string;
  watchtower: boolean;
  stats?: ContainerStats;
}

export interface ContainerStats {
  cpuPercent: number;
  memUsage: number;
  memLimit: number;
  memPercent: number;
  netRx: number;
  netTx: number;
  netRxRate: number;
  netTxRate: number;
  blockRead: number;
  blockWrite: number;
  pids: number;
}

export interface Stack {
  name: string;
  /** Compose project working dir, when known. */
  workingDir?: string;
  configFiles?: string;
  url?: string;
  description?: string;
  containers: ContainerSummary[];
  running: number;
  total: number;
  unhealthy: number;
  cpuPercent: number;
  memUsage: number;
}

export interface HistoryPoint {
  t: number;
  cpu: number;
  mem: number;
  netRx: number;
  netTx: number;
}

export interface ContainerHistoryPoint {
  t: number;
  cpu: number;
  mem: number;
}

/** Stored history: minutes for a day, hours for a month. */
export type HistoryRange = "1h" | "24h" | "7d" | "30d";

export interface HostHistory {
  range: HistoryRange;
  /** Milliseconds between points. */
  step: number;
  points: HistoryPoint[];
}

export interface ContainerHistory {
  range: HistoryRange;
  step: number;
  points: ContainerHistoryPoint[];
}

export interface Alert {
  level: "warning" | "danger" | "info";
  title: string;
  detail?: string;
  /** Client route to jump to. */
  link?: string;
  /** First seen (set once the alert has been observed at least once). */
  since?: number;
}

export interface Snapshot {
  t: number;
  info: HostInfo;
  host: HostSample;
  docker: {
    version: string;
    containers: number;
    running: number;
    images: number;
  } | null;
  containers: ContainerSummary[];
  stacks: Stack[];
  alerts: Alert[];
  checks: CheckResult[];
}

export interface Overview {
  snapshot: Snapshot;
  history: HistoryPoint[];
}

export interface ContainerDetail extends ContainerSummary {
  imageDigest?: string;
  startedAt?: number;
  finishedAt?: number;
  exitCode?: number;
  restartCount: number;
  restartPolicy: string;
  platform: string;
  hostname: string;
  user: string;
  cmd: string[];
  entrypoint: string[];
  workingDir: string;
  env: Array<{ key: string; value: string; redacted: boolean }>;
  labels: Record<string, string>;
  mounts: Array<{
    type: string;
    source: string;
    destination: string;
    rw: boolean;
  }>;
  networks: Array<{ name: string; ip: string; aliases: string[] }>;
  healthLog: Array<{
    start: number;
    end: number;
    exitCode: number;
    output: string;
  }>;
  healthcheck?: string;
  failingStreak: number;
  memoryLimit: number;
  logDriver: string;
  tty: boolean;
  history: ContainerHistoryPoint[];
}

export interface ContainerTop {
  titles: string[];
  processes: string[][];
}

export interface ContainerLogs {
  lines: string[];
  tty: boolean;
}

export interface ImageInfo {
  id: string;
  tags: string[];
  size: number;
  sharedSize: number;
  created: number;
  containers: number;
  dangling: boolean;
}

export interface VolumeInfo {
  name: string;
  driver: string;
  mountpoint: string;
  size: number;
  refCount: number;
  created?: string;
}

export interface NetworkInfo {
  id: string;
  name: string;
  driver: string;
  scope: string;
  internal: boolean;
  containers: string[];
  subnet?: string;
}

export interface SystemInfo {
  docker: {
    version: string;
    apiVersion: string;
    os: string;
    kernel: string;
    arch: string;
    ncpu: number;
    memTotal: number;
    driver: string;
    rootDir: string;
    loggingDriver: string;
    cgroupVersion: string;
    containers: number;
    running: number;
    paused: number;
    stopped: number;
    images: number;
  };
  usage: {
    images: number;
    imagesReclaimable: number;
    containers: number;
    volumes: number;
    volumesReclaimable: number;
    buildCache: number;
  };
  images: ImageInfo[];
  volumes: VolumeInfo[];
  networks: NetworkInfo[];
}

export interface BackupSet {
  name: string;
  path: string;
  files: number;
  totalSize: number;
  latest?: { name: string; size: number; mtime: number };
  /** Newest "<ISO timestamp> <name>:" line in the log, when the log has one. */
  lastRun?: number;
  ageHours?: number;
  stale: boolean;
}

export interface BackupsInfo {
  dir: string;
  available: boolean;
  staleAfterHours: number;
  sets: BackupSet[];
  log: string[];
}

export interface ActionResult {
  ok: boolean;
  message: string;
}

export type ContainerAction =
  "start" | "stop" | "restart" | "pause" | "unpause" | "update";

// ---------- reachability checks ----------

export type CheckKind = "http" | "tcp";

/** One probe, from DASH_CHECKS / DASH_CHECKS_FILE or derived from a container's url label. */
export interface CheckConfig {
  name: string;
  kind?: CheckKind;
  /** http: the URL to GET. */
  url?: string;
  /** tcp: host and port; `tls` does a TLS handshake (and reads the certificate). */
  host?: string;
  port?: number;
  tls?: boolean;
  /** SNI / certificate name when it differs from `host`. */
  servername?: string;
  /** Accept self-signed certificates. */
  insecure?: boolean;
  /** http: acceptable status codes. Default: anything below 500. */
  expect?: number[];
  group?: string;
}

export interface CheckResult {
  name: string;
  kind: CheckKind;
  target: string;
  group?: string;
  /** Derived from a container label rather than configured. */
  auto: boolean;
  up: boolean;
  latencyMs?: number;
  status?: number;
  error?: string;
  certExpiresAt?: number;
  certDaysLeft?: number;
  certIssuer?: string;
  certSubject?: string;
  checkedAt: number;
  /** When the up/down state last changed. */
  since: number;
}

// ---------- docker events ----------

export interface DockerEvent {
  t: number;
  action: string;
  container: string;
  id: string;
  image?: string;
  stack?: string;
  exitCode?: number;
  detail?: string;
  level: "info" | "warning" | "danger";
}

// ---------- identity & push ----------

export interface Identity {
  email: string;
  via: "access" | "sso" | "lan" | "basic" | "open";
  canAct: boolean;
}

/** `POST /api/logout`: the session cookie is gone; `redirect` is the provider's own logout page when it has one. */
export interface SignOutResult {
  ok: boolean;
  redirect?: string;
}

export interface PushSubscriptionInfo {
  enabled: boolean;
  publicKey: string;
  devices: number;
}

// ---------- alerts & notifications ----------

export interface AlertEvent {
  t: number;
  type: "raised" | "cleared";
  level: Alert["level"];
  title: string;
  detail?: string;
  link?: string;
  /** Whether a notification went out for it. */
  notified: boolean;
}

export interface AlertsInfo {
  active: Alert[];
  history: AlertEvent[];
  /** Configured notification channels, e.g. ["ntfy", "telegram"]. */
  channels: string[];
  /** How long an alert must persist before it is notified. */
  afterMs: number;
  minLevel: Alert["level"];
}

// ---- SQLite console ----

/** One SQLite file found under the stacks directories. `path` is the host path (the key for every other call). */
export interface SqliteDb {
  path: string;
  name: string;
  stack: string | null;
  container: { id: string; name: string; state: ContainerState } | null;
  size: number;
  /** Size of the `-wal` file, 0 when there is none. */
  walSize: number;
  mtime: number;
  writable: boolean;
  /** The newest snapshot of this file, when there is one. */
  lastSnapshot: SqliteSnapshot | null;
}

export interface SqliteTable {
  name: string;
  kind: "table" | "view";
  rows: number | null;
  columns: Array<{ name: string; type: string; pk: boolean; notNull: boolean }>;
  sql: string;
}

export interface SqliteDbDetail extends SqliteDb {
  tables: SqliteTable[];
  pageSize: number;
  pageCount: number;
  freelistCount: number;
  journalMode: string;
  userVersion: number;
  /** The WAL could not be read (its `-shm` is unusable on this mount), so the file was opened `immutable=1`: what is shown may be slightly behind the app. */
  immutable: boolean;
  snapshots: SqliteSnapshot[];
}

export interface SqliteRows {
  columns: string[];
  rows: unknown[][];
  total: number;
  offset: number;
  limit: number;
}

export interface SqliteQueryResult {
  columns: string[];
  rows: unknown[][];
  /** True when the row cap cut the result short. */
  truncated: boolean;
  ms: number;
}

export interface SqliteSnapshot {
  file: string;
  size: number;
  at: number;
}

export interface SqliteHealth {
  /** `ok`, or the first lines of `PRAGMA integrity_check`. */
  integrity: string[];
  ok: boolean;
  ms: number;
  checkedAt: number;
}

/** NAS mode (mk-nas): what the agent's health verb says, asked once a minute. */
export interface NasHealth {
  ok: boolean;
  pools: { name: string; health: string; capacity: number; ok: boolean }[];
  disks: { id: string; ok: boolean; reason: string | null }[];
  problems: string[];
}

export interface NasInfo {
  reachable: boolean;
  /** Why not, when not. */
  error: string | null;
  health: NasHealth | null;
  agent: string | null;
  hostname: string | null;
  at: number;
}
