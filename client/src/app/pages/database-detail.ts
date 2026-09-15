import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { map } from 'rxjs';
import { MkBreadcrumb, MkBreadcrumbItem, MkPageHeader, MkTab, MkTabs } from '@mk-kit/ui/navigation';
import {
  MkCard,
  MkCardHeader,
  MkCardTitle,
  MkCode,
  MkDescItem,
  MkDescriptionList,
  MkSkeletonPreset,
} from '@mk-kit/ui/data';
import { MkTable, type MkTableColumn, MkTableCell } from '@mk-kit/ui/table';
import { MkBadge, MkEmptyState } from '@mk-kit/ui/status';
import { MkButton } from '@mk-kit/ui/button';
import { MkIcon } from '@mk-kit/ui/icon';
import { MkAlert, MkDialogService, MkToastService } from '@mk-kit/ui/feedback';
import type {
  SqliteDbDetail,
  SqliteHealth,
  SqliteQueryResult,
  SqliteRows,
  SqliteTable,
} from '../../../../shared/types';
import { ApiService, errorMessage } from '../core/api.service';
import { LiveService } from '../core/live.service';
import { ago, bytes, dateTime } from '../core/format';

/** One SQLite file: its tables and rows, a read-only query, snapshots and restore, health. */
@Component({
  selector: 'app-database-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    MkBreadcrumb,
    MkBreadcrumbItem,
    MkPageHeader,
    MkTabs,
    MkTab,
    MkCard,
    MkCardHeader,
    MkCardTitle,
    MkCode,
    MkDescItem,
    MkDescriptionList,
    MkSkeletonPreset,
    MkTable,
    MkTableCell,
    MkBadge,
    MkEmptyState,
    MkButton,
    MkIcon,
    MkAlert,
  ],
  template: `
    <div class="page">
      <mk-breadcrumb>
        <mk-breadcrumb-item routerLink="/databases">Databases</mk-breadcrumb-item>
        <mk-breadcrumb-item>{{ db()?.name ?? '…' }}</mk-breadcrumb-item>
      </mk-breadcrumb>

      @if (error(); as e) {
        <mk-empty-state
          icon="octagon-alert"
          title="Could not open the database"
          [description]="e"
        />
      } @else if (!db()) {
        <mk-skeleton-preset preset="table" [rows]="5" />
      } @else if (db(); as d) {
        <mk-page-header [heading]="d.name" [description]="d.path">
          <div mkPageHeaderActions class="actions">
            @if (!live.readonly()) {
              <button mkButton size="sm" [loading]="snapshotting()" (click)="snapshot()">
                <mk-icon name="camera" /> Snapshot now
              </button>
            }
            <button mkButton variant="outline" size="sm" [loading]="loading()" (click)="load()">
              <mk-icon name="refresh" /> Refresh
            </button>
          </div>
        </mk-page-header>

        @if (d.immutable) {
          <mk-alert tone="warning" title="May be slightly behind">
            The write-ahead log cannot be read on this mount (its <span class="mono">-shm</span> file is not usable here), so
            the file was opened immutable: changes the app has not checkpointed yet are not shown, and a snapshot
            leaves them out too.
          </mk-alert>
        }

        <mk-description-list layout="grid" class="facts">
          <mk-desc-item term="Stack">{{ d.stack ?? '—' }}</mk-desc-item>
          <mk-desc-item term="Container">
            @if (d.container) {
              <a [routerLink]="['/containers', d.container.id]">{{ d.container.name }}</a> ·
              {{ d.container.state }}
            } @else {
              —
            }
          </mk-desc-item>
          <mk-desc-item term="Size"
            >{{ f.bytes(d.size) }}
            @if (d.walSize) {
              + {{ f.bytes(d.walSize) }} WAL
            }
          </mk-desc-item>
          <mk-desc-item term="Pages"
            >{{ d.pageCount }} × {{ f.bytes(d.pageSize, 0) }}
            @if (d.freelistCount) {
              · {{ d.freelistCount }} free
            }
          </mk-desc-item>
          <mk-desc-item term="Journal">{{ d.journalMode }}</mk-desc-item>
          <mk-desc-item term="Schema version">{{ d.userVersion }}</mk-desc-item>
          <mk-desc-item term="Changed">{{ f.dateTime(d.mtime) }}</mk-desc-item>
          <mk-desc-item term="Restore">{{
            d.writable ? 'possible' : 'read-only mount — browse and snapshot only'
          }}</mk-desc-item>
        </mk-description-list>

        <mk-tabs>
          <mk-tab label="Tables">
            <div class="split">
              <ul class="tables">
                @for (t of d.tables; track t.name) {
                  <li>
                    <button
                      type="button"
                      class="tables__item"
                      [class.tables__item--on]="t.name === table()"
                      (click)="pick(t)"
                    >
                      <mk-icon [name]="t.kind === 'view' ? 'eye' : 'table'" size="sm" />
                      <span class="tables__name">{{ t.name }}</span>
                      <span class="muted small">{{ t.rows === null ? '' : t.rows }}</span>
                    </button>
                  </li>
                }
              </ul>
              <div class="browse">
                @if (current(); as t) {
                  <div class="browse__head">
                    <strong>{{ t.name }}</strong>
                    <span class="muted small"
                      >{{ t.columns.length }} columns
                      @if (rows()) {
                        · {{ rows()!.total }} rows
                      }
                    </span>
                    <span class="spacer"></span>
                    <a
                      mkButton
                      variant="ghost"
                      size="sm"
                      [href]="api.sqliteExportUrl(d.path, t.name, 'csv')"
                      download
                      ><mk-icon name="download" size="sm" /> CSV</a
                    >
                    <a
                      mkButton
                      variant="ghost"
                      size="sm"
                      [href]="api.sqliteExportUrl(d.path, t.name, 'json')"
                      download
                      ><mk-icon name="download" size="sm" /> JSON</a
                    >
                    <button
                      mkButton
                      variant="ghost"
                      size="sm"
                      (click)="showSchema.set(!showSchema())"
                    >
                      {{ showSchema() ? 'Rows' : 'Schema' }}
                    </button>
                  </div>
                  @if (showSchema()) {
                    <mk-code [code]="t.sql" language="plaintext" wrap />
                  } @else if (rows(); as r) {
                    <div class="grid-wrap">
                      <table class="rows">
                        <thead>
                          <tr>
                            @for (c of r.columns; track c) {
                              <th (click)="sortBy(c)" [class.th--on]="sort() === c">
                                {{ c }}
                                @if (sort() === c) {
                                  {{ dir() === 'asc' ? '▲' : '▼' }}
                                }
                              </th>
                            }
                          </tr>
                        </thead>
                        <tbody>
                          @for (row of r.rows; track $index) {
                            <tr>
                              @for (v of row; track $index) {
                                <td [class.null]="v === null" [title]="text(v)">
                                  {{ v === null ? 'NULL' : v }}
                                </td>
                              }
                            </tr>
                          }
                        </tbody>
                      </table>
                    </div>
                    <div class="pager">
                      <button
                        mkButton
                        variant="ghost"
                        size="sm"
                        [disabled]="r.offset === 0"
                        (click)="page(-1)"
                      >
                        Previous
                      </button>
                      <span class="muted small"
                        >{{ r.offset + 1 }}–{{ r.offset + r.rows.length }} of {{ r.total }}</span
                      >
                      <button
                        mkButton
                        variant="ghost"
                        size="sm"
                        [disabled]="r.offset + r.limit >= r.total"
                        (click)="page(1)"
                      >
                        Next
                      </button>
                    </div>
                  } @else {
                    <mk-skeleton-preset preset="table" [rows]="6" />
                  }
                } @else {
                  <mk-empty-state
                    icon="table"
                    title="Pick a table"
                    description="Rows show here; the schema is one click away."
                  />
                }
              </div>
            </div>
          </mk-tab>

          <mk-tab label="Query">
            <p class="muted small">
              One statement — SELECT, WITH, EXPLAIN or PRAGMA — on a read-only connection, at most
              1,000 rows.
            </p>
            <textarea
              class="sql"
              [value]="sql()"
              (input)="sql.set($any($event.target).value)"
              (keydown.control.enter)="run()"
              (keydown.meta.enter)="run()"
              spellcheck="false"
              placeholder="SELECT * FROM … LIMIT 50"
              aria-label="SQL"
            ></textarea>
            <div class="actions">
              <button
                mkButton
                size="sm"
                [loading]="running()"
                [disabled]="!sql().trim()"
                (click)="run()"
              >
                <mk-icon name="play" size="sm" /> Run <span class="muted small">⌘↵</span>
              </button>
              @if (result(); as q) {
                <span class="muted small"
                  >{{ q.rows.length }} row{{ q.rows.length === 1 ? '' : 's'
                  }}{{ q.truncated ? ' (capped)' : '' }} · {{ q.ms }} ms</span
                >
              }
            </div>
            @if (queryError(); as e) {
              <p class="error small">{{ e }}</p>
            }
            @if (result(); as q) {
              @if (q.columns.length) {
                <div class="grid-wrap">
                  <table class="rows">
                    <thead>
                      <tr>
                        @for (c of q.columns; track c) {
                          <th>{{ c }}</th>
                        }
                      </tr>
                    </thead>
                    <tbody>
                      @for (row of q.rows; track $index) {
                        <tr>
                          @for (v of row; track $index) {
                            <td [class.null]="v === null">{{ v === null ? 'NULL' : v }}</td>
                          }
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>
              }
            }
          </mk-tab>

          <mk-tab label="Snapshots">
            <p class="muted small">
              A snapshot is a consistent copy made through SQLite's online backup, safe while the
              app runs. Restore stops the owning container, keeps the current file next to it as
              <span class="mono">.before-restore</span>, copies the snapshot over, and starts the
              container again.
            </p>
            @if (d.snapshots.length === 0) {
              <mk-empty-state
                icon="camera"
                title="No snapshots yet"
                description="Take one with the button above; they live in the dashboard's data directory."
              />
            } @else {
              <mk-table
                [columns]="snapColumns"
                [data]="d.snapshots"
                trackKey="file"
                [stackAt]="600"
              >
                <ng-template mkTableCell="file" let-row="row"
                  ><span class="mono small">{{ row.file }}</span></ng-template
                >
                <ng-template mkTableCell="at" let-row="row"
                  >{{ f.dateTime(row.at) }}
                  <span class="muted small">· {{ f.ago(row.at) }}</span></ng-template
                >
                <ng-template mkTableCell="size" let-row="row"
                  ><span class="num">{{ f.bytes(row.size) }}</span></ng-template
                >
                <ng-template mkTableCell="actions" let-row="row">
                  @if (!live.readonly()) {
                    <button
                      mkButton
                      size="sm"
                      variant="outline"
                      tone="danger"
                      [disabled]="!d.writable"
                      (click)="restore(row.file)"
                    >
                      <mk-icon name="history" size="sm" /> Restore
                    </button>
                  }
                </ng-template>
              </mk-table>
            }
          </mk-tab>

          <mk-tab label="Health">
            <div class="actions">
              <button mkButton size="sm" variant="outline" [loading]="checking()" (click)="check()">
                <mk-icon name="shield-check" size="sm" /> Run integrity check
              </button>
              @if (health(); as h) {
                <mk-badge [tone]="h.ok ? 'success' : 'danger'" size="sm">{{
                  h.ok ? 'ok' : 'problems'
                }}</mk-badge>
                <span class="muted small">{{ h.ms }} ms · {{ f.ago(h.checkedAt) }}</span>
              }
            </div>
            @if (health(); as h) {
              @if (!h.ok) {
                <mk-code [code]="h.integrity.join('\\n')" language="plaintext" wrap />
              }
            }
            <mk-card class="advice">
              <mk-card-header><mk-card-title>Reading the numbers</mk-card-title></mk-card-header>
              <ul class="muted small">
                <li>
                  A WAL that keeps growing means nobody checkpoints — usually a long-lived read
                  transaction in the app.
                </li>
                <li>
                  Many free pages after big deletes: the file will not shrink until the app runs
                  <span class="mono">VACUUM</span>.
                </li>
                <li>
                  The integrity check reads the whole file; on a large database give it a moment.
                </li>
              </ul>
            </mk-card>
          </mk-tab>
        </mk-tabs>
      }
    </div>
  `,
  styles: [
    `
      .facts {
        margin: var(--mk-space-4) 0 var(--mk-space-5);
      }
      .actions {
        display: flex;
        align-items: center;
        gap: var(--mk-space-2);
        flex-wrap: wrap;
        margin: var(--mk-space-3) 0;
      }
      .split {
        display: grid;
        grid-template-columns: minmax(12rem, 16rem) minmax(0, 1fr);
        gap: var(--mk-space-4);
        margin-top: var(--mk-space-3);
      }
      @media (max-width: 800px) {
        .split {
          grid-template-columns: 1fr;
        }
      }
      .tables {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        gap: 2px;
        align-content: start;
      }
      .tables__item {
        width: 100%;
        display: flex;
        align-items: center;
        gap: var(--mk-space-2);
        padding: var(--mk-space-2) var(--mk-space-3);
        border: 0;
        border-radius: var(--mk-radius-sm);
        background: transparent;
        color: var(--mk-text);
        text-align: left;
        cursor: pointer;
        font: inherit;
      }
      .tables__item:hover {
        background: var(--mk-hover-overlay);
      }
      .tables__item--on {
        background: var(--mk-selected-bg);
        color: var(--mk-selected-text);
      }
      .tables__name {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .browse {
        min-width: 0;
      }
      .browse__head {
        display: flex;
        align-items: center;
        gap: var(--mk-space-2);
        flex-wrap: wrap;
        margin-bottom: var(--mk-space-3);
      }
      .spacer {
        flex: 1;
      }
      .grid-wrap {
        overflow: auto;
        max-height: 60vh;
        border: 1px solid var(--mk-border-subtle);
        border-radius: var(--mk-radius-md);
      }
      .rows {
        border-collapse: collapse;
        width: 100%;
        font-size: var(--mk-font-size-sm);
        font-variant-numeric: tabular-nums;
      }
      .rows th,
      .rows td {
        padding: var(--mk-space-1) var(--mk-space-3);
        border-bottom: 1px solid var(--mk-border-subtle);
        text-align: left;
        white-space: nowrap;
        max-width: 28rem;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .rows th {
        position: sticky;
        top: 0;
        background: var(--mk-surface-2, var(--mk-surface));
        font-weight: 600;
        cursor: pointer;
        user-select: none;
      }
      .th--on {
        color: var(--mk-primary);
      }
      .null {
        color: var(--mk-text-subtle);
        font-style: italic;
      }
      .pager {
        display: flex;
        align-items: center;
        gap: var(--mk-space-3);
        margin-top: var(--mk-space-2);
      }
      .sql {
        width: 100%;
        min-height: 7rem;
        box-sizing: border-box;
        resize: vertical;
        padding: var(--mk-space-3);
        border: 1px solid var(--mk-border);
        border-radius: var(--mk-radius-md);
        background: var(--mk-surface);
        color: var(--mk-text);
        font-family: var(--mk-font-mono);
        font-size: var(--mk-font-size-sm);
      }
      .sql:focus-visible {
        outline: var(--mk-focus-ring-width) solid var(--mk-focus-ring);
        outline-offset: var(--mk-focus-ring-offset);
      }
      .error {
        color: var(--mk-danger-text, var(--mk-danger));
      }
      .advice {
        margin-top: var(--mk-space-4);
      }
      .advice ul {
        margin: 0;
        padding-left: var(--mk-space-5);
      }
      .small {
        font-size: var(--mk-font-size-xs);
      }
    `,
  ],
})
export class DatabaseDetailPage {
  protected readonly api = inject(ApiService);
  protected readonly live = inject(LiveService);
  private readonly route = inject(ActivatedRoute);
  private readonly toast = inject(MkToastService);
  private readonly dialog = inject(MkDialogService);
  protected readonly f = { ago, bytes, dateTime };
  private readonly path = toSignal(this.route.queryParamMap.pipe(map((q) => q.get('path') ?? '')), {
    initialValue: '',
  });
  protected readonly db = signal<SqliteDbDetail | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly loading = signal(false);
  protected readonly table = signal<string | null>(null);
  protected readonly current = computed(
    () => this.db()?.tables.find((t) => t.name === this.table()) ?? null,
  );
  protected readonly rows = signal<SqliteRows | null>(null);
  protected readonly sort = signal<string | null>(null);
  protected readonly dir = signal<'asc' | 'desc'>('asc');
  protected readonly offset = signal(0);
  protected readonly showSchema = signal(false);
  protected readonly sql = signal('');
  protected readonly running = signal(false);
  protected readonly result = signal<SqliteQueryResult | null>(null);
  protected readonly queryError = signal<string | null>(null);
  protected readonly health = signal<SqliteHealth | null>(null);
  protected readonly checking = signal(false);
  protected readonly snapshotting = signal(false);
  protected readonly snapColumns: MkTableColumn<SqliteDbDetail['snapshots'][number]>[] = [
    { key: 'file', header: 'Snapshot', stack: 'title' },
    { key: 'at', header: 'Taken' },
    { key: 'size', header: 'Size', align: 'end', width: '110px' },
    { key: 'actions', header: '', width: '130px', align: 'end', stack: 'footer' },
  ];

