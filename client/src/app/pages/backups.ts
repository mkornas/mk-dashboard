import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { MkPageHeader } from '@mk-kit/ui/navigation';
import { MkTable, type MkTableColumn, MkTableCell } from '@mk-kit/ui/table';
import { MkCard, MkCardHeader, MkCardTitle, MkLogViewer, MkSkeletonPreset } from '@mk-kit/ui/data';
import { MkBadge, MkEmptyState } from '@mk-kit/ui/status';
import { MkButton } from '@mk-kit/ui/button';
import { MkIcon } from '@mk-kit/ui/icon';
import type { BackupSet, BackupsInfo } from '../../../../shared/types';
import { ApiService, errorMessage } from '../core/api.service';
import { ago, bytes, dateTime } from '../core/format';

/** Backup freshness per app, straight from the backups directory. */
@Component({
  selector: 'app-backups',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MkPageHeader, MkTable, MkTableCell, MkCard, MkCardHeader, MkCardTitle, MkLogViewer, MkSkeletonPreset, MkBadge, MkEmptyState, MkButton, MkIcon],
  template: `
    <div class="page">
      <mk-page-header heading="Backups" [description]="info() ? 'Newest file (or log entry) per app in ' + info()!.dir + ' — stale after ' + info()!.staleAfterHours + ' h' : ''">
        <div mkPageHeaderActions>
          <button mkButton variant="outline" size="sm" [loading]="loading()" (click)="load()"><mk-icon name="refresh" /> Refresh</button>
        </div>
      </mk-page-header>

      @if (error(); as e) {
        <mk-empty-state icon="octagon-alert" title="Could not read backups" [description]="e" />
      } @else if (!info()) {
        <mk-skeleton-preset preset="table" [rows]="4" />
      } @else if (!info()!.available) {
        <mk-empty-state icon="archive" title="No backups directory" [description]="info()!.dir + ' is not mounted or does not exist. Set DASH_BACKUP_DIR and mount it read-only.'" />
      } @else {
        <mk-table [columns]="columns" [data]="info()!.sets" trackKey="name" [stackAt]="700">
          <ng-template mkTableCell="name" let-value let-row="row">
            <strong>{{ value }}</strong>
            <div class="muted mono small">{{ row.path }}</div>
          </ng-template>
          <ng-template mkTableCell="stale" let-row="row">
            @if (!row.latest) {
              <mk-badge tone="neutral" size="sm">empty</mk-badge>
            } @else if (row.stale) {
              <mk-badge tone="danger" size="sm">stale</mk-badge>
            } @else {
              <mk-badge tone="success" size="sm">fresh</mk-badge>
            }
          </ng-template>
          <ng-template mkTableCell="latest" let-row="row">
            @if (row.latest) {
              <span class="mono small">{{ row.latest.name }}</span>
              <div class="muted small">{{ f.dateTime(row.latest.mtime) }} · {{ f.ago(row.latest.mtime) }} · {{ f.bytes(row.latest.size) }}</div>
            } @else {
              <span class="muted">—</span>
            }
            @if (row.lastRun) {
              <div class="muted small">last run {{ f.ago(row.lastRun) }} (log)</div>
            }
          </ng-template>
        </mk-table>

        @if (info()!.log.length) {
          <mk-card padding="none" class="log">
            <mk-card-header class="log__head"><mk-card-title>backup.log</mk-card-title></mk-card-header>
            <mk-log-viewer [lines]="info()!.log" [follow]="true" [wrap]="true" [itemHeight]="22" class="log__view" ariaLabel="Backup log" />
          </mk-card>
        }
      }
    </div>
  `,
  styles: [
    `
      .small {
        font-size: var(--mk-font-size-xs);
      }
      .log {
        margin-top: var(--mk-space-5);
        overflow: hidden;
      }
      .log__head {
        padding: var(--mk-space-3) var(--mk-space-4) 0;
      }
      .log__view {
        display: block;
        height: 320px;
      }
    `,
  ],
})
export class BackupsPage {
  private readonly api = inject(ApiService);
  protected readonly f = { ago, bytes, dateTime };
  protected readonly info = signal<BackupsInfo | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly columns: MkTableColumn<BackupSet>[] = [
    { key: 'name', header: 'App', sortable: true, stack: 'title' },
    { key: 'stale', header: 'State', width: '110px' },
    { key: 'latest', header: 'Newest file' },
    { key: 'files', header: 'Files', sortable: true, align: 'end', width: '90px' },
    { key: 'totalSize', header: 'Total', sortable: true, align: 'end', width: '110px', format: (v) => bytes(v as number) },
  ];

  constructor() {
    void this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    try {
      this.info.set(await this.api.backups());
      this.error.set(null);
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.loading.set(false);
    }
  }
}
