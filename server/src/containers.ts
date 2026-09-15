/**
 * Shapes Docker API payloads into the dashboard's container/stack model and
 * computes per-container stats (CPU % needs the previous sample).
 */
import type { DockerClient } from './docker.ts';
import type { Config } from './config.ts';
import type {
  ContainerDetail,
  ContainerState,
  ContainerStats,
  ContainerSummary,
  HealthStatus,
  PortBinding,
  Stack,
} from '../../shared/types.ts';

// Docker API shapes (only the fields we read)
export interface ApiContainer {
  Id: string;
  Names: string[];
  Image: string;
  ImageID: string;
  Created: number;
  State: string;
  Status: string;
  Labels: Record<string, string>;
  Ports: Array<{ IP?: string; PrivatePort: number; PublicPort?: number; Type: string }>;
}

export interface ApiStats {
  read: string;
  pids_stats?: { current?: number };
  cpu_stats: { cpu_usage: { total_usage: number }; system_cpu_usage?: number; online_cpus?: number };
  precpu_stats: { cpu_usage: { total_usage: number }; system_cpu_usage?: number };
  memory_stats: { usage?: number; limit?: number; stats?: Record<string, number> };
  networks?: Record<string, { rx_bytes: number; tx_bytes: number }>;
  blkio_stats?: { io_service_bytes_recursive?: Array<{ op: string; value: number }> | null };
}

const LABEL_URL = ['mk-dashboard.url', 'dash.url', 'homepage.href'];
const LABEL_DESC = ['mk-dashboard.description', 'dash.description', 'homepage.description'];
const LABEL_HIDE = ['mk-dashboard.hide', 'dash.hide'];

function label(labels: Record<string, string>, keys: string[]): string | undefined {
  for (const k of keys) if (labels[k]) return labels[k];
  return undefined;
}

export function healthOf(status: string): HealthStatus {
  const m = /\((healthy|unhealthy|health: starting)\)/.exec(status);
  if (!m) return 'none';
  return m[1] === 'health: starting' ? 'starting' : (m[1] as HealthStatus);
}

