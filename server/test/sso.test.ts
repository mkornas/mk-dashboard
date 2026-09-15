import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';
import { config } from '../src/config.ts';
import { registerAuth } from '../src/auth.ts';
import { SsoProvider, registerSso } from '../src/sso.ts';
import { provider, roundTrip } from './oidc-provider.ts';

const who: { email: string; name: string; verified?: boolean } = { email: 'Admin@Example.com', name: 'Admin' };
const quiet = { info() {}, error() {}, warn() {} };
let idp: FastifyInstance;
let app: FastifyInstance;
let cfg: typeof config;

before(async () => {
  const p = await provider(who, 'mk-dashboard');
  idp = p.idp;
  cfg = { ...config, user: '', password: '', readonly: false, accessAud: '', trustedCidrs: [], adminEmails: [], dataDir: '', oidcIssuer: p.issuer, oidcClientId: 'mk-dashboard', oidcClientSecret: 's', oidcName: 'Example ID', oidcEmails: ['admin@example.com'], sessionDays: 7 };
  app = Fastify();
  const sso = new SsoProvider(cfg, quiet);
  assert.ok(await sso.connect(), 'discovery works');
  registerAuth(app, cfg, null, 'test-secret');
  registerSso(app, cfg, 'test-secret', sso);
  app.get('/api/me', async (req) => req.identity);
  app.post('/api/act', async () => ({ ok: true }));
  app.get('/', async () => 'app');
});
after(async () => {
  await app.close();
  await idp.close();
});

const reasonOf = (location: unknown) => decodeURIComponent(String(location).replace(/^\/\?reason=/, ''));

test('nothing identifies the caller: the API says where the login is, a page navigation goes there', async () => {
  const api = await app.inject({ url: '/api/me' });
  assert.equal(api.statusCode, 401);
  assert.deepEqual(api.json().sso, { loginUrl: '/auth/login' });
  const page = await app.inject({ url: '/containers?x=1', headers: { accept: 'text/html,*/*' } });
  assert.equal(page.statusCode, 302);
  assert.equal(page.headers.location, '/auth/login?next=%2Fcontainers%3Fx%3D1');
});

test('a listed email signs in through the provider and is an SSO identity afterwards; sign-out clears it and ends the provider session', async () => {
  const { login, cb, cookies } = await roundTrip(app, '/containers', 'dash.test');
  assert.equal(new URL(login.headers.location as string).searchParams.get('redirect_uri'), 'http://dash.test/auth/callback');
  assert.equal(cb.statusCode, 303);
  assert.equal(cb.headers.location, '/containers');
  const session = cookies.find((c) => c.startsWith('dash_session='));
  assert.ok(session, 'session cookie set');
  const me = (await app.inject({ url: '/api/me', headers: { cookie: session! } })).json();
  assert.deepEqual(me, { email: 'admin@example.com', via: 'sso', canAct: true });
  const out = await app.inject({ method: 'POST', url: '/api/logout', headers: { cookie: session!, host: 'dash.test' } });
  assert.match(String(out.headers['set-cookie']), /^dash_session=; Path=\/; HttpOnly; SameSite=Lax; Max-Age=0/);
  const end = new URL(out.json().redirect as string);
  assert.equal(end.pathname, '/end-session');
  assert.equal(end.searchParams.get('post_logout_redirect_uri'), 'http://dash.test/');
  assert.match(end.searchParams.get('id_token_hint') ?? '', /^eyJ/, 'the ID token from sign-in goes with the sign-out');
  const tampered = session!.slice(0, -2) + 'xx';
  assert.equal((await app.inject({ url: '/api/me', headers: { cookie: tampered } })).statusCode, 401);
});

