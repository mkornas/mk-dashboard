/**
 * Web push: the dashboard's own notification channel. Subscriptions and the
 * VAPID key pair live in the data dir (a new key pair would orphan every
 * subscription, so it is generated once and kept).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import webpush from 'web-push';
import type { Config } from './config.ts';
import type { Alert, PushSubscriptionInfo } from '../../shared/types.ts';

interface StoredSub {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  ua?: string;
  email?: string;
  created: number;
}

interface PushFile {
  vapid: { publicKey: string; privateKey: string };
  subs: StoredSub[];
}

export class PushService {
  private readonly file: string | null;
  private data: PushFile | null = null;
  private readonly subject: string;

  constructor(cfg: Config) {
    this.file = cfg.dataDir ? join(cfg.dataDir, 'push.json') : null;
    this.subject = cfg.vapidSubject;
    if (this.file) {
      try {
        mkdirSync(cfg.dataDir, { recursive: true });
        if (existsSync(this.file)) this.data = JSON.parse(readFileSync(this.file, 'utf8')) as PushFile;
      } catch (e) {
        console.warn(`push store: ${(e as Error).message}`);
      }
    }
    if (cfg.vapidPublic && cfg.vapidPrivate) {
      this.data = { vapid: { publicKey: cfg.vapidPublic, privateKey: cfg.vapidPrivate }, subs: this.data?.subs ?? [] };
    } else if (!this.data && this.file) {
      this.data = { vapid: webpush.generateVAPIDKeys(), subs: [] };
      this.save();
      console.log('generated VAPID keys for web push');
    }
    if (this.data) webpush.setVapidDetails(this.subject, this.data.vapid.publicKey, this.data.vapid.privateKey);
  }

  /** Needs a data dir (or explicit VAPID keys) — otherwise subscriptions could not survive a restart. */
  get enabled(): boolean {
    return !!this.data;
  }

  get publicKey(): string {
    return this.data?.vapid.publicKey ?? '';
  }

  count(): number {
    return this.data?.subs.length ?? 0;
  }

  info(): PushSubscriptionInfo {
    return { enabled: this.enabled, publicKey: this.publicKey, devices: this.count() };
  }

  subscribe(sub: { endpoint: string; keys: { p256dh: string; auth: string } }, meta: { ua?: string; email?: string }): void {
    if (!this.data) throw new Error('push is not enabled (set DASH_DATA_DIR)');
    if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) throw new Error('invalid subscription');
    // every alert is POSTed to the endpoint: a browser's push service is an https URL, anything else would point the server at an address of the caller's choosing
    if (!isPushEndpoint(sub.endpoint)) throw new Error('invalid subscription: the endpoint must be an https URL');
    this.data.subs = this.data.subs.filter((s) => s.endpoint !== sub.endpoint);
    this.data.subs.push({ endpoint: sub.endpoint, keys: sub.keys, ua: meta.ua?.slice(0, 120), email: meta.email, created: Date.now() });
    this.save();
  }

  unsubscribe(endpoint: string): boolean {
    if (!this.data) return false;
    const before = this.data.subs.length;
    this.data.subs = this.data.subs.filter((s) => s.endpoint !== endpoint);
    if (this.data.subs.length !== before) this.save();
    return this.data.subs.length !== before;
  }

  /** Send to every device; returns error strings (dead subscriptions are dropped silently). */
  async send(title: string, body: string, level: Alert['level'], link?: string, tag?: string): Promise<string[]> {
    if (!this.data || !this.data.subs.length) return [];
    const payload = JSON.stringify({
      notification: {
        title,
        body,
        icon: '/icons/icon-192x192.png',
        badge: '/icons/icon-96x96.png',
        tag: tag ?? title,
        renotify: true,
        requireInteraction: level === 'danger',
        data: { onActionClick: { default: { operation: 'navigateLastFocusedOrOpen', url: link ?? '/activity' } } },
      },
    });
    const errors: string[] = [];
    let changed = false;
    await Promise.all(
      this.data.subs.map(async (s) => {
        try {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, payload, { TTL: 3600, urgency: level === 'danger' ? 'high' : 'normal' });
        } catch (e) {
          const status = (e as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) {
            this.data!.subs = this.data!.subs.filter((x) => x.endpoint !== s.endpoint);
            changed = true;
          } else errors.push(`webpush ${status ?? ''}: ${(e as Error).message}`.trim());
        }
      }),
    );
    if (changed) this.save();
    return errors;
  }

  private save(): void {
    if (!this.file || !this.data) return;
    try {
      writeFileSync(this.file, JSON.stringify(this.data, null, 2), { mode: 0o600 });
      chmodSync(this.file, 0o600); // holds the VAPID private key; `mode` only applies to a new file, so an older one is tightened here
    } catch (e) {
      console.warn(`push store: ${(e as Error).message}`);
    }
  }
}

export function isPushEndpoint(raw: unknown): boolean {
  if (typeof raw !== 'string' || raw.length > 2048) return false;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}
