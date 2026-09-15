import { Injectable, computed, inject, signal } from '@angular/core';
import type { HistoryPoint, Identity, Meta, Overview, SignOutResult, Snapshot } from '../../../../shared/types';
import { ApiService } from './api.service';

const SIGNED_OUT_KEY = 'mk-dashboard.signed-out';

/**
 * `/?reason=…` left by a refused or failed sign-in (sso.ts), or the note "sign out" leaves
 * for the page it lands on. Consumed once; the query parameter comes off the address bar.
 */
function takeReason(): string | null {
  const url = new URL(location.href);
  const fromUrl = url.searchParams.get('reason');
  if (fromUrl !== null) {
    url.searchParams.delete('reason');
    history.replaceState(history.state, '', url.pathname + url.search + url.hash);
  }
  let flag: string | null = null;
  try {
    flag = sessionStorage.getItem(SIGNED_OUT_KEY);
    sessionStorage.removeItem(SIGNED_OUT_KEY);
  } catch {
    /* storage unavailable: nothing to take */
  }
  return fromUrl || flag;
}

/**
 * Holds the live snapshot pushed by the server over SSE (`/api/stream`) and the
 * rolling history. Reconnects on its own; `connected` drives the header pill.
 */
@Injectable({ providedIn: 'root' })
export class LiveService {
  private readonly api = inject(ApiService);

  readonly snapshot = signal<Snapshot | null>(null);
  readonly history = signal<HistoryPoint[]>([]);
  readonly connected = signal(false);
  readonly meta = signal<Meta | null>(null);
  readonly me = signal<Identity | null>(null);
  readonly lastUpdate = signal<number>(0);
  /** Not signed in, and told why: the shell shows this with a sign-in button instead of bouncing to the provider again. */
  readonly signedOut = signal<{ reason: string; loginUrl: string } | null>(null);

  readonly containers = computed(() => this.snapshot()?.containers ?? []);
  readonly stacks = computed(() => this.snapshot()?.stacks ?? []);
  readonly alerts = computed(() => this.snapshot()?.alerts ?? []);
  /** Actions are hidden until the server says this identity may act. */
  readonly readonly = computed(() => (this.meta()?.readonly ?? true) || !(this.me()?.canAct ?? false));

  private source?: EventSource;
  private retry?: ReturnType<typeof setTimeout>;
  private started = false;
  private checking = false;
  private reason: string | null = null;

  start(): void {
    if (this.started) return;
    this.started = true;
    this.reason = takeReason();
    void this.api.meta().then((m) => this.meta.set(m)).catch(() => undefined);
    void this.api.me().then((m) => this.me.set(m)).catch(() => void this.checkSession());
    this.connect();
  }

  /**
   * A failed request may mean the Cloudflare Access session expired: the API then
   * answers with a redirect to the login page, which fetch/EventSource cannot follow.
   * Detect that (an opaque redirect on a manual-redirect probe) and reload so the
   * navigation itself goes through the login. At most once a minute, so a server
   * that is really down does not turn into a reload loop.
   */
  private async checkSession(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      const r = await fetch('/api/me', { redirect: 'manual', cache: 'no-store', headers: { 'ngsw-bypass': 'true' } });
      if (r.status === 401) {
        // the single sign-on session ended (or never began): the server says where the login is
        const body = (await r.json().catch(() => null)) as { sso?: { loginUrl: string } } | null;
        if (!body?.sso?.loginUrl) return;
        if (this.reason) {
          this.signedOut.set({ reason: this.reason, loginUrl: body.sso.loginUrl });
          return;
        }
        if (this.onceAMinute()) location.assign(`${body.sso.loginUrl}?next=${encodeURIComponent(location.pathname + location.search)}`);
        return;
      }
      if (r.type !== 'opaqueredirect') return;
      if (this.onceAMinute()) location.reload();
    } catch {
      /* offline or the server is down: the stream keeps retrying */
    } finally {
      this.checking = false;
    }
  }

  private onceAMinute(): boolean {
    const key = 'mk-dashboard.relogin';
    const last = Number(sessionStorage.getItem(key) ?? 0);
    if (Date.now() - last < 60_000) return false;
    sessionStorage.setItem(key, String(Date.now()));
    return true;
  }

  private connect(): void {
    this.source?.close();
    const es = new EventSource('/api/stream?ngsw-bypass=true');
    this.source = es;
    es.addEventListener('overview', (ev) => {
      const o = JSON.parse((ev as MessageEvent).data) as Overview;
      this.snapshot.set(o.snapshot);
      this.history.set(o.history);
      this.connected.set(true);
      this.lastUpdate.set(Date.now());
    });
    es.addEventListener('snapshot', (ev) => {
      const s = JSON.parse((ev as MessageEvent).data) as Snapshot;
      this.snapshot.set(s);
      this.pushHistory(s);
      this.connected.set(true);
      this.lastUpdate.set(Date.now());
    });
    es.onopen = () => this.connected.set(true);
    es.onerror = () => {
      this.connected.set(false);
      es.close();
      void this.checkSession();
      if (this.retry) clearTimeout(this.retry);
      if (this.signedOut()) return; // the sign-in button is the way forward, not another stream
      this.retry = setTimeout(() => this.connect(), 3000);
    };
  }

  /** Sign out: drop the session, then go to the provider's logout page when it has one, else home — which shows the signed-out screen. */
  async signOut(): Promise<void> {
    const res = await fetch('/api/logout', { method: 'POST', headers: { 'ngsw-bypass': 'true' } })
      .then((r) => r.json() as Promise<SignOutResult>)
      .catch(() => null);
    try {
      sessionStorage.setItem(SIGNED_OUT_KEY, 'You signed out.');
    } catch {
      /* without storage the next page load simply goes back to the provider */
    }
    location.assign(res?.redirect ?? '/');
  }

  private pushHistory(s: Snapshot): void {
    const max = this.meta()?.historyPoints ?? 240;
    const next = [...this.history(), { t: s.t, cpu: s.host.cpu.percent, mem: s.host.memory.percent, netRx: s.host.netRxRate, netTx: s.host.netTxRate }];
    if (next.length > max) next.splice(0, next.length - max);
    this.history.set(next);
  }
}
