/**
 * The heartbeat: every `sampleMs` read the host and the containers, build a
 * Snapshot, keep a ring of history and fan out to SSE subscribers. Docker
 * events trigger an early re-sample so start/stop shows up right away.
 */
import type { Config } from "./config.ts";
import { HostReader } from "./host.ts";
import { DockerClient, NdjsonParser } from "./docker.ts";
import {
  type ApiContainer,
  type ApiStats,
  type StatsPrev,
  computeStats,
  groupStacks,
  isHidden,
  toSummary,
} from "./containers.ts";
import { readBackups } from "./backups.ts";
import { nasAlerts, nasReader, type NasInfo } from "./nas.ts";
import type { Checker } from "./checks.ts";
import { type ApiEvent, type EventLog, toEvent } from "./events.ts";
import type { Notifier } from "./notify.ts";
import type { PushService } from "./push.ts";
import type { SqliteMonitor } from "./sqlite-monitor.ts";
import type {
  Alert,
  BackupsInfo,
  CheckConfig,
  CheckResult,
  ContainerHistoryPoint,
  ContainerSummary,
  HistoryPoint,
  Snapshot,
  Stack,
} from "../../shared/types.ts";

type Listener = (s: Snapshot) => void;

export class Sampler {
  readonly host: HostReader;
  latest: Snapshot | null = null;
  readonly history: HistoryPoint[] = [];
  private readonly containerHistory = new Map<
    string,
    ContainerHistoryPoint[]
  >();
  private readonly statsPrev = new Map<string, StatsPrev>();
  private readonly listeners = new Set<Listener>();
  private timer?: NodeJS.Timeout;
  private eventsTimer?: NodeJS.Timeout;
  private sampling = false;
  private dockerVersion: { Version: string } | null = null;
  private dockerDown = false;
  private backups: BackupsInfo | null = null;
  private nasInfo: NasInfo | null = null;
  private nasAt = 0;
  private backupsAt = 0;
  private sqliteAt = 0;

  private readonly cfg: Config;
  readonly docker: DockerClient;
  readonly checker: Checker;
  readonly events: EventLog;
  readonly notifier: Notifier;
  readonly push: PushService;
  private readonly sqlite: SqliteMonitor | null;

