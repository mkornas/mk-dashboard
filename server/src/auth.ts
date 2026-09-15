/**
 * Who is asking? Four ways in:
 *  - through Cloudflare Access: the `Cf-Access-Jwt-Assertion` header (or the
 *    CF_Authorization cookie) carries a JWT signed by your team's keys — verified
 *    by `@mk-kit/auth` against https://<team>.cloudflareaccess.com/cdn-cgi/access/certs;
 *  - single sign-on: `/auth/login` went through the OpenID Connect provider and
 *    `/auth/callback` (sso.ts) set the signed `dash_session` cookie;
 *  - from a trusted network (LAN) with no token: allowed, as before;
 *  - optional basic auth (DASH_USER / DASH_PASSWORD) on top of everything.
 * Anything that came through Cloudflare (cf-ray present) must carry a valid
 * token or session — a LAN address in X-Forwarded-For does not count there.
 * With none of them configured, only the trusted networks get in.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type AccessVerifier, accessTokenFrom, verifyValue, viaCloudflare } from '@mk-kit/auth/server';
import type { Config } from './config.ts';

export interface Identity {
  /** Email from the Access token or the sign-in, the basic-auth user, or a label for the network path. */
  email: string;
  via: 'access' | 'sso' | 'lan' | 'basic' | 'open';
  /** Whether mutating actions are allowed for this identity. */
  canAct: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    identity: Identity;
  }
}

// ---------- CIDR matching (v4, v6 and v4-mapped v6) ----------

function ipToBytes(ip: string): Uint8Array | null {
  const v = isIP(ip);
  if (v === 4) return Uint8Array.from(ip.split('.').map(Number));
  if (v !== 6) return null;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return ipToBytes(mapped[1]);
  const [head, tail = ''] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  if (groups.length !== 8) return null;
  const out = new Uint8Array(16);
  groups.forEach((g, i) => {
    const n = parseInt(g || '0', 16);
    out[i * 2] = n >> 8;
    out[i * 2 + 1] = n & 0xff;
  });
  return out;
}

export function ipInCidr(ip: string, cidr: string): boolean {
  const [net, bitsRaw] = cidr.split('/');
  const a = ipToBytes(ip);
  const b = ipToBytes(net);
  if (!a || !b || a.length !== b.length) return false;
  const bits = bitsRaw === undefined ? a.length * 8 : Number(bitsRaw);
  for (let i = 0; i < a.length; i++) {
    const remaining = bits - i * 8;
    if (remaining <= 0) return true;
    const mask = remaining >= 8 ? 0xff : (0xff << (8 - remaining)) & 0xff;
    if ((a[i] & mask) !== (b[i] & mask)) return false;
  }
  return true;
}

export function isTrusted(ip: string, cidrs: string[]): boolean {
  return cidrs.some((c) => ipInCidr(ip, c));
}

/**
 * The real client address. Forwarding headers are believed only from a peer on a trusted network (a proxy):
 * Cloudflare's header, else X-Forwarded-For read from the right, past the trusted proxies that appended to it —
 * its leftmost entries are whatever the client chose to send.
 */
export function clientIp(req: FastifyRequest, cidrs: string[]): string {
  const peer = req.socket.remoteAddress ?? '';
  if (!isTrusted(peer, cidrs)) return peer;
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && isIP(cf)) return cf;
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff !== 'string') return peer;
  let ip = peer;
  for (const hop of xff.split(',').map((s) => s.trim()).reverse()) {
    if (!isIP(hop)) break;
    ip = hop;
    if (!isTrusted(hop, cidrs)) break;
  }
  return ip;
}

/**
 * The path a guard should judge: the route that matched (what will run), else the decoded path. A raw `req.url`
 * check is fooled by `/%61pi/…`, which the router decodes to `/api/…`. Null when the path does not decode.
 */
export function routePath(req: FastifyRequest): string | null {
  const route = req.routeOptions.url;
  if (route && route !== '/*') return route;
  try {
    return decodeURIComponent(req.url.split('?')[0]);
  } catch {
    return null;
  }
}

/**
 * Whether the browser reached us over TLS: directly, through Cloudflare (the tunnel
 * terminates TLS at the edge), or through a proxy whose first X-Forwarded-Proto says so.
 * trustProxy is off (clientIp() derives addresses itself), so this reads the headers directly.
 */
