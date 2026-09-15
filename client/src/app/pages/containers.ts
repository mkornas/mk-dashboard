import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { MkPageHeader } from '@mk-kit/ui/navigation';
import { MkTable, type MkTableColumn, MkTableCell } from '@mk-kit/ui/table';
import { MkInput } from '@mk-kit/ui/forms';
import { MkSwitch } from '@mk-kit/ui/forms';
import { MkTag } from '@mk-kit/ui/data';
import { MkEmptyState } from '@mk-kit/ui/status';
import type { ContainerSummary } from '../../../../shared/types';
import { LiveService } from '../core/live.service';
import { ago, bytes, percent, shortImage } from '../core/format';
import { StatusChip } from '../shared/status-chip';
import { ContainerActions } from '../shared/container-actions';

interface Row extends ContainerSummary {
  cpu: number;
  mem: number;
  stackName: string;
  age: number;
}

/** Every container in one sortable, searchable table. */
@Component({
  selector: 'app-containers',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, MkPageHeader, MkTable, MkTableCell, MkInput, MkSwitch, MkTag, MkEmptyState, StatusChip, ContainerActions],
  template: `
    <div class="page">
      <mk-page-header heading="Containers" [description]="summary()">
        <div mkPageHeaderActions class="row">
          <label class="row toggle"><mk-switch [(checked)]="showStopped" size="sm" aria-label="Show stopped containers" /> <span>show stopped</span></label>
          <input mkInput type="search" placeholder="Filter by name, image, stack…" [value]="query()" (input)="query.set($any($event.target).value)" aria-label="Filter containers" class="search" />
        </div>
      </mk-page-header>

      @if (rows().length === 0) {
        <mk-empty-state icon="search-off" title="Nothing matches" description="Try a different filter, or show stopped containers." />
      } @else {
        <mk-table [columns]="columns" [data]="rows()" trackKey="id" [hover]="true" [stackAt]="760" [clickableRows]="true" (rowClick)="open($event)" density="compact">
          <ng-template mkTableCell="name" let-row="row">
            <div class="cell-name">
              <a class="plain" [routerLink]="['/containers', row.id]" (click)="$event.stopPropagation()"><strong>{{ row.name }}</strong></a>
              <span class="muted mono small">{{ f.shortImage(row.image) }}</span>
            </div>
          </ng-template>
          <ng-template mkTableCell="state" let-row="row">
            <app-status-chip [container]="row" />
          </ng-template>
          <ng-template mkTableCell="stackName" let-value>
            @if (value !== '—') {
              <mk-tag size="sm" variant="outline">{{ value }}</mk-tag>
            }
          </ng-template>
          <ng-template mkTableCell="cpu" let-value let-row="row">
            <span class="num" [class.muted]="!row.stats">{{ row.stats ? f.percent(value, 1) : '—' }}</span>
          </ng-template>
          <ng-template mkTableCell="mem" let-value let-row="row">
            <span class="num" [class.muted]="!row.stats">{{ row.stats ? f.bytes(value, 0) : '—' }}</span>
            @if (row.stats?.memLimit) {
              <span class="muted small"> / {{ f.bytes(row.stats.memLimit, 0) }}</span>
            }
          </ng-template>
          <ng-template mkTableCell="ports" let-row="row">
            <span class="ports">
              @for (p of row.ports; track p.private + p.type + (p.public ?? '')) {
                <span class="mono small" [class.muted]="!p.public">{{ p.public ? p.public + '→' : '' }}{{ p.private }}<span class="muted">/{{ p.type }}</span></span>
              }
            </span>
          </ng-template>
          <ng-template mkTableCell="age" let-row="row">
            <span class="nowrap">{{ row.status }}</span>
          </ng-template>
          <ng-template mkTableCell="actions" let-row="row">
            <span (click)="$event.stopPropagation()"><app-container-actions [c]="row" [compact]="true" /></span>
          </ng-template>
        </mk-table>
      }
    </div>
  `,
  styles: [
    `
      .search {
        min-width: 260px;
      }
      @media (max-width: 640px) {
        .search {
          min-width: 0;
        }
      }
      .toggle {
        gap: var(--mk-space-1);
        font-size: var(--mk-font-size-sm);
        color: var(--mk-text-muted);
        cursor: pointer;
      }
      .cell-name {
        display: flex;
        flex-direction: column;
        line-height: 1.25;
      }
      .small {
        font-size: var(--mk-font-size-xs);
      }
      .num {
        font-variant-numeric: tabular-nums;
      }
      .ports {
        display: inline-flex;
        flex-wrap: wrap;
        gap: 2px 8px;
      }
    `,
  ],
})
export class ContainersPage {
  protected readonly live = inject(LiveService);
  private readonly router = inject(Router);
  protected readonly f = { bytes, percent, shortImage, ago };
  protected readonly query = signal('');
  protected readonly showStopped = signal(true);

  protected readonly columns: MkTableColumn<Row>[] = [
    { key: 'name', header: 'Container', sortable: true, stack: 'title' },
    { key: 'state', header: 'Status', sortable: true, width: '130px' },
    { key: 'stackName', header: 'Stack', sortable: true, width: '150px' },
    { key: 'cpu', header: 'CPU', sortable: true, align: 'end', width: '90px' },
    { key: 'mem', header: 'Memory', sortable: true, align: 'end', width: '150px' },
    { key: 'ports', header: 'Ports', stack: 'hide', width: '160px' },
    { key: 'age', header: 'Uptime', sortable: true, width: '200px', format: (_v, row) => row.status },
    { key: 'actions', header: '', width: '150px', align: 'end', stack: 'footer' },
  ];

  protected readonly rows = computed<Row[]>(() => {
    const q = this.query().trim().toLowerCase();
    const stopped = this.showStopped();
    return this.live
      .containers()
      .filter((c) => stopped || c.state === 'running')
      .filter((c) => !q || `${c.name} ${c.image} ${c.stack ?? ''} ${c.status}`.toLowerCase().includes(q))
      .map((c) => ({ ...c, cpu: c.stats?.cpuPercent ?? -1, mem: c.stats?.memUsage ?? -1, stackName: c.stack ?? '—', age: c.state === 'running' ? c.created : 0 }));
  });

  protected readonly summary = computed(() => {
    const s = this.live.snapshot();
    if (!s?.docker) return 'Docker is not reachable';
    return `${s.docker.running} running of ${s.docker.containers} · ${s.stacks.length} stacks`;
  });

  open(row: Row): void {
    void this.router.navigate(['/containers', row.id]);
  }
}
