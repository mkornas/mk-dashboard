import Fastify from 'fastify';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { createHash } from 'node:crypto';

/** A tiny OpenID provider that signs anyone in as the email in `who` (mutable between tests; `verified` defaults to true). */
export async function provider(who: { email: string; name: string; verified?: boolean }, audience: string) {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const codes = new Map<string, { challenge: string; nonce: string }>();
  const idp = Fastify();
  idp.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_r, body, done) => done(null, Object.fromEntries(new URLSearchParams(body as string))));
  let issuer = '';
  idp.get('/.well-known/openid-configuration', async () => ({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`, end_session_endpoint: `${issuer}/end-session`, response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'], code_challenge_methods_supported: ['S256'] }));
  idp.get<{ Querystring: Partial<Record<string, string>> }>('/authorize', async (req, reply) => {
    const code = `c${codes.size + 1}`;
    codes.set(code, { challenge: req.query.code_challenge ?? '', nonce: req.query.nonce ?? '' });
    return reply.redirect(`${req.query.redirect_uri}?code=${code}&state=${encodeURIComponent(req.query.state ?? '')}`);
  });
  idp.post<{ Body: Partial<Record<string, string>> }>('/token', async (req, reply) => {
    const code = req.body.code ?? '';
    const c = codes.get(code);
    if (!c || createHash('sha256').update(req.body.code_verifier ?? '').digest('base64url') !== c.challenge) return reply.code(400).send({ error: 'invalid_grant' });
    codes.delete(code);
    const id_token = await new SignJWT({ nonce: c.nonce, email: who.email, email_verified: who.verified ?? true, name: who.name }).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(issuer).setAudience(audience).setSubject('u1').setIssuedAt().setExpirationTime('5m').sign(privateKey);
    return { access_token: 'at', token_type: 'Bearer', id_token, expires_in: 300 };
  });
  idp.get('/jwks', async () => ({ keys: [jwk] }));
  await idp.listen({ port: 0, host: '127.0.0.1' });
  issuer = `http://127.0.0.1:${(idp.server.address() as { port: number }).port}`;
  return { idp, issuer };
}

/** Drives the browser's part of the flow: login → provider → callback. Returns the callback response. */
export async function roundTrip(app: { inject: (o: { url: string; headers: Record<string, string> }) => Promise<{ statusCode: number; headers: Record<string, unknown>; body: string }> }, next: string, host: string) {
  const login = await app.inject({ url: `/auth/login?next=${encodeURIComponent(next)}`, headers: { host } });
  if (login.statusCode !== 302) throw new Error(`login: ${login.statusCode}`);
  const transient = String(login.headers['set-cookie']).split(';')[0] ?? '';
  const back = new URL((await fetch(login.headers.location as string, { redirect: 'manual' })).headers.get('location')!);
  const cb = await app.inject({ url: back.pathname + back.search, headers: { host, cookie: transient } });
  const cookies = ([] as string[]).concat((cb.headers['set-cookie'] as string | string[] | undefined) ?? []).map((c) => c.split(';')[0] ?? '');
  return { login, cb, cookies };
}