test('a mutating API call from another site, or one that is not JSON, is refused before anything else', async () => {
  const { cookies } = await roundTrip(app, '/', 'dash.test');
  const cookie = cookies.find((c) => c.startsWith('dash_session='))!;
  const ok = await app.inject({ method: 'POST', url: '/api/act', headers: { cookie, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, payload: {} });
  assert.equal(ok.statusCode, 200);
  const cross = await app.inject({ method: 'POST', url: '/api/act', headers: { cookie, 'sec-fetch-site': 'cross-site' } });
  assert.equal(cross.statusCode, 403);
  const form = await app.inject({ method: 'POST', url: '/api/act', headers: { cookie, 'content-type': 'text/plain' }, payload: 'x=1' });
  assert.equal(form.statusCode, 415);
  const sibling = await app.inject({ method: 'POST', url: '/api/act', headers: { cookie, 'sec-fetch-site': 'same-site' } });
  assert.equal(sibling.statusCode, 403, 'a sibling subdomain or another port carries the Lax cookie, so same-site is refused too');
  const encoded = await app.inject({ method: 'POST', url: '/%61pi/act', headers: { cookie, 'sec-fetch-site': 'cross-site' } });
  assert.equal(encoded.statusCode, 403, 'an encoded path is judged by the route it reaches');
  // plain http on the LAN: no Sec-Fetch-Site, so the Origin decides
  const foreign = await app.inject({ method: 'POST', url: '/api/act', headers: { cookie, host: 'dash.test', origin: 'http://evil.test' } });
  assert.equal(foreign.statusCode, 403);
  const own = await app.inject({ method: 'POST', url: '/api/act', headers: { cookie, host: 'dash.test', origin: 'http://dash.test' } });
  assert.equal(own.statusCode, 200);
});

test('an email the provider has not verified gets no session, even when it is on the list', async () => {
  who.email = 'admin@example.com';
  who.verified = false;
  try {
    const { cb, cookies } = await roundTrip(app, '/', 'dash.test');
    assert.equal(cb.statusCode, 303);
    assert.equal(reasonOf(cb.headers.location), 'Example ID has not verified the email admin@example.com. Verify it there first.');
    assert.ok(!cookies.some((c) => c.startsWith('dash_session=')));
  } finally {
    who.verified = undefined;
  }
});

test('the return path after sign-in stays on this dashboard', async () => {
  who.email = 'admin@example.com';
  for (const next of ['/\t/evil.example', '/\\evil.example', '//evil.example', 'https://evil.example/']) {
    const { cb } = await roundTrip(app, next, 'dash.test');
    assert.equal(cb.headers.location, '/', JSON.stringify(next));
  }
  assert.equal((await roundTrip(app, '/containers?x=1', 'dash.test')).cb.headers.location, '/containers?x=1');
});

test('with no sign-in configured only a trusted network gets in, and forwarded addresses do not fake one', async () => {
  const open = { ...cfg, oidcIssuer: '', trustedCidrs: ['127.0.0.0/8', '10.0.0.0/8'] };
  const a = Fastify();
  registerAuth(a, open, null, null);
  a.get('/api/me', async (req) => req.identity);
  const me = (remoteAddress: string, headers: Record<string, string> = {}) => a.inject({ url: '/api/me', remoteAddress, headers });
  try {
    assert.deepEqual((await me('10.1.2.3')).json(), { email: 'lan (10.1.2.3)', via: 'lan', canAct: true });
    assert.equal((await me('203.0.113.9')).statusCode, 403, 'the internet');
    assert.equal((await me('203.0.113.9', { 'x-forwarded-for': '127.0.0.1' })).statusCode, 403, 'forwarding headers from an untrusted peer are ignored');
    assert.equal((await me('203.0.113.9', { 'cf-connecting-ip': '127.0.0.1' })).statusCode, 403);
    assert.equal((await me('127.0.0.1', { 'cf-ray': 'x' })).statusCode, 403, 'through Cloudflare a trusted address does not count');
    // a trusted proxy: its X-Forwarded-For is read from the right, so the client's own leftmost entry does not count
    assert.equal((await me('127.0.0.1', { 'x-forwarded-for': '10.9.9.9, 198.51.100.7' })).statusCode, 403);
    assert.equal((await me('127.0.0.1', { 'x-forwarded-for': '198.51.100.7, 10.1.1.1' })).statusCode, 403, 'past the trusted hops');
    assert.equal((await me('127.0.0.1', { 'x-forwarded-for': '10.1.1.1' })).json().via, 'lan', 'a LAN client behind a local proxy');  } finally {
    await a.close();
  }
});

test('basic auth: wrong passwords from one address are slowed down', async () => {
  const basic = { ...cfg, oidcIssuer: '', trustedCidrs: [], user: 'admin', password: 'correct horse' };
  const a = Fastify();
  registerAuth(a, basic, null, null);
  a.get('/api/me', async (req) => req.identity);
  const as = (user: string, password: string) => a.inject({ url: '/api/me', remoteAddress: '198.51.100.7', headers: { authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` } });
  try {
    assert.equal((await a.inject({ url: '/api/me', remoteAddress: '198.51.100.7' })).statusCode, 401, 'no credentials is not a failure');
    assert.equal((await as('admin', 'correct horse')).json().via, 'basic');
    assert.equal((await as('admin', 'wrong')).statusCode, 401);
    const blocked = await as('admin', 'correct horse');
    assert.equal(blocked.statusCode, 429, 'right after a failure, even the right password waits');
    assert.ok(Number(blocked.headers['retry-after']) >= 1);
  } finally {
    await a.close();
  }
  const { LoginThrottle } = await import('../src/auth.ts');
  const t = new LoginThrottle(2);
  t.failed('a', 0);
  assert.equal(t.retryAfter('a', 0), 1000);
  t.failed('a', 1000);
  assert.equal(t.retryAfter('a', 1000), 2000, 'doubles');
  t.failed('b', 0);
  t.failed('c', 0);
  assert.equal(t.retryAfter('a', 1000), 0, 'the oldest key goes past the cap');
  t.succeeded('c');
  assert.equal(t.retryAfter('c', 0), 0);
});

test('an email outside DASH_OIDC_EMAILS is sent back to the app with the reason, and gets no session', async () => {
  who.email = 'stranger@example.com';
  const { cb, cookies } = await roundTrip(app, '/', 'dash.test');
  assert.equal(cb.statusCode, 303);
  assert.equal(reasonOf(cb.headers.location), 'No dashboard account for stranger@example.com. Add it to DASH_OIDC_EMAILS to let it in.');
  assert.ok(!cookies.some((c) => c.startsWith('dash_session=')), 'no session for a stranger');
});

test('a callback without its login cookie is a failed sign-in, explained the same way', async () => {
  const cb = await app.inject({ url: '/auth/callback?code=x&state=y', headers: { host: 'dash.test' } });
  assert.equal(cb.statusCode, 303);
  assert.match(reasonOf(cb.headers.location), /^Sign-in failed: .*expired or was tampered with/);
});

test('an unreachable provider at start keeps the dashboard gated; a login attempt retries and explains itself', async () => {
  const down = { ...cfg, oidcIssuer: 'http://127.0.0.1:1' };
  const a = Fastify();
  const sso = new SsoProvider(down, quiet);
  assert.equal(await sso.connect(), null);
  assert.equal(sso.ready, false);
  registerAuth(a, down, null, 'test-secret');
  registerSso(a, down, 'test-secret', sso);
  a.get('/api/me', async (req) => req.identity);
  try {
    assert.equal((await a.inject({ url: '/api/me' })).statusCode, 401, 'still gated');
    const login = await a.inject({ url: '/auth/login?next=/', headers: { host: 'dash.test' } });
    assert.equal(login.statusCode, 303);
    assert.match(reasonOf(login.headers.location), /^Sign-in is unavailable: Example ID at http:\/\/127\.0\.0\.1:1 could not be reached/);
  } finally {
    await a.close();
  }
});