export function isSecure(req: FastifyRequest): boolean {
  if (req.protocol === 'https' || viaCloudflare(req.headers)) return true;
  const proto = req.headers['x-forwarded-proto'];
  return typeof proto === 'string' && proto.split(',')[0].trim() === 'https';
}

/** The origin the browser is on. */
export function origin(req: FastifyRequest): string {
  return `${isSecure(req) ? 'https' : 'http'}://${req.headers.host}`;
}

// ---------- password guessing ----------

/** Failures older than this (after their pause) are forgotten. */
const FORGET_MS = 15 * 60_000;

/** Slows down password guessing: after each failure an address waits, one second doubling up to 30. */
export class LoginThrottle {
  /** In order of the last failure, oldest first (a failure moves its key to the end). */
  private readonly failures = new Map<string, { count: number; until: number }>();
  private readonly maxKeys: number;

  constructor(maxKeys = 10_000) {
    this.maxKeys = maxKeys;
  }

  /** Milliseconds the caller must still wait, 0 when allowed. */
  retryAfter(key: string, now = Date.now()): number {
    const f = this.failures.get(key);
    return f && f.until > now ? f.until - now : 0;
  }

  failed(key: string, now = Date.now()): void {
    let f = this.failures.get(key);
    if (f && f.until + FORGET_MS < now) f = undefined;
    f ??= { count: 0, until: 0 };
    f.count += 1;
    f.until = now + Math.min(30_000, 1000 * 2 ** Math.min(f.count - 1, 5));
    this.failures.delete(key);
    this.failures.set(key, f);
    for (const k of this.failures.keys()) {
      if (this.failures.size <= this.maxKeys) break;
      this.failures.delete(k);
    }
  }

  succeeded(key: string): void {
    this.failures.delete(key);
  }
}

// ---------- the hook ----------

const SSO_COOKIE = 'dash_session';
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** A sign-in through the OpenID Connect provider lives in a signed, self-contained cookie — no session store. */
export interface SsoSession {
  email: string;
  exp: number;
  /** The provider's ID token: handed back at sign-out so the provider ends its session without asking again. */
  idToken?: string;
}

/** Who may sign in through the provider: DASH_OIDC_EMAILS, else DASH_ADMIN_EMAILS (lower-cased). */
export function ssoAllowList(cfg: Pick<Config, 'oidcEmails' | 'adminEmails'>): string[] {
  return (cfg.oidcEmails.length ? cfg.oidcEmails : cfg.adminEmails).map((e) => e.toLowerCase());
}

/** The SSO session behind a request's cookie, when its signature holds. */
export function ssoSession(req: FastifyRequest, secret: string): SsoSession | null {
  const s = verifyValue<SsoSession>(secret, cookie(req, SSO_COOKIE));
  return s?.email ? s : null;
}

/** Compares digests, so neither the content nor the length of the secret shows in the timing. */
function safeEqual(a: string, b: string): boolean {
  const digest = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(digest(a), digest(b));
}

export function cookie(req: FastifyRequest, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k !== name) continue;
    try {
      return decodeURIComponent(v.join('='));
    } catch {
      return undefined; // a malformed escape reads as no cookie, not as a 500 on every request
    }
  }
  return undefined;
}

