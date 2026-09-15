/**
 * Single sign-on. `GET /auth/login` sends the browser to the OpenID Connect
 * provider named in DASH_OIDC_ISSUER; `GET /auth/callback` turns the verified
 * identity into the signed `dash_session` cookie auth.ts accepts. The provider
 * says who you are; DASH_OIDC_EMAILS (else DASH_ADMIN_EMAILS) says whether that
 * person may see this dashboard. A refused or failed sign-in lands on
 * `/?reason=…`, which the app shows together with a "sign in" button instead
 * of bouncing to the provider again.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createOidc, type MkIdentity, type Oidc, registerOidcRoutes, signValue } from '@mk-kit/auth/server';
import type { Config } from './config.ts';
import { isSecure, origin, ssoAllowList, ssoCookie, ssoSession, type SsoSession } from './auth.ts';
import type { SignOutResult } from '../../shared/types.ts';

export function ssoEnabled(cfg: Config): boolean {
  // a confidential client cannot finish the flow without its secret: all three enable it
  return !!(cfg.oidcIssuer && cfg.oidcClientId && cfg.oidcClientSecret);
}

/** `@mk-kit/auth` refuses to sign with a shorter key. */
const MIN_SECRET_LENGTH = 16;

/**
 * DASH_COOKIE_SECRET (16 characters or more, else the start fails); else one generated once into the data dir — again
 * when that file is empty or too short; else a fresh one per start (sign-ins end with a restart).
 */
export function cookieSecret(cfg: Config, log: { warn(msg: string): void }): string {
  if (cfg.cookieSecret) {
    if (cfg.cookieSecret.length < MIN_SECRET_LENGTH)
      throw new Error(`DASH_COOKIE_SECRET is shorter than ${MIN_SECRET_LENGTH} characters — set 32 random bytes (openssl rand -base64 32), or unset it to have one generated`);
    return cfg.cookieSecret;
  }
  if (cfg.dataDir) {
    const file = join(cfg.dataDir, 'cookie-secret');
    try {
      const kept = existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
      if (kept.length >= MIN_SECRET_LENGTH) return kept;
      mkdirSync(cfg.dataDir, { recursive: true });
      const secret = randomBytes(32).toString('base64url');
      writeFileSync(file, secret, { mode: 0o600 });
      chmodSync(file, 0o600); // the mode above only applies to a new file
      return secret;
    } catch (e) {
      log.warn(`could not keep a cookie secret in ${file}: ${(e as Error).message}`);
    }
  }
  log.warn('DASH_COOKIE_SECRET is unset and there is no data dir: sign-ins will not survive a restart');
  return randomBytes(32).toString('base64url');
}

const PROBE = 'http://return.invalid';

/**
 * A same-origin path to return to after sign-in, or null. Control characters, spaces and backslashes are refused
 * outright: a browser drops tabs and newlines from a Location, so `/\t/evil.example` would land on another site.
 */
export function safeReturnPath(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.startsWith('/') || /[\x00-\x20\x7f\\]/.test(raw)) return null;
  try {
    return new URL(raw, PROBE).origin === PROBE ? raw : null;
  } catch {
    return null;
  }
}

function addCookie(reply: FastifyReply, value: string): void {
  const prev = reply.getHeader('Set-Cookie') as string | string[] | undefined;
  reply.header('Set-Cookie', ([] as string[]).concat(prev ?? [], value));
}

/** Back to the app with a message it shows instead of sending the browser straight to the provider again. */
function refused(reply: FastifyReply, reason: string): FastifyReply {
  return reply.header('Cache-Control', 'no-store').redirect(`/?reason=${encodeURIComponent(reason)}`, 303);
}

interface SsoLog {
  info(msg: string): void;
  error(msg: string): void;
}

/**
 * The provider, discovered lazily: once at start and again on every login
 * attempt until it answers. The dashboard usually boots alongside the provider
 * (same box, same power cycle), so an issuer that is not up yet must not turn
 * into "nobody can sign in until someone restarts the dashboard".
 */
export class SsoProvider {
  private readonly cfg: Config;
  private readonly log: SsoLog;
  private client: Oidc | null = null;
  private pending: Promise<Oidc | null> | null = null;

  constructor(cfg: Config, log: SsoLog) {
    this.cfg = cfg;
    this.log = log;
  }

  get ready(): boolean {
    return this.client !== null;
  }

  get issuer(): string {
    return this.client?.issuer ?? this.cfg.oidcIssuer;
  }

