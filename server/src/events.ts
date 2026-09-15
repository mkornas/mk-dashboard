/** Docker container events → a readable timeline, with OOM kills surfaced as alerts. */
import type { Config } from './config.ts';
import { JsonlStore } from './store.ts';
import type { Alert, DockerEvent } from '../../shared/types.ts';

/** Raw shape of one `docker events` record (only what we read). */
export interface ApiEvent {
  Type?: string;
  Action?: string;
  time?: number;
  timeNano?: number;
  Actor?: { ID?: string; Attributes?: Record<string, string> };
}

/** Actions worth keeping (exec_* from healthchecks would flood the log). */
export const KEPT_ACTIONS = ['create', 'start', 'stop', 'die', 'kill', 'oom', 'restart', 'pause', 'unpause', 'destroy', 'rename', 'health_status', 'update'];

export function toEvent(raw: ApiEvent): DockerEvent | null {
  const action = raw.Action ?? '';
  const base = action.split(':')[0].trim();
  if (!KEPT_ACTIONS.includes(base)) return null;
  const a = raw.Actor?.Attributes ?? {};
  const exitCode = a.exitCode !== undefined ? Number(a.exitCode) : undefined;
  const t = raw.timeNano ? Math.floor(raw.timeNano / 1e6) : (raw.time ?? Math.floor(Date.now() / 1000)) * 1000;
  let level: DockerEvent['level'] = 'info';
  let detail: string | undefined;
  if (base === 'oom') {
    level = 'danger';
    detail = 'out of memory';
  } else if (base === 'die') {
    if (exitCode === 0) detail = 'exited cleanly';
    else if (exitCode === 137 || exitCode === 143) detail = `stopped (exit ${exitCode})`;
    else {
      level = 'warning';
      detail = `exited with code ${exitCode}`;
    }
  } else if (base === 'health_status') {
    const status = action.split(':')[1]?.trim() ?? '';
    detail = status;
    if (status === 'unhealthy') level = 'danger';
  } else if (base === 'kill') {
    detail = a.signal ? `signal ${a.signal}` : undefined;
  }
  return {
    t,
    action: base === 'health_status' ? 'health' : base,
    container: a.name ?? raw.Actor?.ID?.slice(0, 12) ?? '?',
    id: raw.Actor?.ID ?? '',
    image: a.image,
    stack: a['com.docker.compose.project'],
    exitCode,
    detail,
    level,
  };
}

export class EventLog {
  private readonly store: JsonlStore<DockerEvent>;

  constructor(cfg: Config) {
    this.store = new JsonlStore<DockerEvent>(cfg.dataDir, 'events.jsonl', 1000);
  }

  push(ev: DockerEvent): void {
    this.store.push(ev);
  }

  list(limit = 200, container?: string): DockerEvent[] {
    return this.store.list(limit, container ? (e) => e.id === container || e.container === container : undefined);
  }

  /** OOM kills in the last hour, one alert each. */
  recentAlerts(now = Date.now()): Alert[] {
    const hour = now - 3_600_000;
    const seen = new Set<string>();
    const out: Alert[] = [];
    for (const e of this.store.list(200, (x) => x.t >= hour && x.action === 'oom')) {
      if (seen.has(e.container)) continue;
      seen.add(e.container);
      out.push({ level: 'danger', title: `${e.container} was OOM-killed`, detail: `${Math.round((now - e.t) / 60_000)} min ago — raise its memory limit or find the leak`, link: `/containers/${e.id}`, since: e.t });
    }
    return out;
  }
}