  constructor() {
    effect(() => {
      const p = this.path();
      untracked(() => {
        this.db.set(null);
        this.table.set(null);
        this.rows.set(null);
        this.result.set(null);
        this.health.set(null);
        if (p) void this.load();
        else this.error.set('No database given.');
      });
    });
  }

  async load(): Promise<void> {
    this.loading.set(true);
    try {
      const d = await this.api.sqliteDb(this.path());
      this.db.set(d);
      this.error.set(null);
      if (!this.table() && d.tables.length) this.pick(d.tables[0]);
      else if (this.table()) void this.loadRows();
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.loading.set(false);
    }
  }

  pick(t: SqliteTable): void {
    this.table.set(t.name);
    this.sort.set(null);
    this.dir.set('asc');
    this.offset.set(0);
    this.showSchema.set(false);
    void this.loadRows();
  }

  private async loadRows(): Promise<void> {
    const t = this.table();
    if (!t) return;
    this.rows.set(null);
    try {
      const r = await this.api.sqliteRows(this.path(), t, {
        offset: this.offset(),
        limit: 100,
        sort: this.sort() ?? undefined,
        dir: this.dir(),
      });
      if (this.table() === t) this.rows.set(r);
    } catch (e) {
      this.toast.danger(errorMessage(e));
    }
  }