  /** The discovered client, or null while the issuer cannot be reached (one attempt at a time; each failure is logged). */
  connect(): Promise<Oidc | null> {
    if (this.client) return Promise.resolve(this.client);
    this.pending ??= createOidc({ issuer: this.cfg.oidcIssuer, clientId: this.cfg.oidcClientId, clientSecret: this.cfg.oidcClientSecret || undefined, allowInsecure: this.cfg.oidcIssuer.startsWith('http://') })
      .then(
        (client) => {
          this.client = client;
          this.log.info(`single sign-on: connected to ${client.issuer}`);
          return client;
        },
        (e: Error) => {
          this.log.error(`single sign-on: could not read ${this.cfg.oidcIssuer}/.well-known/openid-configuration (${e.message}); retried on the next login`);
          return null;
        },
      )
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }

  // The surface registerOidcRoutes() calls. The routes only run once connect() has succeeded (see registerSso).
  authorize(redirectUri: string): ReturnType<Oidc['authorize']> {
    return this.require().authorize(redirectUri);
  }

  callback(url: URL, expected: { state: string; nonce: string; codeVerifier: string }): Promise<MkIdentity> {
    return this.require().callback(url, expected);
  }

  /** The provider's logout page (RP-initiated logout) when it offers one and is connected, else null. */
  endSessionUrl(postLogoutRedirectUri?: string, idTokenHint?: string): string | null {
    return this.client?.endSessionUrl(postLogoutRedirectUri, idTokenHint) ?? null;
  }

  private require(): Oidc {
    if (!this.client) throw new Error(`${this.cfg.oidcIssuer} is not reachable`);
    return this.client;
  }
}

/** Registers `/auth/login`, `/auth/callback` and `POST /api/logout`. */
export function registerSso(app: FastifyInstance, cfg: Config, secret: string, sso: SsoProvider): void {
  const allowed = ssoAllowList(cfg);
  if (!allowed.length) app.log.warn('single sign-on: neither DASH_OIDC_EMAILS nor DASH_ADMIN_EMAILS is set — every sign-in will be refused');

  // a login attempt while the provider is still unreachable retries the discovery, and explains itself when that fails too
  app.addHook('onRequest', async (req, reply) => {
    if (req.url.split('?')[0] !== '/auth/login' || (await sso.connect())) return;
    return refused(reply, `Sign-in is unavailable: ${cfg.oidcName} at ${cfg.oidcIssuer} could not be reached. Try again in a moment.`);
  });

  registerOidcRoutes<FastifyRequest, FastifyReply>(app, {
    // SsoProvider offers everything the routes call; Oidc's private fields make its type nominal, hence the cast
    oidc: sso as unknown as Oidc,
    cookieSecret: secret,
    redirectUri: (req) => `${origin(req)}/auth/callback`,
    cookie: { secure: isSecure },
    onSignedIn: async (identity, { req, reply, next }) => {
      // the email is the whole link to the allow-list: only one the provider has verified
      if (identity.email && identity.emailVerified !== true) {
        req.log.warn(`sso refused ${identity.email} (email not verified by the provider)`);
        return refused(reply, `${cfg.oidcName} has not verified the email ${identity.email}. Verify it there first.`);
      }
      if (!identity.email || !allowed.includes(identity.email)) {
        req.log.warn(`sso refused ${identity.email || identity.subject} (not in DASH_OIDC_EMAILS)`);
        return refused(reply, `No dashboard account for ${identity.email || 'this identity'}. Add it to DASH_OIDC_EMAILS to let it in.`);
      }
      const session: SsoSession = { email: identity.email, exp: Date.now() + cfg.sessionDays * 86_400_000, idToken: identity.idToken };
      addCookie(reply, ssoCookie(signValue(secret, session), cfg.sessionDays * 86_400, isSecure(req)));
      req.log.info(`sso login ${identity.email} via ${identity.issuer}`);
      return reply.redirect(safeReturnPath(next) ?? '/', 303);
    },
    onError: async (err, { req, reply }) => {
      req.log.warn(`sso failed: ${err.message}`);
      return refused(reply, `Sign-in failed: ${err.message}.`);
    },
  });

  app.post('/api/logout', async (req, reply): Promise<SignOutResult> => {
    const session = ssoSession(req, secret);
    reply.header('Set-Cookie', ssoCookie('', 0, isSecure(req)));
    // end the provider's session too when it supports RP-initiated logout; the return address must be registered there,
    // and the ID token from sign-in lets the provider skip its "sign out?" page
    return { ok: true, redirect: sso.endSessionUrl(`${origin(req)}/`, session?.idToken) ?? undefined };
  });

  app.log.info(`single sign-on: ${cfg.oidcIssuer} (${cfg.oidcName}); ${allowed.length} email(s) allowed`);
}
