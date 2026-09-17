# mk-dashboard — client

The dashboard's pages: Angular (standalone, zoneless, signals) on
[@mk-kit/ui](https://mk-kit.dev). The server serves the built app; on its
own it is only useful in development.

```bash
npm start        # ng serve on :4200, /api proxied to the server on :8800 (proxy.conf.json)
npm run build    # → dist/client/browser, what the Dockerfile copies into the image
```

Run both sides at once with `npm run dev` from the repository root.

- `src/app/pages` — one component per page; `src/app/shared` — the bits they
  share; `src/app/core` — services (`live.service.ts` owns the SSE stream, the
  identity and the signed-out screen; `api.service.ts` is every other call).
- The API's types come from `../shared/types.ts`, the same file the server imports.
- Styles use `--mk-*` tokens only, no hardcoded colours.
- A PWA: `ngsw-config.json` keeps the service worker off `/api`, and
  navigations go network-first so a sign-in redirect is never served from cache.
