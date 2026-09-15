import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MkPageHeader, MkTabs, MkTab } from '@mk-kit/ui/navigation';
import { MkAlert, MkToastService, MkTooltip } from '@mk-kit/ui/feedback';
import { MkEmptyState, MkBadge } from '@mk-kit/ui/status';
import { MkButton } from '@mk-kit/ui/button';
import { MkIcon } from '@mk-kit/ui/icon';
import { MkTag } from '@mk-kit/ui/data';
import type { AlertsInfo, DockerEvent } from '../../../../shared/types';
import { ApiService, errorMessage } from '../core/api.service';
import { LiveService } from '../core/live.service';
import { ago, dateTimeSec as dateTime, duration } from '../core/format';
import { EventList } from '../shared/event-list';

/** What happened: active alerts, their history, and docker container events. */
@Component({
  selector: 'app-activity',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, MkPageHeader, MkTabs, MkTab, MkAlert, MkEmptyState, MkBadge, MkButton, MkIcon, MkTag, MkTooltip, EventList],
  template: `
    <div class="page">
      <mk-page-header heading="Activity" [description]="description()">
        <div mkPageHeaderActions class="row">
          @if (info(); as i) {
            @if (i.channels.length) {
              <mk-tag size="sm" variant="outline"><mk-icon name="bell" size="sm" /> {{ i.channels.join(', ') }}{{ live.meta()?.push?.devices ? ' · ' + live.meta()!.push.devices + ' device' + (live.meta()!.push.devices === 1 ? '' : 's') : '' }}</mk-tag>
              <button mkButton variant="outline" size="sm" [loading]="testing()" (click)="test()">Send test</button>
            } @else {
              <mk-tag size="sm" variant="outline" tone="warning" mkTooltip="Use the bell in the header on a device (needs HTTPS), or set DASH_TELEGRAM_* / DASH_WEBHOOK_URL"><mk-icon name="bell-off" size="sm" /> no notification channel yet</mk-tag>
            }
          }
          <button mkButton variant="ghost" size="sm" iconOnly aria-label="Refresh" class="row--inline" (click)="load()"><mk-icon name="refresh" /></button>
        </div>
      </mk-page-header>

      <h2 class="section-title first">Active alerts</h2>
      @if (live.alerts().length === 0) {
        <p class="muted">All clear.</p>
      } @else {
        <div class="alerts">
          @for (a of live.alerts(); track a.title) {
            <mk-alert [tone]="a.level" [title]="a.title">
              {{ a.detail }}
              <span class="muted"> · since {{ f.ago(a.since) }}</span>
              @if (a.link) {
                <a [routerLink]="a.link" class="alert-link">Open</a>
              }
            </mk-alert>
          }
        </div>
      }

      <mk-tabs [(selectedIndex)]="tab" class="tabs">
        <mk-tab label="Container events">
          <app-event-list [events]="events()" />
        </mk-tab>
        <mk-tab label="Alert history">
          @if (!info()?.history?.length) {
            <mk-empty-state icon="bell" title="Nothing yet" description="Alerts that persist longer than the notify delay are recorded here, and sent to the configured channels." />
          } @else {
            <ul class="hist">
              @for (h of info()!.history; track h.t + h.title) {
                <li class="hist__row">
                  <span class="hist__time muted nowrap">{{ f.dateTime(h.t) }}</span>
                  <mk-badge [tone]="h.type === 'cleared' ? 'success' : h.level === 'danger' ? 'danger' : h.level === 'warning' ? 'warning' : 'neutral'" size="sm">{{ h.type }}</mk-badge>
                  <span class="hist__title">
                    @if (h.link) {
                      <a [routerLink]="h.link" class="plain">{{ h.title }}</a>
                    } @else {
                      {{ h.title }}
                    }
                    @if (h.detail) {
                      <span class="muted"> — {{ h.detail }}</span>
                    }
                  </span>
                  @if (h.notified) {
                    <mk-icon name="bell" size="sm" class="muted" />
                  }
                </li>
              }
            </ul>
          }
        </mk-tab>
      </mk-tabs>
    </div>
  `,
  styles: [
    `
      .first {
        margin-top: 0;
      }
      .alerts {
        display: grid;
        gap: var(--mk-space-2);
      }
      .alert-link {
        margin-left: var(--mk-space-2);
        font-weight: var(--mk-font-weight-semibold);
      }
      .tabs {
        display: block;
        margin-top: var(--mk-space-5);
      }
      .hist {
        list-style: none;
        margin: var(--mk-space-3) 0 0;
        padding: 0;
      }
      .hist__row {
        display: grid;
        grid-template-columns: 170px auto 1fr auto;
        gap: var(--mk-space-3);
        align-items: center;
        padding: var(--mk-space-2) 0;
        border-bottom: 1px solid var(--mk-border-subtle);
        font-size: var(--mk-font-size-sm);
      }
      @media (max-width: 640px) {
        .hist__row {
          grid-template-columns: 1fr auto;
        }
      }
    `,
  ],
})
export class ActivityPage {
  private readonly api = inject(ApiService);
  private readonly toast = inject(MkToastService);
  protected readonly live = inject(LiveService);
  protected readonly f = { ago, dateTime, duration };
  protected readonly info = signal<AlertsInfo | null>(null);
  protected readonly events = signal<DockerEvent[]>([]);
  protected readonly tab = signal(0);
  protected readonly testing = signal(false);

  protected readonly description = computed(() => {
    const i = this.info();
    if (!i) return 'Alerts, their history and docker events';
    return `Alerts notify after ${Math.round(i.afterMs / 1000)} s (level ≥ ${i.minLevel}) · ${this.events().length} recent events`;
  });

  constructor() {
    void this.load();
    // container events re-fetch when the snapshot's container set changes (start/stop just happened)
    effect(() => {
      const key = this.live.containers().map((c) => c.id + c.state).join(',');
      void key;
      untracked(() => void this.loadEvents());
    });
  }

  async load(): Promise<void> {
    try {
      const [i] = await Promise.all([this.api.alerts(), this.loadEvents()]);
      this.info.set(i);
    } catch (e) {
      this.toast.danger(errorMessage(e));
    }
  }

  private async loadEvents(): Promise<void> {
    try {
      this.events.set(await this.api.events(300));
    } catch {
      /* keep what we have */
    }
  }

  async test(): Promise<void> {
    this.testing.set(true);
    try {
      const r = await this.api.notifyTest();
      this.toast.success(r.message);
    } catch (e) {
      this.toast.danger(errorMessage(e), { title: 'Notification failed' });
    } finally {
      this.testing.set(false);
    }
  }
}
