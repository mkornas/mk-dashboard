/**
 * Alert lifecycle + notifications. An alert has to persist for `notifyAfterMs`
 * before anything is sent (flaps stay quiet); when a notified alert goes away
 * a "resolved" message follows. History keeps both transitions.
 */
import type { Config } from './config.ts';
import type { PushService } from './push.ts';
import { JsonlStore } from './store.ts';
import type { Alert, AlertEvent, AlertsInfo } from '../../shared/types.ts';

const LEVEL_RANK = { info: 0, warning: 1, danger: 2 } as const;

interface Tracked {
  alert: Alert;
  firstSeen: number;
  confirmed: boolean;
  notified: boolean;
}

export class Notifier {
  private readonly cfg: Config;
  private readonly active = new Map<string, Tracked>();
  private readonly history: JsonlStore<AlertEvent>;
  private readonly push: PushService;
  private hostname = '';

  constructor(cfg: Config, push: PushService) {
    this.cfg = cfg;
    this.push = push;
    this.history = new JsonlStore<AlertEvent>(cfg.dataDir, 'alerts.jsonl', 500);
  }

  setHostname(h: string): void {
    this.hostname = h;
  }

  channels(): string[] {
    const out: string[] = [];
    if (this.push.enabled && this.push.count() > 0) out.push('webpush');
    if (this.cfg.telegramToken && this.cfg.telegramChatId) out.push('telegram');
    if (this.cfg.webhookUrl) out.push('webhook');
    return out;
  }

  info(): AlertsInfo {
    return {
      active: this.activeAlerts(),
      history: this.history.list(200),
      channels: this.channels(),
      afterMs: this.cfg.notifyAfterMs,
      minLevel: this.cfg.notifyMinLevel,
    };
  }

  /** Current alerts decorated with `since`. */
  activeAlerts(): Alert[] {
    return [...this.active.values()].map((t) => ({ ...t.alert, since: t.alert.since ?? t.firstSeen }));
  }

  /** Feed the freshly computed alert list; returns it decorated with `since`. */
  update(alerts: Alert[], now = Date.now()): Alert[] {
    const seen = new Set<string>();
    for (const a of alerts) {
      const key = a.title;
      seen.add(key);
      const t = this.active.get(key);
      if (!t) {
        this.active.set(key, { alert: a, firstSeen: a.since ?? now, confirmed: false, notified: false });
        continue;
      }
      t.alert = { ...a, since: a.since ?? t.firstSeen };
      if (!t.confirmed && now - t.firstSeen >= this.cfg.notifyAfterMs) {
        t.confirmed = true;
        const send = this.shouldNotify(a.level);
        t.notified = send;
        this.history.push({ t: now, type: 'raised', level: a.level, title: a.title, detail: a.detail, link: a.link, notified: send });
        if (send) void this.send(`${icon(a.level)} ${a.title}`, a.detail ?? '', a.level, a.link, a.title);
      }
    }
    for (const [key, t] of this.active) {
      if (seen.has(key)) continue;
      this.active.delete(key);
      if (!t.confirmed) continue;
      this.history.push({ t: now, type: 'cleared', level: t.alert.level, title: t.alert.title, detail: `after ${fmtDuration(now - t.firstSeen)}`, link: t.alert.link, notified: t.notified });
      if (t.notified) void this.send(`✅ Resolved: ${t.alert.title}`, `after ${fmtDuration(now - t.firstSeen)}`, 'info', t.alert.link, t.alert.title);
    }
    return this.activeAlerts();
  }

  private shouldNotify(level: Alert['level']): boolean {
    return this.channels().length > 0 && LEVEL_RANK[level] >= LEVEL_RANK[this.cfg.notifyMinLevel];
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    const ch = this.channels();
    if (!ch.length) return { ok: false, message: 'No notification channel: enable push on a device, or set DASH_TELEGRAM_* / DASH_WEBHOOK_URL' };
    const errors = await this.send('🔔 Test from mk-dashboard', `Notifications work on ${this.hostname || 'this host'}.`, 'info', '/activity', 'test');
    return errors.length ? { ok: false, message: errors.join('; ') } : { ok: true, message: `Sent to ${ch.join(', ')}` };
  }

  /** Fan out to every channel; returns per-channel error strings. */
  async send(title: string, body: string, level: Alert['level'], link?: string, tag?: string): Promise<string[]> {
    const tasks: Array<Promise<void>> = [];
    const errors: string[] = [];
    if (this.push.enabled) {
      tasks.push(
        this.push.send(`${this.hostname ? `${this.hostname}: ` : ''}${title}`, body, level, link, tag).then((errs) => {
          for (const e of errs) {
            errors.push(e);
            console.warn('notify', e);
          }
        }),
      );
    }
    const wrap = (name: string, p: Promise<unknown>) =>
      p.then(
        () => undefined,
        (e: unknown) => {
          const msg = `${name}: ${(e as Error).message}`;
          errors.push(msg);
          console.warn('notify', msg);
        },
      );
    const prefix = this.hostname ? `[${this.hostname}] ` : '';
    if (this.cfg.telegramToken && this.cfg.telegramChatId) {
      tasks.push(
        wrap(
          'telegram',
          fetchOk(`https://api.telegram.org/bot${this.cfg.telegramToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: this.cfg.telegramChatId, text: `${prefix}${title}\n${body}`.trim() }),
          }),
        ),
      );
    }
    if (this.cfg.webhookUrl) {
      tasks.push(
        wrap(
          'webhook',
          fetchOk(this.cfg.webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ host: this.hostname, level, title, body, t: Date.now() }),
          }),
        ),
      );
    }
    await Promise.all(tasks);
    return errors;
  }
}

async function fetchOk(url: string, init: RequestInit): Promise<void> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
  } finally {
    clearTimeout(timer);
  }
}

function icon(level: Alert['level']): string {
  return level === 'danger' ? '🔴' : level === 'warning' ? '🟠' : 'ℹ️';
}

export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
