# mk-dashboard — Project Guide

## Think before coding

State assumptions; if two readings exist, name them. Prefer the simpler approach
and say so. Every changed line should trace to the request; do not refactor
neighbours. Match the existing style.

## What this is

A homelab server dashboard: host vitals from `/proc` and `/sys`, containers and
stacks from the docker socket, network checks, backups, alerts (web push,
Telegram, webhook). One container, the Angular app served by the Fastify API.
Public repo, AGPL-3.0-only, the "built with @mk-kit/ui" showcase alongside mk-drive.

## Layout

- `shared/types.ts` — the API contract both sides import.
- `server/` — Fastify 5 on **Node 24 type-stripping**: no build, no decorators,
  no enums, no parameter properties, `import … from './x.ts'`, `import type` for
  types. `src/index.ts` wires everything (also the security headers and the app's
  CSP); `src/routes.ts` = the JSON + SSE API; `src/sampler.ts` collects the
  snapshot; `src/checks.ts`, `src/notify.ts`, `src/push.ts` = checks and alerts.
  **Auth** is two files: `src/auth.ts` decides who is asking (Cloudflare Access
  JWT via `@mk-kit/auth/server`, the signed `dash_session` cookie, a trusted LAN
  address, basic auth; with none configured only trusted networks) and refuses
  mutations from anything but its own pages, or that are not JSON;
  `src/sso.ts` is the OpenID Connect side (`SsoProvider` discovers the issuer
  lazily and retries on login; `registerSso()` adds `/auth/login`,
  `/auth/callback`, `POST /api/logout`). Refused or failed sign-ins redirect to
  `/?reason=…`; the allow-list is `DASH_OIDC_EMAILS` else `DASH_ADMIN_EMAILS`.
- `client/` — Angular, standalone, zoneless, signals, `@mk-kit/ui`. Pages in
  `src/app/pages`, reusable bits in `src/app/shared`, services in `src/app/core`
  (`live.service.ts` owns the SSE stream, the identity and the signed-out
  screen). A PWA: `ngsw-config.json` keeps the service worker off `/api` and
  navigations go network-first so Access and the provider can redirect.
- `Dockerfile` builds the client and runs `server/src/index.ts`;
  `docker-compose.yml` is the example deployment with every variable.

## Commands

```bash
npm install                      # installs server + client
npm run dev                      # API on :8800 + ng serve on :4200 (proxies /api)
npm test && npm run typecheck    # server: node:test + tsc
npm run build                    # client → client/dist/client/browser (served by the server)
```

## Conventions

- Tokens only in styles (`--mk-*`); no hardcoded colours.
- Server tests use `app.inject()`; `test/oidc-provider.ts` is an in-process
  OpenID provider — add a test in `test/sso.test.ts` for every auth change.
- Actions check `req.identity.canAct` on the server (`requireAct`); never rely
  on the UI hiding a button.
- Anything an operator sets is an env var documented in `README.md` and
  `docker-compose.yml`.