/** The `Set-Cookie` value for a session (or, with maxAge 0, for signing out). */
export function ssoCookie(value: string, maxAge: number, secure: boolean): string {
  const attrs = [`${SSO_COOKIE}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

export function registerAuth(app: FastifyInstance, cfg: Config, verifier: AccessVerifier | null, ssoSecret: string | null): void {
  app.decorateRequest('identity', undefined as unknown as Identity);
  const admins = cfg.adminEmails.map((e) => e.toLowerCase());
  const canAct = (email: string, defaultAllow: boolean) => !cfg.readonly && (admins.length ? admins.includes(email.toLowerCase()) : defaultAllow);
  const deny = (reply: FastifyReply, code: number, message: string, extra?: Record<string, unknown>) => {
    if (code === 401 && cfg.user && cfg.password) reply.header('WWW-Authenticate', 'Basic realm="mk-dashboard", charset="UTF-8"');
    return reply.code(code).send({ ok: false, message, ...extra });
  };
  const gated = !!(verifier || ssoSecret);
  const ssoAllowed = ssoAllowList(cfg);
  const throttle = new LoginThrottle();

  app.addHook('onRequest', async (req, reply) => {
    const path = routePath(req) ?? req.url.split('?')[0];
    // Cross-site request forgery: a LAN identity needs no credential at all, and SameSite=Lax keeps the cookie
    // off cross-site POSTs but not off same-site ones (a sibling subdomain, another port on the same host). So a
    // change is taken only from this dashboard's own pages (`same-origin`) or the user's own navigation (`none`).
    // Browsers send Sec-Fetch-Site on HTTPS and localhost only; without it (the plain-http LAN) an Origin, when
    // there is one, must be this dashboard's. And anything with a body must be JSON (an HTML form cannot send it).
    if (path.startsWith('/api/') && MUTATING.has(req.method)) {
      const site = req.headers['sec-fetch-site'];
      const foreign = site !== undefined ? site !== 'same-origin' && site !== 'none' : req.headers.origin !== undefined && req.headers.origin !== origin(req);
      if (foreign) return reply.code(403).send({ ok: false, message: 'cross-site request refused' });
      const type = String(req.headers['content-type'] ?? '').split(';')[0].trim();
      if (Number(req.headers['content-length'] ?? 0) > 0 && type !== 'application/json') return reply.code(415).send({ ok: false, message: 'send JSON' });
    }
    if (path === '/api/health' || path === '/auth/login' || path === '/auth/callback') {
      req.identity = { email: 'health', via: 'open', canAct: false };
      return;
    }
    // 1. basic auth, when configured, gates everything
    if (cfg.user && cfg.password) {
      const h = req.headers.authorization ?? '';
      let ok = false;
      if (h.startsWith('Basic ')) {
        const key = clientIp(req, cfg.trustedCidrs);
        const wait = throttle.retryAfter(key);
        if (wait > 0) return reply.code(429).header('Retry-After', Math.ceil(wait / 1000)).send({ ok: false, message: 'too many failed sign-ins, try again shortly' });
        const [u, ...rest] = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':');
        const userOk = safeEqual(u ?? '', cfg.user);
        const passwordOk = safeEqual(rest.join(':'), cfg.password);
        ok = userOk && passwordOk;
        if (ok) throttle.succeeded(key);
        else throttle.failed(key);
      }
      if (!ok) return deny(reply, 401, 'unauthorized');
      if (!gated) {
        req.identity = { email: cfg.user, via: 'basic', canAct: !cfg.readonly };
        return;
      }
    }
    // 2. Cloudflare Access
    if (verifier) {
      const token = accessTokenFrom(req.headers);
      if (token) {
        try {
          const id = await verifier.verify(token);
          const email = id.email || id.subject;
          req.identity = { email, via: 'access', canAct: canAct(email, !!id.email) };
          return;
        } catch (e) {
          req.log.warn(`access token rejected: ${(e as Error).message}`);
          return deny(reply, 401, `access token rejected: ${(e as Error).message}`);
        }
      }
    }
    // 3. a sign-in through the OpenID Connect provider, whose email is still on the list (the session is a signed
    //    cookie with no store behind it, so taking an email off the list is what ends its sessions)
    if (ssoSecret) {
      const s = verifyValue<SsoSession>(ssoSecret, cookie(req, SSO_COOKIE));
      if (s?.email && ssoAllowed.includes(s.email.toLowerCase())) {
        req.identity = { email: s.email, via: 'sso', canAct: canAct(s.email, true) };
        return;
      }
    }
    // 4. a trusted network needs nothing — unless the request came through Cloudflare
    const ip = clientIp(req, cfg.trustedCidrs);
    if (!viaCloudflare(req.headers) && isTrusted(ip, cfg.trustedCidrs)) {
      req.identity = { email: `lan (${ip})`, via: 'lan', canAct: !cfg.readonly };
      return;
    }
    // 5. nothing else configured: the docker socket is root on the host, so nobody else gets in
    if (!gated) return deny(reply, 403, `${ip} is not on a trusted network (DASH_TRUSTED_CIDRS), and no sign-in is configured`);
    if (!ssoSecret) return deny(reply, 401, 'sign in through Cloudflare Access');
    // a browser navigation goes straight to the provider; API calls get told where the login is
    if (req.method === 'GET' && !path.startsWith('/api/') && String(req.headers.accept ?? '').includes('text/html')) {
      return reply.header('Cache-Control', 'no-store').redirect(`/auth/login?next=${encodeURIComponent(req.url)}`, 302);
    }
    return deny(reply, 401, 'sign in', { sso: { loginUrl: '/auth/login' } });
  });
}
