/** "Update now" through watchtower's HTTP API (WATCHTOWER_HTTP_API_UPDATE=true). */
import type { Config } from './config.ts';

export function watchtowerEnabled(cfg: Config): boolean {
  return !!(cfg.watchtowerUrl && cfg.watchtowerToken);
}

export async function triggerUpdate(cfg: Config, image: string): Promise<{ ok: boolean; message: string }> {
  if (!watchtowerEnabled(cfg)) return { ok: false, message: 'watchtower is not configured' };
  const url = new URL('/v1/update', cfg.watchtowerUrl);
  url.searchParams.set('image', image);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120_000);
  try {
    const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${cfg.watchtowerToken}` }, signal: ctrl.signal });
    const body = (await res.text()).trim();
    if (!res.ok) return { ok: false, message: `watchtower responded ${res.status}${body ? `: ${body}` : ''}` };
    return { ok: true, message: body || `watchtower checked ${image}` };
  } catch (e) {
    return { ok: false, message: `watchtower unreachable: ${(e as Error).message}` };
  } finally {
    clearTimeout(timer);
  }
}
