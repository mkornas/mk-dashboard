/**
 * NAS mode: the mk-nas agent's socket (DASH_NAS_SOCKET) answers a read-only
 * `health` verb — pools, disks, problems. One request per connection,
 * newline-delimited JSON; nothing here can change anything on the NAS.
 * A NAS on another box is asked through its mk-drive instead (DASH_NAS_URL):
 * `GET /api/nas/monitor` with the drive's monitor token, the same answer.
 */
import { connect } from "node:net";
import type { Config } from "./config.ts";
import type { Alert, NasHealth, NasInfo } from "../../shared/types.ts";

export type { NasHealth, NasInfo };

function call<T>(socket: string, verb: string, timeoutMs = 20_000): Promise<T> {
  return new Promise((resolve, reject) => {
    let buf = "";
    let done = false;
    const sock = connect(socket);
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      fn();
    };
    const timer = setTimeout(
      () =>
        finish(() => reject(new Error("the NAS agent did not answer in time"))),
      timeoutMs,
    );
    sock.setEncoding("utf8");
    sock.on("connect", () =>
      sock.write(JSON.stringify({ id: 1, verb }) + "\n"),
    );
    sock.on("data", (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      let res: { ok: boolean; result?: T; error?: { message: string } };
      try {
        res = JSON.parse(buf.slice(0, nl));
      } catch {
        return finish(() =>
          reject(new Error("the NAS agent sent something that is not JSON")),
        );
      }
      finish(() =>
        res.ok
          ? resolve(res.result as T)
          : reject(new Error(res.error?.message ?? "refused")),
      );
    });
    sock.on("error", (e: NodeJS.ErrnoException) =>
      finish(() =>
        reject(
          new Error(
            e.code === "ENOENT" || e.code === "ECONNREFUSED"
              ? "the NAS agent is not running"
              : e.code === "EACCES"
                ? "no access to the NAS socket (join the mk-nas group)"
                : e.message,
          ),
        ),
      ),
    );
    sock.on("close", () =>
      finish(() => reject(new Error("the NAS agent closed the connection"))),
    );
  });
}

type NasAnswer = { health: NasHealth; agent: string; hostname: string };

export function readNas(socket: string): Promise<NasInfo> {
  return settle(async () => {
    const [health, version] = await Promise.all([
      call<NasHealth>(socket, "health"),
      call<{ agent: string; hostname: string }>(socket, "version"),
    ]);
    return { health, agent: version.agent, hostname: version.hostname };
  });
}

/** The same answer from a mk-drive in NAS mode: its read-only monitor route, with the token it was given. */
export function readNasOverHttp(
  base: string,
  token: string,
  timeoutMs = 20_000,
): Promise<NasInfo> {
  return settle(async () => {
    let res: Response;
    try {
      res = await fetch(`${base.replace(/\/+$/, "")}/api/nas/monitor`, {
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const err = e as Error & { cause?: NodeJS.ErrnoException };
      throw new Error(
        err.name === "TimeoutError"
          ? "the drive did not answer in time"
          : err.cause?.code === "ECONNREFUSED"
            ? "the drive refused the connection"
            : err.cause?.code === "ENOTFOUND" || err.cause?.code === "EAI_AGAIN"
              ? "DNS lookup failed"
              : (err.cause?.message ?? err.message),
      );
    }
    if (res.ok) return (await res.json()) as NasAnswer;
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(
      res.status === 401
        ? "the drive refused the token (DASH_NAS_TOKEN must match its DRIVE_NAS_MONITOR_TOKEN)"
        : res.status === 404
          ? "the drive has no monitor route (set DRIVE_NAS_MONITOR_TOKEN there, 32+ characters)"
          : (body?.message ?? `HTTP ${res.status}`),
    );
  });
}

/** How this dashboard asks its NAS, or null when NAS mode is off: the drive over HTTP wins over a local socket. */
export function nasReader(
  cfg: Pick<Config, "nasUrl" | "nasToken" | "nasSocket">,
): (() => Promise<NasInfo>) | null {
  if (cfg.nasUrl) return () => readNasOverHttp(cfg.nasUrl, cfg.nasToken);
  if (cfg.nasSocket) return () => readNas(cfg.nasSocket);
  return null;
}

async function settle(ask: () => Promise<NasAnswer>): Promise<NasInfo> {
  const at = Date.now();
  try {
    const { health, agent, hostname } = await ask();
    return { reachable: true, error: null, health, agent, hostname, at };
  } catch (e) {
    return {
      reachable: false,
      error: (e as Error).message,
      health: null,
      agent: null,
      hostname: null,
      at,
    };
  }
}

/** What the NAS says, as alerts: the agent already decided what is a problem; unreachable is one too. */
export function nasAlerts(nas: NasInfo | null): Alert[] {
  if (!nas) return [];
  if (!nas.reachable)
    return [
      {
        level: "warning",
        title: "The NAS agent is unreachable",
        detail: nas.error ?? undefined,
        link: "/nas",
      },
    ];
  const out: Alert[] = [];
  for (const p of nas.health?.pools ?? []) {
    if (p.health !== "ONLINE")
      out.push({
        level: p.health === "DEGRADED" ? "warning" : "danger",
        title: `Pool ${p.name} is ${p.health}`,
        detail: nas.health?.problems.find((x) =>
          x.startsWith(`Pool ${p.name} `),
        ),
        link: "/nas",
      });
    else if (p.capacity >= 90)
      out.push({
        level: "warning",
        title: `Pool ${p.name} is ${p.capacity}% full`,
        link: "/nas",
      });
  }
  for (const d of nas.health?.disks ?? [])
    if (!d.ok)
      out.push({
        level: "danger",
        title: `Disk ${d.id}: ${d.reason ?? "not healthy"}`,
        link: "/nas",
      });
  return out;
}
