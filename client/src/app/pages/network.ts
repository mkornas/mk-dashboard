import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MkPageHeader } from '@mk-kit/ui/navigation';
import { MkTable, type MkTableColumn, MkTableCell } from '@mk-kit/ui/table';
import { MkBadge, MkEmptyState } from '@mk-kit/ui/status';
import { MkButton } from '@mk-kit/ui/button';
import { MkIcon } from '@mk-kit/ui/icon';
import { MkTooltip, MkToastService } from '@mk-kit/ui/feedback';
import type { CheckResult } from '../../../../shared/types';
import { ApiService, errorMessage } from '../core/api.service';
import { LiveService } from '../core/live.service';
import { ago, dateTime } from '../core/format';

/** Reachability of the apps, the other machines and the certificates in front of them. */
@Component({
  selector: 'app-network',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MkPageHeader, MkTable, MkTableCell, MkBadge, MkEmptyState, MkButton, MkIcon, MkTooltip],
  template: `
    <div class="page">
      <mk-page-header heading="Network" [description]="summary()">
        <div mkPageHeaderActions>
          <button mkButton variant="outline" size="sm" [loading]="running()" (click)="runNow()"><mk-icon name="refresh" /> Check now</button>
        </div>
      </mk-page-header>

      @if (checks().length === 0) {
        <mk-empty-state icon="wifi" title="No checks configured" description="Add mk-dashboard.url labels to your stacks, or define DASH_CHECKS (JSON) / DASH_CHECKS_FILE — HTTP URLs or TCP host:port, with TLS certificate expiry." />
      } @else {
        <mk-table [columns]="columns" [data]="checks()" trackKey="name" density="compact" [stackAt]="760">
          <ng-template mkTableCell="name" let-value let-row="row">
            <strong>{{ value }}</strong>
            @if (row.group) {
              <span class="muted small"> · {{ row.group }}</span>
            }
            <div class="mono small muted">{{ row.target }}</div>
          </ng-template>
          <ng-template mkTableCell="up" let-value let-row="row">
            <mk-badge [tone]="value ? 'success' : 'danger'" size="sm">{{ value ? 'up' : 'down' }}</mk-badge>
            @if (!value && row.error) {
              <div class="small muted">{{ row.error }}</div>
            }
          </ng-template>
          <ng-template mkTableCell="latencyMs" let-value let-row="row">
            <span class="num">{{ value !== undefined ? value + ' ms' : '—' }}</span>
            @if (row.status) {
              <span class="muted small"> · HTTP {{ row.status }}</span>
            }
          </ng-template>
          <ng-template mkTableCell="certDaysLeft" let-value let-row="row">
            @if (value !== undefined) {
              <mk-badge [tone]="value <= 3 ? 'danger' : value <= 14 ? 'warning' : 'neutral'" size="sm" [mkTooltip]="(row.certSubject ?? '') + ' · ' + (row.certIssuer ?? '') + ' · ' + f.dateTime(row.certExpiresAt)">{{ value < 0 ? 'expired' : value + ' d' }}</mk-badge>
            } @else {
              <span class="muted">—</span>
            }
          </ng-template>
          <ng-template mkTableCell="since" let-value let-row="row">
            <span class="nowrap">{{ f.ago(value) }}</span>
            <div class="muted small">checked {{ f.ago(row.checkedAt) }}</div>
          </ng-template>
        </mk-table>
      }
    </div>
  `,
  styles: [
    `
      .small {
        font-size: var(--mk-font-size-xs);
      }
      .num {
        font-variant-numeric: tabular-nums;
      }
    `,
  ],
})
export class NetworkPage {
  private readonly api = inject(ApiService);
  private readonly toast = inject(MkToastService);
  protected readonly live = inject(LiveService);
  protected readonly f = { ago, dateTime };
  protected readonly running = signal(false);

  protected readonly checks = computed<CheckResult[]>(() => this.live.snapshot()?.checks ?? []);
  protected readonly summary = computed(() => {
    const c = this.checks();
    if (!c.length) return 'HTTP and TCP probes with certificate expiry';
    const down = c.filter((x) => !x.up).length;
    const certs = c.filter((x) => x.certDaysLeft !== undefined);
    const soon = certs.filter((x) => (x.certDaysLeft ?? 99) <= 14).length;
    return `${c.length - down}/${c.length} up${down ? ` · ${down} down` : ''} · ${certs.length} certificates${soon ? ` · ${soon} expiring soon` : ''}`;
  });

  protected readonly columns: MkTableColumn<CheckResult>[] = [
    { key: 'name', header: 'Check', sortable: true, stack: 'title' },
    { key: 'up', header: 'State', sortable: true, width: '220px' },
    { key: 'latencyMs', header: 'Latency', sortable: true, align: 'end', width: '150px' },
    { key: 'certDaysLeft', header: 'Certificate', sortable: true, width: '120px' },
    { key: 'since', header: 'In this state', sortable: true, width: '170px' },
  ];

  async runNow(): Promise<void> {
    this.running.set(true);
    try {
      await this.api.runChecks();
    } catch (e) {
      this.toast.danger(errorMessage(e), { title: 'Checks failed' });
    } finally {
      this.running.set(false);
    }
  }
}