  text(v: unknown): string {
    return v === null || v === undefined ? 'NULL' : String(v);
  }

  sortBy(column: string): void {
    if (this.sort() === column) this.dir.set(this.dir() === 'asc' ? 'desc' : 'asc');
    else {
      this.sort.set(column);
      this.dir.set('asc');
    }
    this.offset.set(0);
    void this.loadRows();
  }

  page(delta: number): void {
    const r = this.rows();
    if (!r) return;
    this.offset.set(Math.max(0, r.offset + delta * r.limit));
    void this.loadRows();
  }

  async run(): Promise<void> {
    if (!this.sql().trim() || this.running()) return;
    this.running.set(true);
    this.queryError.set(null);
    try {
      this.result.set(await this.api.sqliteQuery(this.path(), this.sql()));
    } catch (e) {
      this.result.set(null);
      this.queryError.set(errorMessage(e));
    } finally {
      this.running.set(false);
    }
  }

  async check(): Promise<void> {
    this.checking.set(true);
    try {
      this.health.set(await this.api.sqliteHealth(this.path()));
    } catch (e) {
      this.toast.danger(errorMessage(e));
    } finally {
      this.checking.set(false);
    }
  }

  async snapshot(): Promise<void> {
    this.snapshotting.set(true);
    try {
      const s = await this.api.sqliteSnapshot(this.path());
      this.toast.success(`Snapshot ${s.file} (${bytes(s.size)})`);
      await this.load();
    } catch (e) {
      this.toast.danger(errorMessage(e));
    } finally {
      this.snapshotting.set(false);
    }
  }

  async restore(file: string): Promise<void> {
    const d = this.db();
    if (!d) return;
    const steps = [
      d.container?.state === 'running' ? `stop ${d.container.name}` : null,
      `keep the current ${d.name} as ${d.name}.before-restore`,
      `copy ${file} over it and drop the WAL`,
      d.container?.state === 'running' ? `start ${d.container.name} again` : null,
    ].filter(Boolean);
    const ok = await this.dialog.confirm({
      title: `Restore ${d.name} from ${file}?`,
      message: `This will: ${steps.join('; ')}. Anything written since the snapshot is only in the kept file.`,
      confirmText: 'Restore',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      const r = await this.api.sqliteRestore(d.path, file);
      this.toast.success(r.message);
      await this.load();
    } catch (e) {
      this.toast.danger(errorMessage(e));
    }
  }
}