export function toSummary(c: ApiContainer, cfg: Config): ContainerSummary {
  const name = (c.Names[0] ?? c.Id).replace(/^\//, '');
  const labels = c.Labels ?? {};
  const stack = labels['com.docker.compose.project'] ?? null;
  const ports: PortBinding[] = [];
  const seen = new Set<string>();
  for (const p of c.Ports ?? []) {
    const key = `${p.IP ?? ''}:${p.PrivatePort}:${p.PublicPort ?? ''}/${p.Type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // collapse the IPv4 + IPv6 duplicate of the same binding
    if (p.IP === '::' && ports.some((q) => q.private === p.PrivatePort && q.public === p.PublicPort && q.type === p.Type)) continue;
    ports.push({ ip: p.IP, private: p.PrivatePort, public: p.PublicPort, type: p.Type });
  }
  return {
    id: c.Id,
    name,
    image: c.Image,
    imageId: c.ImageID,
    state: (c.State as ContainerState) ?? 'exited',
    status: c.Status,
    health: healthOf(c.Status),
    created: c.Created * 1000,
    stack,
    service: labels['com.docker.compose.service'] ?? null,
    ports,
    url: label(labels, LABEL_URL) ?? cfg.links[name] ?? (stack ? cfg.links[stack] : undefined),
    description: label(labels, LABEL_DESC),
    watchtower: labels['com.centurylinklabs.watchtower.enable'] === 'true',
  };
}

export function isHidden(c: ApiContainer, cfg: Config): boolean {
  const name = (c.Names[0] ?? '').replace(/^\//, '');
  if (cfg.hide.includes(name)) return true;
  return label(c.Labels ?? {}, LABEL_HIDE) === 'true';
}

export interface StatsPrev {
  t: number;
  cpuTotal: number;
  systemTotal: number;
  rx: number;
  tx: number;
}

export function computeStats(s: ApiStats, prev: StatsPrev | undefined, now: number): { stats: ContainerStats; prev: StatsPrev } {
  const cpuTotal = s.cpu_stats?.cpu_usage?.total_usage ?? 0;
  const systemTotal = s.cpu_stats?.system_cpu_usage ?? 0;
  const online = s.cpu_stats?.online_cpus || 1;
  let cpuPercent = 0;
  // Docker's precpu is populated when stream=true or one-shot=false; otherwise use ours.
  const pCpu = s.precpu_stats?.cpu_usage?.total_usage || prev?.cpuTotal || 0;
  const pSys = s.precpu_stats?.system_cpu_usage || prev?.systemTotal || 0;
  if (pSys && systemTotal > pSys && cpuTotal >= pCpu) {
    cpuPercent = ((cpuTotal - pCpu) / (systemTotal - pSys)) * online * 100;
  }
  const memStats = s.memory_stats?.stats ?? {};
  const rawUsage = s.memory_stats?.usage ?? 0;
  // cgroup v2 reports inactive_file, v1 "cache" — both are reclaimable page cache
  const cache = memStats.inactive_file ?? memStats.total_inactive_file ?? memStats.cache ?? 0;
  const memUsage = Math.max(0, rawUsage - cache);
  const memLimit = s.memory_stats?.limit ?? 0;
  let rx = 0;
  let tx = 0;
  for (const n of Object.values(s.networks ?? {})) {
    rx += n.rx_bytes ?? 0;
    tx += n.tx_bytes ?? 0;
  }
  let blockRead = 0;
  let blockWrite = 0;
  for (const e of s.blkio_stats?.io_service_bytes_recursive ?? []) {
    const op = e.op.toLowerCase();
    if (op === 'read') blockRead += e.value;
    else if (op === 'write') blockWrite += e.value;
  }
  const dt = prev ? (now - prev.t) / 1000 : 0;
  const rate = (cur: number, p: number | undefined) => (prev && dt > 0 && p !== undefined && cur >= p ? (cur - p) / dt : 0);
  return {
    stats: {
      cpuPercent: Math.round(Math.max(0, cpuPercent) * 10) / 10,
      memUsage,
      memLimit,
      memPercent: memLimit ? Math.min(100, (memUsage / memLimit) * 100) : 0,
      netRx: rx,
      netTx: tx,
      netRxRate: rate(rx, prev?.rx),
      netTxRate: rate(tx, prev?.tx),
      blockRead,
      blockWrite,
      pids: s.pids_stats?.current ?? 0,
    },
    prev: { t: now, cpuTotal, systemTotal, rx, tx },
  };
}

export function groupStacks(containers: ContainerSummary[], cfg: Config, rawLabels: Map<string, Record<string, string>>): Stack[] {
  const byName = new Map<string, Stack>();
  for (const c of containers) {
    const key = c.stack ?? c.name;
    let s = byName.get(key);
    if (!s) {
      const labels = rawLabels.get(c.id) ?? {};
      s = {
        name: key,
        workingDir: c.stack ? labels['com.docker.compose.project.working_dir'] : undefined,
        configFiles: c.stack ? labels['com.docker.compose.project.config_files'] : undefined,
        url: cfg.links[key],
        containers: [],
        running: 0,
        total: 0,
        unhealthy: 0,
        cpuPercent: 0,
        memUsage: 0,
      };
      byName.set(key, s);
    }
    s.containers.push(c);
    s.total += 1;
    if (c.state === 'running') s.running += 1;
    if (c.health === 'unhealthy' || (c.state !== 'running' && c.state !== 'exited') || (c.state === 'exited' && c.watchtower)) s.unhealthy += 1;
    s.cpuPercent += c.stats?.cpuPercent ?? 0;
    s.memUsage += c.stats?.memUsage ?? 0;
    // a stack's link/description: first container that has one
    if (!s.url && c.url) s.url = c.url;
    if (!s.description && c.description) s.description = c.description;
  }
  for (const s of byName.values()) {
    s.containers.sort((a, b) => a.name.localeCompare(b.name));
    s.cpuPercent = Math.round(s.cpuPercent * 10) / 10;
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const SECRET_KEY = /(token|secret|passw|password|api_?key|private|credential|auth|dsn|connection_?string|cookie|salt)/i;

export function redactEnv(env: string[]): ContainerDetail['env'] {
  return env.map((e) => {
    const i = e.indexOf('=');
    const key = i === -1 ? e : e.slice(0, i);
    const value = i === -1 ? '' : e.slice(i + 1);
    const redacted = SECRET_KEY.test(key) && value !== '';
    return { key, value: redacted ? '••••••••' : value, redacted };
  });
}

/** Full detail from `GET /containers/{id}/json`. */
export async function inspectContainer(docker: DockerClient, id: string, cfg: Config): Promise<Omit<ContainerDetail, 'history' | 'stats'>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const j = await docker.get<any>(`/containers/${encodeURIComponent(id)}/json`);
  const labels: Record<string, string> = j.Config?.Labels ?? {};
  const state = j.State ?? {};
  const health = state.Health;
  const ports: PortBinding[] = [];
  for (const [key, bindings] of Object.entries<any>(j.NetworkSettings?.Ports ?? {})) {
    const [priv, type] = key.split('/');
    if (!bindings) {
      ports.push({ private: Number(priv), type });
      continue;
    }
    for (const b of bindings as Array<{ HostIp: string; HostPort: string }>) {
      if (b.HostIp === '::' && ports.some((p) => p.private === Number(priv) && p.public === Number(b.HostPort))) continue;
      ports.push({ ip: b.HostIp, private: Number(priv), public: Number(b.HostPort), type });
    }
  }
  const summaryLike: ApiContainer = {
    Id: j.Id,
    Names: [j.Name],
    Image: j.Config?.Image ?? j.Image,
    ImageID: j.Image,
    Created: Date.parse(j.Created) / 1000,
    State: state.Status,
    Status: health?.Status ? `${state.Status} (${health.Status})` : state.Status,
    Labels: labels,
    Ports: [],
  };
  const base = toSummary(summaryLike, cfg);
  const started = Date.parse(state.StartedAt);
  const finished = Date.parse(state.FinishedAt);
  const restartPolicy = j.HostConfig?.RestartPolicy?.Name || 'no';
  const rpMax = j.HostConfig?.RestartPolicy?.MaximumRetryCount;
  return {
    ...base,
    health: (health?.Status as HealthStatus) ?? 'none',
    ports,
    imageDigest: undefined,
    startedAt: started > 0 ? started : undefined,
    finishedAt: finished > 0 ? finished : undefined,
    exitCode: state.ExitCode,
    restartCount: j.RestartCount ?? 0,
    restartPolicy: rpMax ? `${restartPolicy}:${rpMax}` : restartPolicy,
    platform: j.Platform ?? '',
    hostname: j.Config?.Hostname ?? '',
    user: j.Config?.User ?? '',
    cmd: j.Config?.Cmd ?? [],
    entrypoint: j.Config?.Entrypoint ?? [],
    workingDir: j.Config?.WorkingDir ?? '',
    env: redactEnv(j.Config?.Env ?? []),
    labels,
    mounts: (j.Mounts ?? []).map((m: any) => ({ type: m.Type, source: m.Source ?? m.Name ?? '', destination: m.Destination, rw: !!m.RW })),
    networks: Object.entries<any>(j.NetworkSettings?.Networks ?? {}).map(([name, n]) => ({ name, ip: n.IPAddress ?? '', aliases: n.Aliases ?? [] })),
    healthLog: (health?.Log ?? []).map((l: any) => ({ start: Date.parse(l.Start), end: Date.parse(l.End), exitCode: l.ExitCode, output: (l.Output ?? '').trim() })),
    healthcheck: j.Config?.Healthcheck?.Test?.filter((x: string) => x !== 'CMD' && x !== 'CMD-SHELL').join(' ') || undefined,
    failingStreak: health?.FailingStreak ?? 0,
    memoryLimit: j.HostConfig?.Memory ?? 0,
    logDriver: j.HostConfig?.LogConfig?.Type ?? '',
    tty: !!j.Config?.Tty,
  };
}
