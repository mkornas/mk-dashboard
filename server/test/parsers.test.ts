import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLoadavg, parseMeminfo, parseMounts, parseNetDev, parseProcStat } from '../src/host.ts';
import { LogDemuxer, NdjsonParser } from '../src/docker.ts';
import { computeStats, healthOf, redactEnv } from '../src/containers.ts';

test('parseProcStat: aggregate and per-core', () => {
  const r = parseProcStat('cpu  100 0 50 800 20 0 0 0 0 0\ncpu0 50 0 25 400 10 0 0 0 0 0\ncpu1 50 0 25 400 10 0 0 0 0 0\nintr 1\n');
  assert.equal(r.all.total, 970);
  assert.equal(r.all.idle, 820);
  assert.equal(r.cores.length, 2);
});

test('parseMeminfo: used = total - available', () => {
  const m = parseMeminfo('MemTotal:       32000000 kB\nMemFree:         1000000 kB\nMemAvailable:   30000000 kB\nSwapTotal:       4000000 kB\nSwapFree:        3000000 kB\nCached: 500 kB\n');
  assert.equal(m.total, 32000000 * 1024);
  assert.equal(m.used, 2000000 * 1024);
  assert.equal(m.swapUsed, 1000000 * 1024);
  assert.ok(m.percent > 6 && m.percent < 7);
});

test('parseLoadavg', () => {
  assert.deepEqual(parseLoadavg('0.52 0.40 0.30 2/612 12345\n'), { one: 0.52, five: 0.4, fifteen: 0.3, running: 2, threads: 612 });
});

