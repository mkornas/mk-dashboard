/**
 * mk-dashboard server: JSON + SSE API over the Docker socket and procfs, and
 * the built Angular app as a SPA. `node src/index.ts` (Node ≥ 24 strips types).
 */
import Fastify, { type FastifyReply } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { config } from './config.ts';
import { DockerClient, DockerError } from './docker.ts';
import { Sampler } from './sampler.ts';
import { Checker } from './checks.ts';
import { EventLog } from './events.ts';
import { Notifier } from './notify.ts';
import { PushService } from './push.ts';
import { createAccessVerifier } from '@mk-kit/auth/server';
import { registerAuth } from './auth.ts';
import { SsoProvider, cookieSecret, registerSso, ssoEnabled } from './sso.ts';
import { registerRoutes } from './routes.ts';
import { HistoryStore } from './history.ts';
import { SqliteConsole } from './sqlite.ts';
import { registerSqliteRoutes } from './sqlite-routes.ts';
import { SqliteMonitor } from './sqlite-monitor.ts';

/** What the browser may load for the app: only itself (inline styles are Angular's component styles). */
const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

// trustProxy stays off: auth.ts derives the client address itself (Cloudflare header, or X-Forwarded-For from a trusted proxy only)
const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, disableRequestLogging: true });

const docker = new DockerClient(config.dockerSocket, config.dockerApiVersion);
const checker = new Checker(config);
const eventLog = new EventLog(config);
const push = new PushService(config);
const notifier = new Notifier(config, push);
const sqlite = new SqliteConsole(config, docker);
const sampler = new Sampler(config, docker, checker, eventLog, notifier, push, new SqliteMonitor(config, sqlite));
const history = new HistoryStore(config);
sampler.subscribe((s) => history.record(s));

const verifier = config.accessAud ? createAccessVerifier({ team: config.accessTeam, aud: config.accessAud }) : null;
const ssoSecret = ssoEnabled(config) ? cookieSecret(config, app.log) : null;
const sso = ssoSecret ? new SsoProvider(config, app.log) : null;
if (sso) await sso.connect(); // best effort: a provider that is still booting is retried on the first login
registerAuth(app, config, verifier, ssoSecret);
if (verifier) app.log.info(`Cloudflare Access enforced (${verifier.issuer}); trusted networks: ${config.trustedCidrs.join(', ')}`);
if (!verifier && !ssoSecret && !(config.user && config.password)) app.log.warn(`no sign-in configured: only the trusted networks get in (DASH_TRUSTED_CIDRS=${config.trustedCidrs.join(',')})`);
if (sso && ssoSecret) registerSso(app, config, ssoSecret, sso);
registerRoutes(app, config, sampler, history);
registerSqliteRoutes(app, config, sqlite);

app.addHook('onSend', async (req, reply) => {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Referrer-Policy', 'same-origin');
  reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (req.url.startsWith('/api/') && String(reply.getHeader('content-type') ?? '').includes('application/json')) reply.header('Cache-Control', 'no-store');
});

app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
  if (err instanceof DockerError) {
    reply.code(err.status === 404 ? 404 : 502).send({ ok: false, message: err.message });
    return;
  }
  const status = err.statusCode ?? 500;
  if (status >= 500) app.log.error(err);
  reply.code(status).send({ ok: false, message: err.message });
});

if (config.staticDir && existsSync(config.staticDir)) {
  // wildcard: files are resolved per request (a rebuilt client works without a restart);
  // anything that is not a file and not /api falls back to the SPA's index.html.
  await app.register(fastifyStatic, { root: config.staticDir, prefix: '/', wildcard: true, index: false, maxAge: '1h' });
  const sendIndex = (reply: FastifyReply) => reply.header('Cache-Control', 'no-cache').header('Content-Security-Policy', APP_CSP).sendFile('index.html');
  app.get('/', async (_req, reply) => sendIndex(reply));
  app.setNotFoundHandler((req, reply) => {
    if (req.method !== 'GET' || req.url.startsWith('/api/')) return reply.code(404).send({ ok: false, message: 'not found' });
    return sendIndex(reply);
  });
} else {
  app.log.warn(`no static dir at ${config.staticDir}; serving the API only`);
}

checker.start();
await sampler.start();
await app.listen({ port: config.port, host: config.host });
app.log.info(`mk-dashboard ${config.version} (${config.build}) on http://${config.host}:${config.port}${config.readonly ? ' [read-only]' : ''}`);

const shutdown = async () => {
  sampler.stop();
  checker.stop();
  history.close();
  await app.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
