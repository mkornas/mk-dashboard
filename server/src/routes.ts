import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "./config.ts";
import { DockerError, LogDemuxer } from "./docker.ts";
import { inspectContainer } from "./containers.ts";
import type { Sampler } from "./sampler.ts";
import { type HistoryStore, isRange } from "./history.ts";
import { readBackups } from "./backups.ts";
import { nasReader } from "./nas.ts";
import { triggerUpdate, watchtowerEnabled } from "./watchtower.ts";
import type {
  ActionResult,
  AlertsInfo,
  CheckResult,
  ContainerAction,
  ContainerDetail,
  ContainerHistory,
  ContainerLogs,
  ContainerTop,
  DockerEvent,
  HostHistory,
  Identity,
  ImageInfo,
  Meta,
  NetworkInfo,
  Overview,
  PushSubscriptionInfo,
  SystemInfo,
  VolumeInfo,
} from "../../shared/types.ts";

const ACTIONS: ContainerAction[] = [
  "start",
  "stop",
  "restart",
  "pause",
  "unpause",
  "update",
];

/** Server-sent events helper. */
function openSse(
  req: FastifyRequest,
  reply: FastifyReply,
): {
  send: (event: string, data: unknown) => boolean;
  close: () => void;
  onClose: (fn: () => void) => void;
} {
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  reply.raw.write(": connected\n\n");
  const ping = setInterval(() => reply.raw.write(": ping\n\n"), 15_000);
  let closed = false;
  const closers: Array<() => void> = [];
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(ping);
    for (const c of closers) c();
    reply.raw.end();
  };
  req.raw.on("close", close);
  return {
    send: (event, data) => {
      if (closed) return false;
      return reply.raw.write(
        `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
      );
    },
    close,
    onClose: (fn) => closers.push(fn),
  };
}

export function registerRoutes(
  app: FastifyInstance,
  cfg: Config,
  sampler: Sampler,
  history: HistoryStore,
): void {
  const docker = sampler.docker;

  /** 403 unless this identity may run actions. */
  const requireAct = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (req.identity?.canAct) return true;
    reply
      .code(403)
      .send({
        ok: false,
        message: cfg.readonly
          ? "dashboard is read-only"
          : `${req.identity?.email ?? "this user"} may not run actions`,
      });
    return false;
  };

  app.get("/api/me", async (req): Promise<Identity> => req.identity);

  app.get("/api/health", async () => ({
    ok: true,
    build: cfg.build,
    version: cfg.version,
    uptime: Math.round(process.uptime()),
  }));

  app.get("/api/meta", async (): Promise<Meta> => ({
    app: cfg.app,
    version: cfg.version,
    build: cfg.build,
    hostname: (await sampler.host.info()).hostname,
    readonly: cfg.readonly,
    watchtower: watchtowerEnabled(cfg),
    channels: sampler.notifier.channels(),
    push: sampler.push.info(),
    sampleMs: cfg.sampleMs,
    historyPoints: cfg.historyPoints,
    sso:
      cfg.oidcIssuer && cfg.oidcClientId && cfg.oidcClientSecret
        ? { name: cfg.oidcName }
        : undefined,
  }));

  app.get("/api/overview", async (): Promise<Overview> => {
    const snapshot = sampler.latest ?? (await sampler.sample());
    if (!snapshot)
      throw Object.assign(new Error("no snapshot yet"), { statusCode: 503 });
    return { snapshot, history: sampler.history };
  });

  // ---- stored history: ?range=1h|24h|7d|30d ----
  const rangeOf = (q: { range?: string }, reply: FastifyReply) => {
    if (isRange(q.range)) return q.range;
    reply
      .code(400)
      .send({ ok: false, message: "range must be 1h, 24h, 7d or 30d" });
    return null;
  };
  app.get<{ Querystring: { range?: string } }>(
    "/api/history",
    async (req, reply): Promise<HostHistory | FastifyReply> => {
      const range = rangeOf(req.query, reply);
      return range ? history.host(range) : reply;
    },
  );
  app.get<{ Querystring: { range?: string; name?: string } }>(
    "/api/history/container",
    async (req, reply): Promise<ContainerHistory | FastifyReply> => {
      const range = rangeOf(req.query, reply);
      if (!range) return reply;
      if (!req.query.name)
        return reply.code(400).send({ ok: false, message: "name is required" });
      return history.container(req.query.name, range);
    },
  );

  app.get("/api/stream", async (req, reply) => {
    const sse = openSse(req, reply);
    if (sampler.latest)
      sse.send("overview", {
        snapshot: sampler.latest,
        history: sampler.history,
      } satisfies Overview);
    const off = sampler.subscribe((snapshot) => sse.send("snapshot", snapshot));
    sse.onClose(off);
    // keep the handler open until the client goes away
    await new Promise<void>((resolve) => req.raw.on("close", resolve));
  });

  // ---- containers ----
  app.get<{ Params: { id: string } }>(
    "/api/containers/:id",
    async (req): Promise<ContainerDetail> => {
      const detail = await inspectContainer(docker, req.params.id, cfg);
      const live = sampler.latest?.containers.find((c) => c.id === detail.id);
      return {
        ...detail,
        stats: live?.stats,
        history: sampler.containerHistoryFor(detail.id),
      };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/containers/:id/top",
    async (req): Promise<ContainerTop> => {
      const r = await docker.get<{ Titles: string[]; Processes: string[][] }>(
        `/containers/${encodeURIComponent(req.params.id)}/top?ps_args=-eo%20pid,user,%25cpu,%25mem,etime,args`,
      );
      return { titles: r.Titles ?? [], processes: r.Processes ?? [] };
    },
  );

  app.get<{ Params: { id: string }; Querystring: { tail?: string } }>(
    "/api/containers/:id/logs",
    async (req): Promise<ContainerLogs> => {
      const id = encodeURIComponent(req.params.id);
      const tail = Math.min(5000, Math.max(1, Number(req.query.tail) || 500));
      const tty = !!(
        await docker.get<{ Config: { Tty: boolean } }>(`/containers/${id}/json`)
      ).Config?.Tty;
      const r = await docker.request(
        "GET",
        `/containers/${id}/logs?stdout=1&stderr=1&timestamps=1&tail=${tail}`,
      );
      const d = new LogDemuxer(tty);
      const lines = [...d.push(r.body), ...d.flush()];
      return { lines, tty };
    },
  );

  app.get<{ Params: { id: string }; Querystring: { tail?: string } }>(
    "/api/containers/:id/logs/stream",
    async (req, reply) => {
      const id = encodeURIComponent(req.params.id);
      const tail = Math.min(5000, Math.max(0, Number(req.query.tail) || 200));
      const tty = !!(
        await docker.get<{ Config: { Tty: boolean } }>(`/containers/${id}/json`)
      ).Config?.Tty;
      const stream = await docker.stream(
        `/containers/${id}/logs?stdout=1&stderr=1&timestamps=1&follow=1&tail=${tail}`,
      );
      const sse = openSse(req, reply);
      const d = new LogDemuxer(tty);
      let batch: string[] = [];
      let flushTimer: NodeJS.Timeout | undefined;
      const flush = () => {
        flushTimer = undefined;
        if (batch.length) {
          sse.send("lines", batch);
          batch = [];
        }
      };
      stream.on("data", (chunk: Buffer) => {
        batch.push(...d.push(chunk));
        if (!flushTimer) flushTimer = setTimeout(flush, 80);
      });
      stream.on("end", () => {
        batch.push(...d.flush());
        flush();
        sse.send("end", {});
        sse.close();
      });
      stream.on("error", () => sse.close());
      sse.onClose(() => {
        if (flushTimer) clearTimeout(flushTimer);
        stream.destroy();
      });
      await new Promise<void>((resolve) => req.raw.on("close", resolve));
    },
  );

  app.post<{ Params: { id: string; action: string } }>(
    "/api/containers/:id/:action",
    async (req, reply): Promise<ActionResult> => {
      const action = req.params.action as ContainerAction;
      if (!ACTIONS.includes(action))
        return reply
          .code(404)
          .send({ ok: false, message: `unknown action ${action}` });
      if (!requireAct(req, reply)) return reply;
      const id = encodeURIComponent(req.params.id);
      const name =
        sampler.latest?.containers.find(
          (c) => c.id.startsWith(req.params.id) || c.name === req.params.id,
        )?.name ?? req.params.id;
      if (action === "update") {
        const c = sampler.latest?.containers.find((c) =>
          c.id.startsWith(req.params.id),
        );
        const image =
          c?.image ??
          (
            await docker.get<{ Config: { Image: string } }>(
              `/containers/${id}/json`,
            )
          ).Config.Image;
        const r = await triggerUpdate(cfg, image);
        sampler.poke();
        if (!r.ok) return reply.code(502).send(r);
        return { ok: true, message: `Asked watchtower to check ${image}` };
      }
      try {
        const timeout =
          action === "stop" || action === "restart" ? "?t=15" : "";
        await docker.post(`/containers/${id}/${action}${timeout}`);
      } catch (e) {
        if (e instanceof DockerError && e.status === 304)
          return {
            ok: true,
            message: `${name} was already ${action === "start" ? "running" : "stopped"}`,
          };
        throw e;
      }
      sampler.poke();
      return { ok: true, message: `${name}: ${action} done` };
    },
  );

  // ---- system ----
  app.get("/api/system", async (): Promise<SystemInfo> => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [info, version, df, networks] = await Promise.all([
      docker.get<any>("/info"),
      docker.get<any>("/version"),
      docker.get<any>("/system/df"),
      docker.get<any[]>("/networks"),
    ]);
    const running = sampler.latest?.containers ?? [];
    const imageUse = new Map<string, number>();
    for (const c of df.Containers ?? [])
      imageUse.set(c.ImageID, (imageUse.get(c.ImageID) ?? 0) + 1);
    const images: ImageInfo[] = (df.Images ?? [])
      .map((i: any): ImageInfo => ({
        id: i.Id,
        tags: (i.RepoTags ?? []).filter((t: string) => t !== "<none>:<none>"),
        size: i.Size ?? 0,
        sharedSize: i.SharedSize ?? 0,
        created: (i.Created ?? 0) * 1000,
        containers: Math.max(0, i.Containers ?? 0),
        dangling: !(i.RepoTags ?? []).some(
          (t: string) => t !== "<none>:<none>",
        ),
      }))
      .sort((a: ImageInfo, b: ImageInfo) => b.size - a.size);
    const volumes: VolumeInfo[] = (df.Volumes ?? [])
      .map((v: any): VolumeInfo => ({
        name: v.Name,
        driver: v.Driver,
        mountpoint: v.Mountpoint,
        size: v.UsageData?.Size ?? -1,
        refCount: v.UsageData?.RefCount ?? 0,
        created: v.CreatedAt,
      }))
      .sort((a: VolumeInfo, b: VolumeInfo) => b.size - a.size);
    const nets: NetworkInfo[] = networks
      .map((n: any): NetworkInfo => ({
        id: n.Id,
        name: n.Name,
        driver: n.Driver,
        scope: n.Scope,
        internal: !!n.Internal,
        containers: running.filter(
          (c) => (sampler.latest?.containers ?? []).length && true,
        ).length
          ? []
          : [],
        subnet: n.IPAM?.Config?.[0]?.Subnet,
      }))
      .sort((a: NetworkInfo, b: NetworkInfo) => a.name.localeCompare(b.name));
    // which containers sit on which network (from /containers/json NetworkSettings)
    try {
      const list = await docker.get<any[]>("/containers/json?all=1");
      for (const n of nets)
        n.containers = list
          .filter((c) => c.NetworkSettings?.Networks?.[n.name])
          .map((c) => (c.Names?.[0] ?? "").replace(/^\//, ""))
          .sort();
    } catch {
      /* fine */
    }
    const imagesTotal = images.reduce((a, i) => a + i.size, 0);
    const imagesReclaimable = images
      .filter((i) => i.containers === 0)
      .reduce((a, i) => a + i.size - i.sharedSize, 0);
    const volTotal = volumes.reduce((a, v) => a + Math.max(0, v.size), 0);
    const volReclaimable = volumes
      .filter((v) => v.refCount === 0)
      .reduce((a, v) => a + Math.max(0, v.size), 0);
    const buildCache = (df.BuildCache ?? []).reduce(
      (a: number, b: any) => a + (b.Size ?? 0),
      0,
    );
    return {
      docker: {
        version: version.Version,
        apiVersion: version.ApiVersion,
        os: info.OperatingSystem,
        kernel: info.KernelVersion,
        arch: info.Architecture,
        ncpu: info.NCPU,
        memTotal: info.MemTotal,
        driver: info.Driver,
        rootDir: info.DockerRootDir,
        loggingDriver: info.LoggingDriver,
        cgroupVersion: info.CgroupVersion,
        containers: info.Containers,
        running: info.ContainersRunning,
        paused: info.ContainersPaused,
        stopped: info.ContainersStopped,
        images: info.Images,
      },
      usage: {
        images: imagesTotal,
        imagesReclaimable,
        containers: (df.Containers ?? []).reduce(
          (a: number, c: any) => a + (c.SizeRw ?? 0),
          0,
        ),
        volumes: volTotal,
        volumesReclaimable: volReclaimable,
        buildCache,
      },
      images,
      volumes,
      networks: nets,
    };
  });

  app.post<{ Body: { images?: "dangling" | "unused"; buildCache?: boolean } }>(
    "/api/system/prune",
    async (req, reply): Promise<ActionResult> => {
      if (!requireAct(req, reply)) return reply;
      const mode = req.body?.images ?? "dangling";
      const filters = encodeURIComponent(
        JSON.stringify({ dangling: [mode === "dangling" ? "true" : "false"] }),
      );
      const r = await docker.post<{
        ImagesDeleted?: unknown[];
        SpaceReclaimed?: number;
      }>(`/images/prune?filters=${filters}`, undefined, 120_000);
      let reclaimed = r?.SpaceReclaimed ?? 0;
      let deleted = r?.ImagesDeleted?.length ?? 0;
      if (req.body?.buildCache) {
        const b = await docker.post<{ SpaceReclaimed?: number }>(
          "/build/prune",
          undefined,
          120_000,
        );
        reclaimed += b?.SpaceReclaimed ?? 0;
      }
      sampler.poke();
      return {
        ok: true,
        message: `Removed ${deleted} image layer${deleted === 1 ? "" : "s"}, reclaimed ${formatBytes(reclaimed)}`,
      };
    },
  );

  app.get("/api/backups", async () => readBackups(cfg));
  /** NAS mode: what the mk-nas agent last said (asked once a minute), or a 404 when neither the drive nor the socket is configured. */
  app.get("/api/nas", async (_req, reply) => {
    const read = nasReader(cfg);
    if (!read)
      return reply.code(404).send({
        ok: false,
        message: "NAS mode is off: set DASH_NAS_URL and DASH_NAS_TOKEN, or DASH_NAS_SOCKET",
      });
    return sampler.nas ?? (await read());
  });

  // ---- checks, events, alerts ----
  app.get("/api/checks", async (): Promise<CheckResult[]> =>
    sampler.checker.list(),
  );
  app.post("/api/checks/run", async (): Promise<CheckResult[]> => {
    const r = await sampler.checker.runAll();
    sampler.poke();
    return r;
  });

  app.get<{ Querystring: { container?: string; limit?: string } }>(
    "/api/events",
    async (req): Promise<DockerEvent[]> => {
      const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 200));
      return sampler.events.list(limit, req.query.container || undefined);
    },
  );

  app.get("/api/alerts", async (): Promise<AlertsInfo> =>
    sampler.notifier.info(),
  );

  // ---- web push ----
  app.get("/api/push", async (): Promise<PushSubscriptionInfo> =>
    sampler.push.info(),
  );
  app.post<{
    Body: { endpoint: string; keys: { p256dh: string; auth: string } };
  }>("/api/push/subscribe", async (req, reply): Promise<ActionResult> => {
    try {
      sampler.push.subscribe(req.body, {
        ua: req.headers["user-agent"],
        email: req.identity.email,
      });
    } catch (e) {
      return reply.code(400).send({ ok: false, message: (e as Error).message });
    }
    return {
      ok: true,
      message: `This device will receive alerts (${sampler.push.count()} device${sampler.push.count() === 1 ? "" : "s"} total)`,
    };
  });
  app.post<{ Body: { endpoint: string } }>(
    "/api/push/unsubscribe",
    async (req): Promise<ActionResult> => {
      const removed = sampler.push.unsubscribe(req.body?.endpoint ?? "");
      return {
        ok: true,
        message: removed
          ? "This device will no longer receive alerts"
          : "Device was not subscribed",
      };
    },
  );
  app.post("/api/notify/test", async (_req, reply): Promise<ActionResult> => {
    const r = await sampler.notifier.test();
    if (!r.ok) return reply.code(502).send(r);
    return r;
  });
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}