test('parseNetDev skips virtual interfaces', () => {
  const raw = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo:  100 1 0 0 0 0 0 0 100 1 0 0 0 0 0 0
enp1s0: 5000 10 0 0 0 0 0 0 7000 12 0 0 0 0 0 0
veth12: 1 1 0 0 0 0 0 0 1 1 0 0 0 0 0 0
docker0: 1 1 0 0 0 0 0 0 1 1 0 0 0 0 0 0
`;
  assert.deepEqual(parseNetDev(raw), [{ name: 'enp1s0', rxBytes: 5000, txBytes: 7000 }]);
});

test('parseMounts keeps one real fs per device, shortest mountpoint', () => {
  const raw = `/dev/nvme0n1p1 / ext4 rw 0 0
/dev/nvme0n1p1 /srv/x ext4 rw 0 0
tmpfs /run tmpfs rw 0 0
overlay /var/lib/docker/overlay2/abc/merged overlay rw 0 0
/dev/sda1 /mnt/data\\040disk xfs rw 0 0
/dev/sdb1 /boot/efi vfat rw 0 0
`;
  const m = parseMounts(raw, ['/boot/efi']);
  assert.deepEqual(m.map((x) => x.mount), ['/', '/mnt/data disk']);
});

test('LogDemuxer handles framed and split chunks', () => {
  const d = new LogDemuxer(false);
  const frame = (type: number, s: string) => {
    const h = Buffer.alloc(8);
    h[0] = type;
    h.writeUInt32BE(Buffer.byteLength(s), 4);
    return Buffer.concat([h, Buffer.from(s)]);
  };
  const all = Buffer.concat([frame(1, 'hello\nwor'), frame(2, 'ld\n')]);
  const lines = [...d.push(all.subarray(0, 12)), ...d.push(all.subarray(12))];
  assert.deepEqual(lines, ['hello', 'world']);
  assert.deepEqual(d.flush(), []);
});

test('LogDemuxer tty passthrough', () => {
  const d = new LogDemuxer(true);
  assert.deepEqual(d.push(Buffer.from('a\r\nb')), ['a']);
  assert.deepEqual(d.flush(), ['b']);
});

test('NdjsonParser', () => {
  const p = new NdjsonParser<{ a: number }>();
  assert.deepEqual(p.push(Buffer.from('{"a":1}\n{"a":')), [{ a: 1 }]);
  assert.deepEqual(p.push(Buffer.from('2}\n')), [{ a: 2 }]);
});

test('healthOf', () => {
  assert.equal(healthOf('Up 3 hours (healthy)'), 'healthy');
  assert.equal(healthOf('Up 3 seconds (health: starting)'), 'starting');
  assert.equal(healthOf('Exited (0) 2 days ago'), 'none');
});

test('computeStats uses the previous sample for CPU', () => {
  const s = {
    read: '',
    cpu_stats: { cpu_usage: { total_usage: 2_000_000 }, system_cpu_usage: 100_000_000, online_cpus: 4 },
    precpu_stats: { cpu_usage: { total_usage: 0 }, system_cpu_usage: 0 },
    memory_stats: { usage: 100_000, limit: 1_000_000, stats: { inactive_file: 20_000 } },
    networks: { eth0: { rx_bytes: 1000, tx_bytes: 500 } },
  };
  const first = computeStats(s, undefined, 1000);
  assert.equal(first.stats.cpuPercent, 0);
  assert.equal(first.stats.memUsage, 80_000);
  const second = computeStats({ ...s, cpu_stats: { cpu_usage: { total_usage: 3_000_000 }, system_cpu_usage: 110_000_000, online_cpus: 4 }, networks: { eth0: { rx_bytes: 3000, tx_bytes: 500 } } }, first.prev, 2000);
  assert.equal(second.stats.cpuPercent, 40);
  assert.equal(second.stats.netRxRate, 2000);
});

test('redactEnv hides secrets', () => {
  const r = redactEnv(['PORT=80', 'API_TOKEN=abc', 'EMPTY_SECRET=']);
  assert.deepEqual(r.map((e) => [e.key, e.redacted]), [['PORT', false], ['API_TOKEN', true], ['EMPTY_SECRET', false]]);
  assert.equal(r[1].value, '••••••••');
});

test('parseLastRuns picks the newest log line per app', async () => {
  const { parseLastRuns } = await import('../src/backups.ts');
  const m = parseLastRuns(['2026-09-08T06:30:01+02:00 wiki: 1M', '2026-09-08T12:30:01+02:00 wiki: 1M', '2026-09-08T12:30:02+02:00 ok', 'garbage']);
  assert.equal(m.get('wiki'), Date.parse('2026-09-08T12:30:01+02:00'));
  assert.equal(m.has('ok'), false);
});

test('toEvent classifies docker events', async () => {
  const { toEvent } = await import('../src/events.ts');
  const die = toEvent({ Type: 'container', Action: 'die', timeNano: 1_700_000_000_000_000_000, Actor: { ID: 'abc', Attributes: { name: 'web', exitCode: '1', 'com.docker.compose.project': 'shop' } } });
  assert.equal(die?.level, 'warning');
  assert.equal(die?.stack, 'shop');
  assert.equal(toEvent({ Action: 'die', Actor: { Attributes: { name: 'web', exitCode: '0' } } })?.level, 'info');
  assert.equal(toEvent({ Action: 'oom', Actor: { Attributes: { name: 'web' } } })?.level, 'danger');
  assert.equal(toEvent({ Action: 'health_status: unhealthy', Actor: { Attributes: { name: 'web' } } })?.action, 'health');
  assert.equal(toEvent({ Action: 'exec_start: /bin/sh', Actor: { Attributes: { name: 'web' } } }), null);
});

test('Notifier confirms an alert only after notifyAfterMs and records both transitions', async () => {
  const { Notifier } = await import('../src/notify.ts');
  const { config } = await import('../src/config.ts');
  const { PushService } = await import('../src/push.ts');
  const cfg = { ...config, dataDir: '', notifyAfterMs: 1000, telegramToken: '', webhookUrl: '', vapidPublic: '', vapidPrivate: '' };
  const n = new Notifier(cfg, new PushService(cfg));
  const a = { level: 'danger' as const, title: 'x is down' };
  n.update([a], 0);
  assert.equal(n.info().history.length, 0);
  n.update([a], 500);
  assert.equal(n.info().history.length, 0);
  n.update([a], 1500);
  assert.deepEqual(n.info().history.map((h) => h.type), ['raised']);
  n.update([], 2000);
  assert.deepEqual(n.info().history.map((h) => h.type), ['cleared', 'raised']);
  assert.equal(n.info().active.length, 0);
});

test('a push subscription must name an https push service, not an address of the caller\'s choosing', async () => {
  const { PushService, isPushEndpoint } = await import('../src/push.ts');
  const { config } = await import('../src/config.ts');
  const { mkdtemp, stat } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  assert.equal(isPushEndpoint('https://fcm.googleapis.com/fcm/send/abc'), true);
  for (const bad of ['http://127.0.0.1:8800/api/x', 'file:///etc/passwd', 'https://user:pw@push.example/', 'nope', 'https://x/' + 'a'.repeat(3000)]) assert.equal(isPushEndpoint(bad), false, bad);
  const dataDir = await mkdtemp(join(tmpdir(), 'mk-dash-push-'));
  const push = new PushService({ ...config, dataDir, vapidPublic: '', vapidPrivate: '' });
  assert.throws(() => push.subscribe({ endpoint: 'http://internal:8080/v1/update', keys: { p256dh: 'p', auth: 'a' } }, {}), /https/);
  assert.equal(push.count(), 0);
  assert.equal((await stat(join(dataDir, 'push.json'))).mode & 0o777, 0o600, 'the file with the VAPID private key is private');
});

test('checkAlerts: down and expiring certificates', async () => {
  const { checkAlerts } = await import('../src/sampler.ts');
  const { config } = await import('../src/config.ts');
  const base = { kind: 'http' as const, target: 't', auto: false, checkedAt: 0, since: 0 };
  const alerts = checkAlerts([{ ...base, name: 'a', up: false, error: 'timeout' }, { ...base, name: 'b', up: true, certDaysLeft: 5 }, { ...base, name: 'c', up: true, certDaysLeft: 60 }], config);
  assert.deepEqual(alerts.map((x) => [x.title, x.level]), [['a is unreachable', 'danger'], ['Certificate for b expires in 5 days', 'warning']]);
});

test('cleanError shortens OpenSSL noise', async () => {
  const { cleanError } = await import('../src/checks.ts');
  assert.equal(cleanError(new Error('404D:error:0A000438:SSL routines:ssl3_read_bytes:tlsv1 alert internal error:../deps/x.c:918:SSL alert number 80\n')), 'TLS handshake failed (tlsv1 alert internal error)');
  assert.equal(cleanError(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })), 'connection refused');
});

test('ipInCidr / clientIp', async () => {
  const { ipInCidr, isTrusted } = await import('../src/auth.ts');
  assert.equal(ipInCidr('192.168.1.5', '192.168.0.0/16'), true);
  assert.equal(ipInCidr('192.169.0.1', '192.168.0.0/16'), false);
  assert.equal(ipInCidr('::ffff:10.1.2.3', '10.0.0.0/8'), true);
  assert.equal(ipInCidr('172.18.0.5', '172.16.0.0/12'), true);
  assert.equal(ipInCidr('::1', '::1/128'), true);
  assert.equal(isTrusted('8.8.8.8', ['192.168.0.0/16', '10.0.0.0/8']), false);
});

test('the Access verifier (from @mk-kit/auth) rejects malformed and wrong-algorithm tokens without network', async () => {
  const { createAccessVerifier } = await import('@mk-kit/auth/server');
  const v = createAccessVerifier({ team: 'myteam', aud: 'aud123' });
  assert.equal(v.issuer, 'https://myteam.cloudflareaccess.com');
  await assert.rejects(() => v.verify('nope'), /malformed/i);
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  await assert.rejects(() => v.verify(`${b64({ alg: 'HS256', kid: 'x' })}.${b64({})}.sig`), /alg/i);
});
