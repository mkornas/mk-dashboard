/**
 * Host metrics straight from procfs / sysfs. Inside the container these are
 * the host's trees bind-mounted read-only at HOST_PROC / HOST_SYS / HOST_ROOT.
 */
import { readFile, readdir, stat, statfs } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import type { Config } from './config.ts';
import type {
  CpuSample,
  DiskUsage,
  HostInfo,
  HostSample,
  LoadSample,
  MemorySample,
  NetInterface,
  Temperature,
} from '../../shared/types.ts';

async function text(path: string): Promise<string> {
  return readFile(path, 'utf8');
}

async function tryText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// ---------- CPU ----------

export interface CpuTimes {
  total: number;
  idle: number;
  iowait: number;
  steal: number;
}

/** Parse /proc/stat into aggregate + per-core jiffies. */
export function parseProcStat(content: string): { all: CpuTimes; cores: CpuTimes[] } {
  const cores: CpuTimes[] = [];
  let all: CpuTimes = { total: 0, idle: 0, iowait: 0, steal: 0 };
  for (const line of content.split('\n')) {
    if (!line.startsWith('cpu')) continue;
    const parts = line.trim().split(/\s+/);
    const name = parts[0];
    const n = parts.slice(1).map((x) => Number(x) || 0);
    const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = n;
    const t: CpuTimes = {
      total: user + nice + system + idle + iowait + irq + softirq + steal,
      idle: idle + iowait,
      iowait,
      steal,
    };
    if (name === 'cpu') all = t;
    else cores.push(t);
  }
  return { all, cores };
}

function busyPercent(prev: CpuTimes | undefined, cur: CpuTimes): number {
  if (!prev) return 0;
  const dt = cur.total - prev.total;
  if (dt <= 0) return 0;
  const di = cur.idle - prev.idle;
  return clamp(((dt - di) / dt) * 100);
}

function ratioPercent(prev: CpuTimes | undefined, cur: CpuTimes, key: 'iowait' | 'steal'): number {
  if (!prev) return 0;
  const dt = cur.total - prev.total;
  if (dt <= 0) return 0;
  return clamp(((cur[key] - prev[key]) / dt) * 100);
}

function clamp(n: number, lo = 0, hi = 100): number {
  return Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : 0));
}

// ---------- memory ----------

export function parseMeminfo(content: string): MemorySample {
  const kv: Record<string, number> = {};
  for (const line of content.split('\n')) {
    const m = /^(\w+):\s+(\d+)/.exec(line);
    if (m) kv[m[1]] = Number(m[2]) * 1024;
  }
  const total = kv.MemTotal ?? 0;
  const available = kv.MemAvailable ?? kv.MemFree ?? 0;
  const used = Math.max(0, total - available);
  const swapTotal = kv.SwapTotal ?? 0;
  const swapUsed = Math.max(0, swapTotal - (kv.SwapFree ?? 0));
  return {
    total,
    used,
    available,
    buffers: kv.Buffers ?? 0,
    cached: (kv.Cached ?? 0) + (kv.SReclaimable ?? 0),
    swapTotal,
    swapUsed,
    percent: total ? clamp((used / total) * 100) : 0,
  };
}

// ---------- load ----------

export function parseLoadavg(content: string): LoadSample {
  const [one, five, fifteen, procs] = content.trim().split(/\s+/);
  const [running, threads] = (procs ?? '0/0').split('/');
  return {
    one: Number(one) || 0,
    five: Number(five) || 0,
    fifteen: Number(fifteen) || 0,
    running: Number(running) || 0,
    threads: Number(threads) || 0,
  };
}

// ---------- network ----------

const IGNORED_IFACES = /^(lo|veth|br-|docker|virbr|tailscale|wg|tun|tap|cni|flannel)/;

