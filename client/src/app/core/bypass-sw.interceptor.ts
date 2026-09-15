import type { HttpInterceptorFn } from '@angular/common/http';

/**
 * API calls skip the service worker (`ngsw-bypass`). Behind Cloudflare Access an
 * expired session answers with a redirect to the login page; the service worker
 * cannot follow it and turns it into a synthetic 504 with no headers, which the
 * app could not tell apart from a dead server. Streaming responses (SSE) do not
 * belong in the worker either.
 */
export const bypassServiceWorker: HttpInterceptorFn = (req, next) =>
  next(req.url.startsWith('/api/') ? req.clone({ setHeaders: { 'ngsw-bypass': 'true' } }) : req);
