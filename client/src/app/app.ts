import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { NavigationEnd, Router, RouterOutlet } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter, map } from 'rxjs';
import { MkThemeService } from '@mk-kit/ui/core';
import { MkButton } from '@mk-kit/ui/button';
import { MkIcon } from '@mk-kit/ui/icon';
import { MkBadge, MkEmptyState } from '@mk-kit/ui/status';
import { MkToastContainer, MkTooltip } from '@mk-kit/ui/feedback';
import { MkAppShell, MkNavItem, MkNavList } from '@mk-kit/ui/navigation';
import { LiveService } from './core/live.service';
import { PushService } from './core/push.service';
import { MkToastService } from '@mk-kit/ui/feedback';
import { ago } from './core/format';

interface NavLink {
  label: string;
  path: string;
  icon: string;
}

const NAV: NavLink[] = [
  { label: 'Overview', path: '/', icon: 'layout-dashboard' },
  { label: 'Containers', path: '/containers', icon: 'boxes' },
  { label: 'Network', path: '/network', icon: 'wifi' },
  { label: 'Activity', path: '/activity', icon: 'bell' },
  { label: 'Backups', path: '/backups', icon: 'archive' },
  { label: 'NAS', path: '/nas', icon: 'hard-drive' },
  { label: 'Databases', path: '/databases', icon: 'database' },
  { label: 'System', path: '/system', icon: 'server' },
];

/** The frame: header with live status and theme toggle, sidebar navigation. */
@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, MkAppShell, MkNavList, MkNavItem, MkButton, MkIcon, MkBadge, MkEmptyState, MkToastContainer, MkTooltip],
  template: `
    <mk-app-shell #shell [(sidebarCollapsed)]="collapsed">
      <div mkAppHeader class="hdr">
        <button mkButton variant="ghost" iconOnly class="hdr__menu" aria-label="Toggle navigation" (click)="shell.isMobile() ? shell.toggleSidebar() : shell.toggleCollapsed()">
          <mk-icon name="menu" />
        </button>
        <a class="hdr__brand" href="/" (click)="go($event, '/')">
          <span class="hdr__logo"><mk-icon name="activity" size="sm" /></span>
          <span class="hdr__name">{{ hostname() }}</span>
        </a>
        <div class="hdr__spacer"></div>
        @if (alertCount() > 0) {
          <a href="/activity" class="hdr__alerts" (click)="go($event, '/activity')" [mkTooltip]="alertCount() + ' active alert' + (alertCount() === 1 ? '' : 's')">
            <mk-badge [tone]="alertTone()" size="sm"><mk-icon name="octagon-alert" size="sm" /> {{ alertCount() }}</mk-badge>
          </a>
        }
        <span class="hdr__live" [class.hdr__live--off]="!live.connected()" [mkTooltip]="live.connected() ? 'Streaming from the server, updated ' + lastUpdate() : 'Connection lost, retrying'">
          <span class="hdr__dot"></span>
          {{ live.connected() ? 'Live' : 'Reconnecting…' }}
        </span>
        @if (live.me(); as me) {
          @if (me.via === 'access' || me.via === 'sso') {
            <mk-badge tone="neutral" variant="outline" size="sm" class="hdr__user" [mkTooltip]="(me.via === 'access' ? 'Signed in through Cloudflare Access' : 'Signed in with ' + (live.meta()?.sso?.name ?? 'single sign-on')) + (me.canAct ? '' : ' · view only')"><mk-icon name="user" size="sm" /> {{ me.email }}</mk-badge>
          }
          @if (me.via === 'sso') {
            <button mkButton variant="ghost" iconOnly aria-label="Sign out" mkTooltip="Sign out" (click)="signOut()">
              <mk-icon name="log-out" />
            </button>
          }
        }
        @if (live.readonly() && live.meta() && live.me()) {
          <mk-badge tone="neutral" variant="outline" size="sm" [mkTooltip]="live.meta()!.readonly ? 'Actions are disabled (DASH_READONLY)' : 'This account may only view'">read-only</mk-badge>
        }
        @if (push.available()) {
          <button mkButton variant="ghost" iconOnly [loading]="push.busy()" [attr.aria-label]="push.subscribed() ? 'Turn off notifications on this device' : 'Get alerts on this device'" [mkTooltip]="push.subscribed() ? 'Alerts are pushed to this device' : push.blocker() ? 'Notifications: ' + push.blocker() : 'Get alerts on this device'" (click)="togglePush()">
            <mk-icon [name]="push.subscribed() ? 'bell-ring' : 'bell-off'" [class.muted]="!!push.blocker()" />
          </button>
        }
        <button mkButton variant="ghost" iconOnly [attr.aria-label]="theme.isDark() ? 'Switch to light theme' : 'Switch to dark theme'" (click)="theme.toggle()">
          <mk-icon [name]="theme.isDark() ? 'sun' : 'moon'" />
        </button>
      </div>

      <mk-nav-list mkAppSidebar [collapsed]="collapsed()">
        @for (link of nav; track link.path) {
          <mk-nav-item [label]="link.label" [href]="link.path" [active]="isActive(link.path)" [badge]="badgeFor(link.path)" (click)="go($event, link.path)">
            <mk-icon mkNavIcon [name]="link.icon" />
          </mk-nav-item>
        }
      </mk-nav-list>

      @if (live.signedOut(); as out) {
        <div class="signed-out">
          <mk-empty-state icon="key" title="Not signed in" [description]="out.reason">
            <a mkEmptyStateActions mkButton [href]="signInHref()"><mk-icon name="log-in" /> Sign in with {{ live.meta()?.sso?.name ?? 'single sign-on' }}</a>
          </mk-empty-state>
        </div>
      } @else {
        <router-outlet />
      }
    </mk-app-shell>
    <mk-toast-container />
  `,
  styles: [
    `
      .hdr {
        display: flex;
        align-items: center;
        gap: var(--mk-space-2);
        width: 100%;
        padding: 0 var(--mk-space-4);
      }
      .hdr__brand {
        display: inline-flex;
        align-items: center;
        gap: var(--mk-space-2);
        color: inherit;
        text-decoration: none;
        font-weight: var(--mk-font-weight-semibold);
      }
      .hdr__logo {
        display: inline-grid;
        place-items: center;
        width: 28px;
        height: 28px;
        border-radius: var(--mk-radius-md);
        background: var(--mk-primary);
        color: var(--mk-primary-contrast, #fff);
      }
      .hdr__spacer {
        flex: 1;
      }
      .signed-out {
        display: grid;
        place-items: center;
        min-height: 60vh;
        padding: var(--mk-space-8) var(--mk-space-4);
      }
      .hdr__alerts {
        display: inline-flex;
        text-decoration: none;
      }
      .hdr__live {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: var(--mk-font-size-sm);
        color: var(--mk-text-muted);
        padding: 2px 8px;
        border-radius: 999px;
        border: 1px solid var(--mk-border-subtle);
      }
      .hdr__dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--mk-success);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--mk-success) 25%, transparent);
      }
      .hdr__live--off .hdr__dot {
        background: var(--mk-danger);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--mk-danger) 25%, transparent);
        animation: blink 1s infinite;
      }
      @keyframes blink {
        50% {
          opacity: 0.3;
        }
      }
      @media (max-width: 640px) {
        .hdr {
          padding: 0 var(--mk-space-3);
          gap: var(--mk-space-1);
        }
        .hdr__live,
        .hdr__name,
        .hdr__user {
          display: none;
        }
      }
    `,
  ],
})
export class App {
  protected readonly live = inject(LiveService);
  protected readonly push = inject(PushService);
  private readonly toast = inject(MkToastService);
  protected readonly theme = inject(MkThemeService);
  private readonly router = inject(Router);
  protected readonly nav = NAV;
  protected readonly collapsed = signal(false);

