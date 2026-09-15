/**
 * Reachability checks: HTTP GET or TCP connect (optionally with TLS), on a
 * timer independent of the metrics sampler. HTTPS/TLS probes also read the
 * certificate so expiry can be alerted on before it bites.
 */
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import type { Config } from './config.ts';
import type { CheckConfig, CheckResult } from '../../shared/types.ts';

interface CertInfo {
  certExpiresAt?: number;
  certDaysLeft?: number;
  certIssuer?: string;
  certSubject?: string;
}

function certInfo(socket: tls.TLSSocket | undefined): CertInfo {
  const cert = socket?.getPeerCertificate?.();
  if (!cert || !cert.valid_to) return {};
  const exp = Date.parse(cert.valid_to);
  if (!Number.isFinite(exp)) return {};
  return {
    certExpiresAt: exp,
    certDaysLeft: Math.floor((exp - Date.now()) / 86_400_000),
    certIssuer: first(cert.issuer?.O) ?? first(cert.issuer?.CN),
    certSubject: first(cert.subject?.CN),
  };
}

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export function targetOf(c: CheckConfig): string {
  if (c.url) return c.url;
  return `${c.host}:${c.port ?? (c.tls ? 443 : 80)}${c.tls ? ' (tls)' : ''}`;
}

type Probe = Pick<CheckResult, 'up' | 'latencyMs' | 'status' | 'error'> & CertInfo;

/** OpenSSL errors are a wall of text; keep the human part. */
export function cleanError(e: Error): string {
  const msg = (e.message || String(e)).split('\n')[0];
  const ssl = /SSL routines:[^:]*:([^:]+):/.exec(msg);
  if (ssl) return `TLS handshake failed (${ssl[1].trim()})`;
  const code = (e as NodeJS.ErrnoException).code;
  if (code === 'ECONNREFUSED') return 'connection refused';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'DNS lookup failed';
  if (code === 'ECONNRESET') return 'connection reset';
  if (code === 'CERT_HAS_EXPIRED') return 'certificate has expired';
  if (code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'SELF_SIGNED_CERT_IN_CHAIN') return 'self-signed certificate (set insecure: true to accept)';
  if (code === 'ERR_TLS_CERT_ALTNAME_INVALID') return 'certificate does not match the hostname';
  return msg.length > 120 ? msg.slice(0, 117) + '…' : msg;
}

export function probeHttp(c: CheckConfig, timeoutMs: number): Promise<Probe> {
  return new Promise((resolve) => {
    const started = Date.now();
    let url: URL;
    try {
      url = new URL(c.url!);
    } catch {
      return resolve({ up: false, error: 'invalid url' });
    }
    const secure = url.protocol === 'https:';
    const lib = secure ? https : http;
    const req = lib.request(
      url,
      {
        method: 'GET',
        headers: { 'User-Agent': 'mk-dashboard/check', Accept: '*/*' },
        rejectUnauthorized: !c.insecure,
        servername: c.servername ?? url.hostname,
        timeout: timeoutMs,
        agent: false, // a fresh socket per probe, so the certificate is always readable
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const ok = c.expect?.length ? c.expect.includes(status) : status < 500;
        const info = secure ? certInfo(res.socket as tls.TLSSocket) : {};
        res.resume();
        resolve({ up: ok, status, latencyMs: Date.now() - started, error: ok ? undefined : `HTTP ${status}`, ...info });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ up: false, latencyMs: Date.now() - started, error: cleanError(e as Error) }));
    req.end();
  });
}

export function probeTcp(c: CheckConfig, timeoutMs: number): Promise<Probe> {
  return new Promise((resolve) => {
    const started = Date.now();
    const port = c.port ?? (c.tls ? 443 : 80);
    const host = c.host!;
    let done = false;
    const finish = (r: Probe) => {
      if (done) return;
      done = true;
      resolve(r);
    };
    const socket = c.tls
      ? tls.connect({ host, port, servername: c.servername ?? host, rejectUnauthorized: !c.insecure, timeout: timeoutMs })
      : net.connect({ host, port, timeout: timeoutMs });
    const onUp = () => {
      const info = c.tls ? certInfo(socket as tls.TLSSocket) : {};
      finish({ up: true, latencyMs: Date.now() - started, ...info });
      socket.destroy();
    };
    socket.once(c.tls ? 'secureConnect' : 'connect', onUp);
    socket.once('timeout', () => {
      finish({ up: false, latencyMs: Date.now() - started, error: 'timeout' });
      socket.destroy();
    });
    socket.once('error', (e) => finish({ up: false, latencyMs: Date.now() - started, error: cleanError(e as Error) }));
  });
}

export class Checker {
  private readonly cfg: Config;
  private readonly results = new Map<string, CheckResult>();
  private auto: CheckConfig[] = [];
  private timer?: NodeJS.Timeout;
  private running = false;
  private pending = false;

  constructor(cfg: Config) {
    this.cfg = cfg;
  }

  /** Checks derived from container labels; configured checks with the same name win. */
  setAutoChecks(list: CheckConfig[]): void {
    const names = new Set(this.cfg.checks.map((c) => c.name));
    const next = list.filter((c) => !names.has(c.name));
    const changed = next.length !== this.auto.length || next.some((c, i) => c.url !== this.auto[i]?.url || c.name !== this.auto[i]?.name);
    this.auto = next;
    if (changed) void this.runAll();
  }

  all(): Array<CheckConfig & { auto: boolean }> {
    return [...this.cfg.checks.map((c) => ({ ...c, auto: false })), ...this.auto.map((c) => ({ ...c, auto: true }))];
  }

  list(): CheckResult[] {
    const order = this.all().map((c) => c.name);
    return order.map((n) => this.results.get(n)).filter((r): r is CheckResult => !!r);
  }

  start(): void {
    if (this.all().length) void this.runAll();
    this.timer = setInterval(() => void this.runAll(), this.cfg.checkIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async runAll(): Promise<CheckResult[]> {
    if (this.running) {
      this.pending = true; // definitions changed mid-run: go again right after
      return this.list();
    }
    this.running = true;
    try {
      const defs = this.all();
      const live = new Set(defs.map((d) => d.name));
      for (const k of this.results.keys()) if (!live.has(k)) this.results.delete(k);
      await Promise.all(
        defs.map(async (c) => {
          const kind = c.kind ?? (c.url ? 'http' : 'tcp');
          const probe = kind === 'http' ? await probeHttp(c, this.cfg.checkTimeoutMs) : await probeTcp(c, this.cfg.checkTimeoutMs);
          const prev = this.results.get(c.name);
          const now = Date.now();
          this.results.set(c.name, {
            name: c.name,
            kind,
            target: targetOf(c),
            group: c.group,
            auto: c.auto,
            ...probe,
            checkedAt: now,
            since: prev && prev.up === probe.up ? prev.since : now,
          });
        }),
      );
      return this.list();
    } finally {
      this.running = false;
      if (this.pending) {
        this.pending = false;
        void this.runAll();
      }
    }
  }
}
