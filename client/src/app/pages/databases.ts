import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { MkPageHeader } from '@mk-kit/ui/navigation';
import { MkTable, type MkTableColumn, MkTableCell } from '@mk-kit/ui/table';
import { MkSkeletonPreset } from '@mk-kit/ui/data';
import { MkBadge, MkEmptyState } from '@mk-kit/ui/status';
import { MkButton } from '@mk-kit/ui/button';
import { MkIcon } from '@mk-kit/ui/icon';
import type { SqliteDb } from '../../../../shared/types';
import { ApiService, errorMessage } from '../core/api.service';
import { ago, bytes } from '../core/format';

/** Every SQLite file the stacks keep, with size, WAL, owner and the newest snapshot. */
@Component({
  selector: 'app-databases',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    MkPageHeader,
    MkTable,
    MkTableCell,
    MkSkeletonPreset,
    MkBadge,
    MkEmptyState,
    MkButton,
    MkIcon,
  ],
  template: `
    <div class="page">
      <mk-page-header
        heading="Databases"
        description="The SQLite files under the stacks directories: look inside, take a snapshot, put one back."
      >
        <div mkPageHeaderActions>
          <button mkButton variant="outline" size="sm" [loading]="loading()" (click)="load()">
            <mk-icon name="refresh" /> Refresh
          </button>
        </div>
      </mk-page-header>

      @if (error(); as e) {
        <mk-empty-state icon="octagon-alert" title="Could not list databases" [description]="e" />
      } @else if (!list()) {
        <mk-skeleton-preset preset="table" [rows]="4" />
      } @else if (list()!.length === 0) {
        <mk-empty-state
          icon="database"
          title="No SQLite files found"
          description="Nothing under the directories in DASH_SQLITE_DIRS (default /srv/stacks through the host mount) looks like a SQLite database, and nothing is named in DASH_SQLITE."
        />
      } @else {
        <mk-table
          [columns]="columns"
          [data]="list()!"
          trackKey="path"
          [stackAt]="760"
          [clickableRows]="true"
          (rowClick)="open($event)"
        >
          <ng-template mkTableCell="name" let-row="row">
            <strong>{{ row.name }}</strong>
            <div class="muted mono small">{{ row.path }}</div>
          </ng-template>
          <ng-template mkTableCell="stack" let-row="row">
            {{ row.stack ?? '—' }}
            @if (row.container) {
              <div class="muted small">{{ row.container.name }} · {{ row.container.state }}</div>
            }
          </ng-template>
          <ng-template mkTableCell="size" let-row="row">
            <span class="num">{{ f.bytes(row.size) }}</span>
            @if (row.walSize) {
              <div class="muted small">+ {{ f.bytes(row.walSize) }} WAL</div>
            }
          </ng-template>
          <ng-template mkTableCell="mtime" let-row="row"
            ><span class="muted">{{ f.ago(row.mtime) }}</span></ng-template
          >
          <ng-template mkTableCell="snapshot" let-row="row">
            @if (row.lastSnapshot) {
              <mk-badge tone="success" size="sm">{{ f.ago(row.lastSnapshot.at) }}</mk-badge>
            } @else {
              <mk-badge tone="neutral" size="sm">none</mk-badge>
            }
          </ng-template>
          <ng-template mkTableCell="writable" let-row="row">
            @if (!row.writable) {
              <mk-badge tone="neutral" size="sm">read-only mount</mk-badge>
            }
          </ng-template>
        </mk-table>
      }
    </div>
  `,
  styles: [
    `
      .small {
        font-size: var(--mk-font-size-xs);
        overflow-wrap: anywhere;
      }
    `,
  ],
})
export class DatabasesPage {
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);
  protected readonly f = { ago, bytes };
  protected readonly list = signal<SqliteDb[] | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly columns: MkTableColumn<SqliteDb>[] = [
    { key: 'name', header: 'Database', stack: 'title' },
    { key: 'stack', header: 'Stack' },
    { key: 'size', header: 'Size', align: 'end', width: '130px' },
    { key: 'mtime', header: 'Changed', width: '120px' },
    { key: 'snapshot', header: 'Snapshot', width: '120px' },
    { key: 'writable', header: '', width: '150px' },
  ];

  constructor() {
    void this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    try {
      this.list.set(await this.api.sqliteList());
      this.error.set(null);
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.loading.set(false);
    }
  }

  open(db: SqliteDb): void {
    void this.router.navigate(['/databases/db'], { queryParams: { path: db.path } });
  }
}