  constructor(
    cfg: Config,
    docker: DockerClient,
    checker: Checker,
    events: EventLog,
    notifier: Notifier,
    push: PushService,
    sqlite: SqliteMonitor | null = null,
  ) {
    this.cfg = cfg;
    this.docker = docker;
    this.checker = checker;
    this.events = events;
    this.notifier = notifier;
    this.push = push;
    this.sqlite = sqlite;
    this.host = new HostReader(cfg);
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  containerHistoryFor(id: string): ContainerHistoryPoint[] {
    return this.containerHistory.get(id) ?? [];
  }

  async start(): Promise<void> {
    await this.sample(); // primes the CPU counters
    await new Promise((r) => setTimeout(r, Math.min(1000, this.cfg.sampleMs)));
    await this.sample();
    this.timer = setInterval(() => void this.sample(), this.cfg.sampleMs);
    this.timer.unref();
    void this.watchEvents();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Re-sample soon (debounced) — used after actions and docker events. */
  poke(): void {
    if (this.eventsTimer) return;
    this.eventsTimer = setTimeout(() => {
      this.eventsTimer = undefined;
      void this.sample();
    }, 400);
  }

  async sample(): Promise<Snapshot | null> {
    if (this.sampling) return this.latest;
    this.sampling = true;
    try {
      const [info, host, dockerPart] = await Promise.all([
        this.host.info(),
        this.host.sample(),
        this.sampleDocker(),
      ]);
      const stacks = groupStacks(
        dockerPart.containers,
        this.cfg,
        dockerPart.labels,
      );
      if (this.cfg.autoChecks)
        this.checker.setAutoChecks(autoChecks(stacks, dockerPart.labels));
      this.notifier.setHostname(info.hostname);
      const snapshot: Snapshot = {
        t: host.t,
        info,
        host,
        docker: dockerPart.docker,
        containers: dockerPart.containers,
        stacks,
        alerts: [],
        checks: this.checker.list(),
      };
      for (const c of snapshot.containers) {
        if (c.stats && c.stats.memLimit >= host.memory.total * 0.98) {
          c.stats.memLimit = 0;
          c.stats.memPercent = 0;
        }
      }
      const alerts = [
        ...buildAlerts(snapshot, this.cfg, this.backups),
        ...checkAlerts(snapshot.checks, this.cfg),
        ...this.events.recentAlerts(snapshot.t),
        ...(this.sqlite?.alerts(snapshot.t) ?? []),
        ...nasAlerts(this.nasInfo),
      ];
      snapshot.alerts = this.notifier.update(alerts, snapshot.t);
      this.refreshBackups();
      this.refreshSqlite();
      this.refreshNas();
      this.latest = snapshot;
      this.pushHistory(snapshot);
      for (const l of this.listeners) {
        try {
          l(snapshot);
        } catch {
          /* listener errors never break sampling */
        }
      }
      return snapshot;
    } catch (e) {
      console.error("sample failed:", (e as Error).message);
      return this.latest;
    } finally {
      this.sampling = false;
    }
  }

  private async sampleDocker(): Promise<{
    docker: Snapshot["docker"];
    containers: ContainerSummary[];
    labels: Map<string, Record<string, string>>;
  }> {
    const labels = new Map<string, Record<string, string>>();
    try {
      const list = await this.docker.get<ApiContainer[]>(
        "/containers/json?all=1",
      );
      if (!this.dockerVersion)
        this.dockerVersion = await this.docker.get<{ Version: string }>(
          "/version",
        );
      const visible = list.filter((c) => !isHidden(c, this.cfg));
      const now = Date.now();
      const containers = await Promise.all(
        visible.map(async (c) => {
          labels.set(c.Id, c.Labels ?? {});
          const summary = toSummary(c, this.cfg);
          if (c.State === "running") {
            try {
              const raw = await this.docker.get<ApiStats>(
                `/containers/${c.Id}/stats?stream=false&one-shot=true`,
              );
              const { stats, prev } = computeStats(
                raw,
                this.statsPrev.get(c.Id),
                now,
              );
              this.statsPrev.set(c.Id, prev);
              summary.stats = stats;
            } catch {
              /* container may have just stopped */
            }
          } else {
            this.statsPrev.delete(c.Id);
          }
          return summary;
        }),
      );
      containers.sort((a, b) => a.name.localeCompare(b.name));
      if (this.dockerDown) {
        this.dockerDown = false;
        console.log("docker socket is back");
      }
      let images = 0;
      try {
        images = (await this.docker.get<unknown[]>("/images/json")).length;
      } catch {
        /* optional */
      }
      return {
        docker: {
          version: this.dockerVersion?.Version ?? "",
          containers: list.length,
          running: list.filter((c) => c.State === "running").length,
          images,
        },
        containers,
        labels,
      };
    } catch (e) {
      if (!this.dockerDown) {
        this.dockerDown = true;
        console.error("docker unavailable:", (e as Error).message);
      }
      return { docker: null, containers: [], labels };
    }
  }

  /** The NAS agent is asked once a minute, off the sampling path; the last answer is what the alerts see. */
  private refreshNas(): void {
    const read = nasReader(this.cfg);
    if (!read || Date.now() - this.nasAt < 60_000) return;
    this.nasAt = Date.now();
    read()
      .then((n) => (this.nasInfo = n))
      .catch(() => undefined);
  }

  /** The last answer of the NAS agent (null when NAS mode is off or nothing was asked yet). */
  get nas(): NasInfo | null {
    return this.nasInfo;
  }

  /** Backups are scanned at most every 5 minutes, off the sampling path. */
  private refreshBackups(): void {
    if (Date.now() - this.backupsAt < 5 * 60_000) return;
    this.backupsAt = Date.now();
    readBackups(this.cfg)
      .then((b) => (this.backups = b))
      .catch(() => undefined);
  }

  /** The SQLite files likewise: sizes, WALs and snapshots every 5 minutes, the integrity check nightly. */
  private refreshSqlite(): void {
    if (!this.sqlite || Date.now() - this.sqliteAt < 5 * 60_000) return;
    this.sqliteAt = Date.now();
    this.sqlite
      .refresh()
      .catch((e: Error) => console.warn("sqlite monitor:", e.message));
  }

  private pushHistory(s: Snapshot): void {
    const max = this.cfg.historyPoints;
    this.history.push({
      t: s.t,
      cpu: round1(s.host.cpu.percent),
      mem: round1(s.host.memory.percent),
      netRx: Math.round(s.host.netRxRate),
      netTx: Math.round(s.host.netTxRate),
    });
    if (this.history.length > max)
      this.history.splice(0, this.history.length - max);
    const live = new Set<string>();
    for (const c of s.containers) {
      live.add(c.id);
      if (!c.stats) continue;
      let h = this.containerHistory.get(c.id);
      if (!h) {
        h = [];
        this.containerHistory.set(c.id, h);
      }
      h.push({
        t: s.t,
        cpu: round1(c.stats.cpuPercent),
        mem: c.stats.memUsage,
      });
      if (h.length > max) h.splice(0, h.length - max);
    }
    for (const id of this.containerHistory.keys())
      if (!live.has(id)) this.containerHistory.delete(id);
  }

  /** Follow `docker events` for containers and poke on anything interesting. */
  private async watchEvents(): Promise<void> {
    const filters = encodeURIComponent(JSON.stringify({ type: ["container"] }));
    for (;;) {
      try {
        const stream = await this.docker.stream(`/events?filters=${filters}`);
        const parser = new NdjsonParser<ApiEvent>();
        await new Promise<void>((resolve) => {
          stream.on("data", (chunk: Buffer) => {
            for (const raw of parser.push(chunk)) {
              const ev = toEvent(raw);
              if (!ev) continue;
              this.events.push(ev);
              this.poke();
            }
          });
          stream.on("end", resolve);
          stream.on("error", resolve);
          stream.on("close", resolve);
        });
      } catch {
        /* docker down — retry below */
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

/** One HTTP check per stack that carries a url label (opt out with mk-dashboard.check=false). */
export function autoChecks(
  stacks: Stack[],
  labels: Map<string, Record<string, string>>,
): CheckConfig[] {
  const out: CheckConfig[] = [];
  for (const s of stacks) {
    if (!s.url || !/^https?:\/\//.test(s.url)) continue;
    const optOut = s.containers.some(
      (c) => (labels.get(c.id) ?? {})["mk-dashboard.check"] === "false",
    );
    if (optOut) continue;
    out.push({ name: s.name, url: s.url, group: "apps" });
  }
  return out;
}

export function checkAlerts(checks: CheckResult[], cfg: Config): Alert[] {
  const alerts: Alert[] = [];
  for (const c of checks) {
    if (!c.up)
      alerts.push({
        level: "danger",
        title: `${c.name} is unreachable`,
        detail: `${c.target}: ${c.error ?? "no answer"}`,
        link: "/network",
        since: c.since,
      });
    else if (
      c.certDaysLeft !== undefined &&
      c.certDaysLeft <= cfg.certWarnDays
    ) {
      alerts.push({
        level: c.certDaysLeft <= 3 ? "danger" : "warning",
        title:
          c.certDaysLeft < 0
            ? `Certificate for ${c.name} has expired`
            : `Certificate for ${c.name} expires in ${c.certDaysLeft} day${c.certDaysLeft === 1 ? "" : "s"}`,
        detail: `${c.certSubject ?? c.target}, issued by ${c.certIssuer ?? "unknown"}`,
        link: "/network",
      });
    }
  }
  return alerts;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function buildAlerts(
  s: Snapshot,
  cfg: Config,
  backups: BackupsInfo | null = null,
): Alert[] {
  const alerts: Alert[] = [];
  for (const b of backups?.sets ?? []) {
    if (b.stale)
      alerts.push({
        level: "warning",
        title: `Backup of ${b.name} is stale`,
        detail: `Newest file is ${Math.round(b.ageHours ?? 0)} h old (limit ${backups?.staleAfterHours} h)`,
        link: "/backups",
      });
  }
  if (!s.docker)
    alerts.push({
      level: "danger",
      title: "Docker is unreachable",
      detail: `No answer on ${cfg.dockerSocket}`,
    });
  for (const c of s.containers) {
    if (c.health === "unhealthy")
      alerts.push({
        level: "danger",
        title: `${c.name} is unhealthy`,
        detail: c.status,
        link: `/containers/${c.id}`,
      });
    else if (c.state === "restarting")
      alerts.push({
        level: "danger",
        title: `${c.name} keeps restarting`,
        detail: c.status,
        link: `/containers/${c.id}`,
      });
    else if (c.state === "exited" && c.watchtower)
      alerts.push({
        level: "warning",
        title: `${c.name} is down`,
        detail: c.status,
        link: `/containers/${c.id}`,
      });
    else if (c.state === "paused")
      alerts.push({
        level: "info",
        title: `${c.name} is paused`,
        link: `/containers/${c.id}`,
      });
    if (c.stats && c.stats.memLimit && c.stats.memPercent >= 90)
      alerts.push({
        level: "warning",
        title: `${c.name} is near its memory limit`,
        detail: `${Math.round(c.stats.memPercent)}% of the limit`,
        link: `/containers/${c.id}`,
      });
  }
  for (const d of s.host.disks) {
    if (d.percent >= 95)
      alerts.push({
        level: "danger",
        title: `Disk ${d.mount} is almost full`,
        detail: `${Math.round(d.percent)}% used`,
        link: "/system",
      });
    else if (d.percent >= 85)
      alerts.push({
        level: "warning",
        title: `Disk ${d.mount} is filling up`,
        detail: `${Math.round(d.percent)}% used`,
        link: "/system",
      });
  }
  if (s.host.memory.percent >= 92)
    alerts.push({
      level: "warning",
      title: "Memory is nearly exhausted",
      detail: `${Math.round(s.host.memory.percent)}% in use`,
    });
  if (
    s.host.memory.swapTotal &&
    s.host.memory.swapUsed / s.host.memory.swapTotal > 0.5
  )
    alerts.push({
      level: "info",
      title: "Swap is in use",
      detail: `${Math.round((s.host.memory.swapUsed / s.host.memory.swapTotal) * 100)}% of swap`,
    });
  for (const t of s.host.temperatures) {
    const limit = t.critical ?? t.high;
    if (limit && t.celsius >= limit - 5)
      alerts.push({
        level: "warning",
        title: `${t.chip} ${t.label} is hot`,
        detail: `${t.celsius} °C (limit ${limit} °C)`,
      });
  }
  if (s.info.rebootRequired)
    alerts.push({
      level: "info",
      title: "Reboot required",
      detail: "The host has pending updates that need a restart",
    });
  return alerts;
}
