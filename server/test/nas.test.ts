/** NAS mode: the agent's health as alerts, the socket client against a fake agent, and the drive's monitor route. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  nasAlerts,
  nasReader,
  readNas,
  readNasOverHttp,
  type NasInfo,
} from "../src/nas.ts";

const info = (over: Partial<NasInfo>): NasInfo => ({
  reachable: true,
  error: null,
  agent: "0.1.0",
  hostname: "nas",
  at: 0,
  health: { ok: true, pools: [], disks: [], problems: [] },
  ...over,
});

test("alerts: nothing when all is well, one per bad pool or disk, one when unreachable", () => {
  assert.deepEqual(nasAlerts(null), []);
  assert.deepEqual(nasAlerts(info({})), []);
  const bad = nasAlerts(
    info({
      health: {
        ok: false,
        pools: [
          { name: "tank", health: "DEGRADED", capacity: 12, ok: false },
          { name: "full", health: "ONLINE", capacity: 93, ok: false },
        ],
        disks: [{ id: "ata-X", ok: false, reason: "2 pending sectors" }],
        problems: [
          "Pool tank is DEGRADED (ata-Y UNAVAIL) — Replace the device using 'zpool replace'.",
        ],
      },
    }),
  );
  assert.deepEqual(
    bad.map((a) => [a.level, a.title]),
    [
      ["warning", "Pool tank is DEGRADED"],
      ["warning", "Pool full is 93% full"],
      ["danger", "Disk ata-X: 2 pending sectors"],
    ],
  );
  assert.match(bad[0].detail ?? "", /zpool replace/);
  const down = nasAlerts(
    info({
      reachable: false,
      error: "the NAS agent is not running",
      health: null,
    }),
  );
  assert.equal(down[0].title, "The NAS agent is unreachable");
});

test("readNas: talks NDJSON to the socket, and says why when it cannot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mk-dash-nas-"));
  const sock = join(dir, "a.sock");
  const server = createServer((c) => {
    c.setEncoding("utf8");
    c.on("data", (d: string) => {
      const req = JSON.parse(d) as { id: number; verb: string };
      const result =
        req.verb === "health"
          ? {
              ok: true,
              pools: [
                { name: "tank", health: "ONLINE", capacity: 1, ok: true },
              ],
              disks: [],
              problems: [],
            }
          : { agent: "0.1.0", hostname: "vm" };
      c.write(JSON.stringify({ id: req.id, ok: true, result }) + "\n");
    });
  });
  await new Promise<void>((r) => server.listen(sock, () => r()));
  try {
    const n = await readNas(sock);
    assert.equal(n.reachable, true);
    assert.equal(n.hostname, "vm");
    assert.equal(n.health?.pools[0].name, "tank");
    const gone = await readNas(join(dir, "absent.sock"));
    assert.equal(gone.reachable, false);
    assert.match(gone.error ?? "", /not running/);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("readNasOverHttp: the drive's monitor route with the token, and why not when refused", async () => {
  const TOKEN = "t".repeat(40);
  let status = 200;
  const server = createHttpServer((req, res) => {
    assert.equal(req.url, "/api/nas/monitor");
    if (status === 200 && req.headers.authorization !== `Bearer ${TOKEN}`) status = 401;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(
      JSON.stringify(
        status === 200
          ? {
              health: { ok: true, pools: [{ name: "tank", health: "ONLINE", capacity: 3, ok: true }], disks: [], problems: [] },
              agent: "0.7.1",
              hostname: "mk-nas",
            }
          : { ok: false, message: "the NAS agent is not running" },
      ),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  try {
    const n = await readNasOverHttp(base, TOKEN);
    assert.equal(n.reachable, true);
    assert.equal(n.hostname, "mk-nas");
    assert.equal(n.agent, "0.7.1");
    assert.equal(n.health?.pools[0].name, "tank");

    const refused = await readNasOverHttp(base, "wrong");
    assert.equal(refused.reachable, false);
    assert.match(refused.error ?? "", /refused the token/);
    status = 404;
    assert.match((await readNasOverHttp(base, TOKEN)).error ?? "", /no monitor route/);
    status = 503;
    assert.equal((await readNasOverHttp(base, TOKEN)).error, "the NAS agent is not running", "the drive's own reason");
  } finally {
    // close() leaves fetch's keep-alive socket open; a request on it would fail as a reset instead of a refusal
    const closed = new Promise<void>((r) => server.close(() => r()));
    server.closeAllConnections();
    await closed;
  }
  const gone = await readNasOverHttp(base, TOKEN);
  assert.equal(gone.reachable, false);
  assert.match(gone.error ?? "", /refused the connection/);
});

test("nasReader: off without the drive or the socket", () => {
  assert.equal(nasReader({ nasUrl: "", nasToken: "", nasSocket: "" }), null);
  assert.ok(nasReader({ nasUrl: "", nasToken: "", nasSocket: "/run/mk-nas.sock" }));
  assert.ok(nasReader({ nasUrl: "http://nas:8810", nasToken: "x", nasSocket: "" }));
});