export function parseNetDev(content: string): Array<{ name: string; rxBytes: number; txBytes: number }> {
  const out: Array<{ name: string; rxBytes: number; txBytes: number }> = [];
  for (const line of content.split('\n')) {
    const m = /^\s*([^:\s]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const name = m[1];
    if (IGNORED_IFACES.test(name)) continue;
    const f = m[2].trim().split(/\s+/).map(Number);
    // rx: bytes packets errs drop fifo frame compressed multicast | tx: bytes ...
    out.push({ name, rxBytes: f[0] || 0, txBytes: f[8] || 0 });
  }
  return out;
}

// ---------- disks ----------

const REAL_FS = new Set(['ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'zfs', 'f2fs', 'vfat', 'exfat', 'ntfs', 'ntfs3', 'fuseblk', 'nfs', 'nfs4', 'cifs']);

export function parseMounts(content: string, ignore: string[]): Array<{ device: string; mount: string; fstype: string }> {
  const seen = new Map<string, { device: string; mount: string; fstype: string }>();
  for (const line of content.split('\n')) {
    const [device, rawMount, fstype] = line.split(' ');
    if (!device || !rawMount || !fstype) continue;
    if (!REAL_FS.has(fstype)) continue;
    const mount = rawMount.replace(/\\040/g, ' ');
    if (ignore.some((p) => mount === p || mount.startsWith(p + '/'))) continue;
    if (mount.startsWith('/var/lib/docker/') || mount.startsWith('/snap/')) continue;
    // one entry per device: keep the shortest mountpoint (bind mounts repeat the device)
    const prev = seen.get(device);
    if (!prev || mount.length < prev.mount.length) seen.set(device, { device, mount, fstype });
  }
  return [...seen.values()].sort((a, b) => a.mount.localeCompare(b.mount));
}

// ---------- temperatures ----------

async function readHwmon(sysDir: string): Promise<Temperature[]> {
  const out: Temperature[] = [];
  const base = join(sysDir, 'class/hwmon');
  let dirs: string[] = [];
  try {
    dirs = await readdir(base);
  } catch {
    return out;
  }
  for (const d of dirs) {
    const dir = join(base, d);
    const chip = ((await tryText(join(dir, 'name'))) ?? d).trim();
    let files: string[] = [];
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      const m = /^temp(\d+)_input$/.exec(f);
      if (!m) continue;
      const raw = await tryText(join(dir, f));
      const v = Number(raw);
      // ≤ 0 or absurd readings are unpopulated sensor slots (e.g. an NVMe "Sensor 1" at -0.1)
      if (!raw || !Number.isFinite(v) || v <= 0 || v > 200_000) continue;
      const label = ((await tryText(join(dir, `temp${m[1]}_label`))) ?? '').trim();
      const high = Number(await tryText(join(dir, `temp${m[1]}_max`)));
      const crit = Number(await tryText(join(dir, `temp${m[1]}_crit`)));
      out.push({
        chip,
        label: label || `temp${m[1]}`,
        celsius: Math.round(v / 100) / 10,
        high: Number.isFinite(high) && high > 0 ? high / 1000 : undefined,
        critical: Number.isFinite(crit) && crit > 0 ? crit / 1000 : undefined,
      });
    }
  }
  return out;
}

// ---------- the reader ----------

export class HostReader {
  private prevCpu?: { all: CpuTimes; cores: CpuTimes[] };
  private prevNet?: { t: number; ifaces: Map<string, { rxBytes: number; txBytes: number }> };
  private infoCache?: HostInfo;
  private readonly cfg: Config;

  constructor(cfg: Config) {
    this.cfg = cfg;
  }

  private get proc(): string {
    return this.cfg.hostProc;
  }

  /** PID 1's view — /proc/net and /proc/mounts are per-namespace, PID 1 lives in the host's. */
  private async procNs(file: string): Promise<string> {
    const viaPid1 = await tryText(join(this.proc, '1', file));
    if (viaPid1 !== null) return viaPid1;
    return text(join(this.proc, file));
  }

  async info(): Promise<HostInfo> {
    if (this.infoCache) return this.infoCache;
    const hostname =
      this.cfg.hostName || ((await tryText(join(this.proc, 'sys/kernel/hostname'))) ?? os.hostname()).trim();
    const kernel = ((await tryText(join(this.proc, 'sys/kernel/osrelease'))) ?? os.release()).trim();
    const osRelease = (await tryText(join(this.cfg.hostRoot, 'etc/os-release'))) ?? '';
    const pretty = /^PRETTY_NAME="?([^"\n]*)"?/m.exec(osRelease)?.[1] ?? `${os.type()} ${os.release()}`;
    const cpuinfo = (await tryText(join(this.proc, 'cpuinfo'))) ?? '';
    const cpuModel = /^model name\s*:\s*(.*)$/m.exec(cpuinfo)?.[1]?.trim() ?? os.cpus()[0]?.model ?? 'unknown';
    const cpuCount = (cpuinfo.match(/^processor\s*:/gm) ?? []).length || os.cpus().length;
    const uptime = Number((await tryText(join(this.proc, 'uptime')))?.split(' ')[0]) || os.uptime();
    const info: HostInfo = {
      hostname,
      os: pretty,
      kernel,
      arch: os.arch(),
      cpuModel,
      cpuCount,
      bootedAt: Date.now() - uptime * 1000,
      rebootRequired: await exists(join(this.cfg.hostRoot, 'var/run/reboot-required')),
    };
    this.infoCache = info;
    // refresh occasionally (reboot-required can flip)
    setTimeout(() => (this.infoCache = undefined), 5 * 60_000).unref();
    return info;
  }

  async sample(): Promise<HostSample> {
    const t = Date.now();
    const [statRaw, memRaw, loadRaw, uptimeRaw, netRaw, mountsRaw, temps] = await Promise.all([
      text(join(this.proc, 'stat')),
      text(join(this.proc, 'meminfo')),
      text(join(this.proc, 'loadavg')),
      text(join(this.proc, 'uptime')),
      this.procNs('net/dev').catch(() => ''),
      this.procNs('mounts').catch(() => ''),
      readHwmon(this.cfg.hostSys),
    ]);

    const cpuNow = parseProcStat(statRaw);
    const cpu: CpuSample = {
      percent: busyPercent(this.prevCpu?.all, cpuNow.all),
      cores: cpuNow.cores.map((c, i) => busyPercent(this.prevCpu?.cores[i], c)),
      iowait: ratioPercent(this.prevCpu?.all, cpuNow.all, 'iowait'),
      steal: ratioPercent(this.prevCpu?.all, cpuNow.all, 'steal'),
    };
    this.prevCpu = cpuNow;

    const ifaces = parseNetDev(netRaw);
    const dt = this.prevNet ? (t - this.prevNet.t) / 1000 : 0;
    const net: NetInterface[] = ifaces.map((i) => {
      const p = this.prevNet?.ifaces.get(i.name);
      const rate = (cur: number, prev?: number) => (p && dt > 0 && prev !== undefined && cur >= prev ? (cur - prev) / dt : 0);
      return { name: i.name, rxBytes: i.rxBytes, txBytes: i.txBytes, rxRate: rate(i.rxBytes, p?.rxBytes), txRate: rate(i.txBytes, p?.txBytes) };
    });
    this.prevNet = { t, ifaces: new Map(ifaces.map((i) => [i.name, i])) };

    const disks: DiskUsage[] = [];
    for (const m of parseMounts(mountsRaw, this.cfg.ignoreMounts)) {
      try {
        const s = await statfs(join(this.cfg.hostRoot, m.mount));
        const total = s.blocks * s.bsize;
        const free = s.bavail * s.bsize;
        const used = (s.blocks - s.bfree) * s.bsize;
        if (total <= 0) continue;
        disks.push({ ...m, total, used, free, percent: clamp((used / (used + free)) * 100) });
      } catch {
        /* not visible from here */
      }
    }

    return {
      t,
      uptime: Number(uptimeRaw.split(' ')[0]) || 0,
      cpu,
      memory: parseMeminfo(memRaw),
      load: parseLoadavg(loadRaw),
      temperatures: temps,
      disks,
      net,
      netRxRate: net.reduce((a, n) => a + n.rxRate, 0),
      netTxRate: net.reduce((a, n) => a + n.txRate, 0),
    };
  }
}
