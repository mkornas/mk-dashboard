import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { MkPageHeader } from '@mk-kit/ui/navigation';
import { MkButton } from '@mk-kit/ui/button';
import { MkIcon } from '@mk-kit/ui/icon';
import { MkSkeletonPreset } from '@mk-kit/ui/data';
import { MkBadge, MkEmptyState } from '@mk-kit/ui/status';
import type { NasInfo } from '../../../../shared/types';
import { ApiService, errorMessage } from '../core/api.service';
import { ago } from '../core/format';

/** What the mk-nas agent says about its pools and disks; the full console is in mk-drive. */
@Component({
  selector: 'app-nas',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MkPageHeader, MkButton, MkIcon, MkSkeletonPreset, MkBadge, MkEmptyState],
  template: `
    <div class="page">
      <mk-page-header
        heading="NAS"
        [description]="
          info()?.hostname
            ? 'mk-nasd ' +
              info()!.agent +
              ' on ' +
              info()!.hostname +
              ', asked ' +
              f.ago(info()!.at)
            : 'The mk-nas agent, asked once a minute.'
        "
      >
        <div mkPageHeaderActions>
          <button mkButton variant="outline" size="sm" [loading]="loading()" (click)="load()">
            <mk-icon name="refresh" /> Refresh
          </button>
        </div>
      </mk-page-header>

      @if (error(); as e) {
        <mk-empty-state icon="octagon-alert" title="NAS mode is off" [description]="e" />
      } @else if (!info()) {
        <mk-skeleton-preset preset="list" [rows]="4" />
      } @else if (!info()!.reachable) {
        <mk-empty-state
          icon="octagon-alert"
          title="The NAS agent is unreachable"
          [description]="info()!.error ?? ''"
        />
      } @else if (info()!.health; as h) {
        @if (h.problems.length) {
          <ul class="problems">
            @for (p of h.problems; track p) {
              <li>{{ p }}</li>
            }
          </ul>
        } @else {
          <p class="ok">
            <mk-icon name="check" /> Every pool is online and every disk reports healthy.
          </p>
        }
        <h2>Pools</h2>
        <ul class="list">
          @for (p of h.pools; track p.name) {
            <li>
              <span class="mono">{{ p.name }}</span>
              <mk-badge
                [tone]="
                  p.health === 'ONLINE' ? 'success' : p.health === 'DEGRADED' ? 'warning' : 'danger'
                "
                size="sm"
                >{{ p.health }}</mk-badge
              >
              <span class="muted">{{ p.capacity }}% used</span>
            </li>
          }
        </ul>
        <h2>Disks</h2>
        <ul class="list">
          @for (d of h.disks; track d.id) {
            <li>
              <span class="mono">{{ d.id }}</span>
              <mk-badge [tone]="d.ok ? 'success' : 'danger'" size="sm">{{
                d.ok ? 'healthy' : d.reason
              }}</mk-badge>
            </li>
          }
        </ul>
      }
    </div>
  `,
  styles: [
    `
      .problems {
        margin: 0 0 var(--mk-space-4);
        padding-left: 1.2em;
        color: var(--mk-danger);
      }
      .ok {
        display: flex;
        align-items: center;
        gap: var(--mk-space-2);
        color: var(--mk-success);
      }
      h2 {
        font-size: var(--mk-font-size-lg);
        margin: var(--mk-space-4) 0 var(--mk-space-2);
      }
      .list {
        list-style: none;
        padding: 0;
        margin: 0;
        display: grid;
        gap: var(--mk-space-1);
      }
      .list li {
        display: flex;
        align-items: center;
        gap: var(--mk-space-2);
        flex-wrap: wrap;
      }
    `,
  ],
})
export class NasPage {
  private readonly api = inject(ApiService);
  protected readonly f = { ago };
  protected readonly info = signal<NasInfo | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly loading = signal(false);

  constructor() {
    void this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    try {
      this.info.set(await this.api.nas());
      this.error.set(null);
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.loading.set(false);
    }
  }
}
