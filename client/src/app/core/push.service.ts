import { Injectable, computed, inject, signal } from '@angular/core';
import { SwPush } from '@angular/service-worker';
import { ApiService, errorMessage } from './api.service';

function isIos(): boolean {
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function isStandalone(): boolean {
  return window.matchMedia?.('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
}

export function pushBlocker(swEnabled: boolean): string | null {
  if (!window.isSecureContext) return 'Notifications need HTTPS — open the dashboard through its public address, not the LAN port.';
  if (!('serviceWorker' in navigator)) return 'This browser has no service worker support, so it cannot receive push notifications.';
  if (isIos() && !isStandalone()) return 'On iPhone and iPad, add the dashboard to the Home Screen first (Share → Add to Home Screen) and open it from there — Safari only allows push for installed apps.';
  if (typeof Notification === 'undefined' || !('PushManager' in window)) return 'This browser does not support web push notifications.';
  if (!swEnabled) return 'The service worker is not active yet — reload the page once and try again.';
  return null;
}

/**
 * Web push for this device: the browser's push subscription is registered with
 * the server, which sends every confirmed alert (and its resolution) to it.
 * Works only over HTTPS (the service worker needs a secure context).
 */
@Injectable({ providedIn: 'root' })
export class PushService {
  private readonly sw = inject(SwPush);
  private readonly api = inject(ApiService);

  readonly supported = signal(this.sw.isEnabled && typeof Notification !== 'undefined' && 'PushManager' in window);
  /** Why push cannot work here, in words for the user; null when it can. */
  readonly blocker = signal<string | null>(pushBlocker(this.sw.isEnabled));
  readonly permission = signal<NotificationPermission>(typeof Notification === 'undefined' ? 'denied' : Notification.permission);
  readonly subscribed = signal(false);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly serverEnabled = signal<boolean | null>(null);
  readonly devices = signal(0);

  /** Show the bell whenever the server can push; the tap explains the rest. */
  readonly available = computed(() => this.serverEnabled() !== false);

  private subscription: PushSubscription | null = null;

  constructor() {
    if (this.supported()) {
      this.sw.subscription.subscribe((s) => {
        this.subscription = s;
        this.subscribed.set(!!s);
      });
    }
  }

  async refresh(): Promise<void> {
    try {
      const info = await this.api.pushInfo();
      this.serverEnabled.set(info.enabled);
      this.devices.set(info.devices);
    } catch {
      this.serverEnabled.set(false);
    }
  }

  async toggle(): Promise<string | null> {
    if (this.blocker()) throw new Error(this.blocker()!);
    return this.subscribed() ? this.disable() : this.enable();
  }

  async enable(): Promise<string | null> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const info = await this.api.pushInfo();
      if (!info.enabled) throw new Error('Push is not enabled on the server (it needs DASH_DATA_DIR).');
      const sub = await this.sw.requestSubscription({ serverPublicKey: info.publicKey });
      this.permission.set(Notification.permission);
      const r = await this.api.pushSubscribe(sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } });
      this.subscription = sub;
      this.subscribed.set(true);
      this.devices.set(this.devices() + 1);
      return r.message;
    } catch (e) {
      this.permission.set(typeof Notification === 'undefined' ? 'denied' : Notification.permission);
      const msg = this.permission() === 'denied' ? 'Notifications are blocked for this site in the browser settings.' : errorMessage(e);
      this.error.set(msg);
      throw new Error(msg);
    } finally {
      this.busy.set(false);
    }
  }

  async disable(): Promise<string | null> {
    this.busy.set(true);
    try {
      const endpoint = this.subscription?.endpoint;
      await this.sw.unsubscribe().catch(() => undefined);
      this.subscribed.set(false);
      if (endpoint) {
        const r = await this.api.pushUnsubscribe(endpoint);
        return r.message;
      }
      return 'Notifications are off on this device';
    } finally {
      this.busy.set(false);
    }
  }
}