  private readonly url = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map((e) => e.urlAfterRedirects),
    ),
    { initialValue: this.router.url },
  );

  protected readonly hostname = computed(() => this.live.snapshot()?.info.hostname ?? this.live.meta()?.hostname ?? 'mk-dashboard');
  protected readonly alertCount = computed(() => this.live.alerts().length);
  protected readonly alertTone = computed(() => (this.live.alerts().some((a) => a.level === 'danger') ? 'danger' : 'warning'));
  protected readonly lastUpdate = computed(() => ago(this.live.lastUpdate()));
  protected readonly signInHref = computed(() => {
    const out = this.live.signedOut();
    return out ? `${out.loginUrl}?next=${encodeURIComponent(this.url())}` : '';
  });

  constructor() {
    this.live.start();
    void this.push.refresh();
  }

  protected signOut(): void {
    void this.live.signOut();
  }

  async togglePush(): Promise<void> {
    try {
      const msg = await this.push.toggle();
      if (msg) this.toast.success(msg);
    } catch (e) {
      const msg = (e as Error).message;
      if (this.push.blocker()) this.toast.warning(msg, { title: 'Notifications are not available here yet', duration: 12_000 });
      else this.toast.danger(msg, { title: 'Notifications' });
    }
  }

  isActive(path: string): boolean {
    const u = this.url();
    return path === '/' ? u === '/' : u.startsWith(path);
  }

  badgeFor(path: string): string | undefined {
    const s = this.live.snapshot();
    if (!s) return undefined;
    if (path === '/containers') return s.docker ? `${s.docker.running}/${s.docker.containers}` : undefined;
    if (path === '/network') {
      const down = s.checks.filter((c) => !c.up).length;
      return down ? `${down} down` : undefined;
    }
    if (path === '/activity') return s.alerts.length ? String(s.alerts.length) : undefined;
    return undefined;
  }

  go(ev: Event, path: string): void {
    ev.preventDefault();
    void this.router.navigateByUrl(path);
  }
}
