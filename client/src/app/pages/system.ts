import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MkPageHeader } from '@mk-kit/ui/navigation';
import { MkTable, type MkTableColumn, MkTableCell } from '@mk-kit/ui/table';
import { MkCard, MkCardHeader, MkCardTitle, MkDescItem, MkDescriptionList, MkDonutChart, MkSkeletonPreset, MkStatCard, MkTag } from '@mk-kit/ui/data';
import type { MkChartSlice } from '@mk-kit/ui/data';
import { MkBadge, MkEmptyState } from '@mk-kit/ui/status';
import { MkButton } from '@mk-kit/ui/button';
import { MkIcon } from '@mk-kit/ui/icon';
import { MkDialogService, MkToastService } from '@mk-kit/ui/feedback';
import type { ImageInfo, NetworkInfo, SystemInfo, VolumeInfo } from '../../../../shared/types';
import { ApiService, errorMessage } from '../core/api.service';
import { LiveService } from '../core/live.service';
import { ago, bytes, shortId } from '../core/format';

/** Docker engine, disk usage with prune, images, volumes and networks. */
@Component({
  selector: 'app-system',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MkPageHeader, MkTable, MkTableCell, MkCard, MkCardHeader, MkCardTitle, MkDescItem, MkDescriptionList, MkDonutChart, MkSkeletonPreset, MkStatCard, MkTag, MkBadge, MkEmptyState, MkButton, MkIcon],
  template: `
    <div class="page">
      <mk-page-header heading="System" [description]="info() ? 'Docker ' + info()!.docker.version + ' · ' + info()!.docker.os : 'Docker engine, storage and networks'">
        <div mkPageHeaderActions class="row">
          <button mkButton variant="outline" size="sm" [loading]="loading()" (click)="load()"><mk-icon name="refresh" /> Refresh</button>
          @if (!live.readonly()) {
            <button mkButton variant="outline" size="sm" tone="warning" [loading]="pruning()" [disabled]="!info()" (click)="prune('dangling')" title="Remove untagged image layers"><mk-icon name="trash" /> Prune dangling</button>
            <button mkButton variant="solid" size="sm" tone="danger" [loading]="pruning()" [disabled]="!info()" (click)="prune('unused')" title="Remove every image no container uses, and the build cache"><mk-icon name="trash" /> Prune unused</button>
          }
        </div>
      </mk-page-header>

      @if (error(); as e) {
        <mk-empty-state icon="octagon-alert" title="Docker is not reachable" [description]="e" />
      } @else if (!info()) {
        <mk-skeleton-preset preset="card" [rows]="4" />
      } @else if (info(); as s) {
        <div class="grid grid--stats">
          <mk-stat-card label="Images" [value]="f.bytes(s.usage.images, 1)" [hint]="s.images.length + ' images · ' + f.bytes(s.usage.imagesReclaimable, 1) + ' reclaimable'"><mk-icon mkStatIcon name="box" /></mk-stat-card>
          <mk-stat-card label="Container layers" [value]="f.bytes(s.usage.containers, 1)" [hint]="s.docker.running + ' running · ' + s.docker.stopped + ' stopped'"><mk-icon mkStatIcon name="boxes" /></mk-stat-card>
          <mk-stat-card label="Volumes" [value]="f.bytes(s.usage.volumes, 1)" [hint]="s.volumes.length + ' volumes · ' + f.bytes(s.usage.volumesReclaimable, 1) + ' unused'"><mk-icon mkStatIcon name="database" /></mk-stat-card>
          <mk-stat-card label="Build cache" [value]="f.bytes(s.usage.buildCache, 1)" hint="removed by prune unused"><mk-icon mkStatIcon name="wrench" /></mk-stat-card>
        </div>

        <div class="grid grid--2 mt">
          <mk-card padding="md">
            <mk-card-header><mk-card-title>Engine</mk-card-title></mk-card-header>
            <mk-description-list layout="grid">
              <mk-desc-item term="Version">{{ s.docker.version }} <span class="muted">(API {{ s.docker.apiVersion }})</span></mk-desc-item>
              <mk-desc-item term="Host">{{ s.docker.os }} · {{ s.docker.kernel }} · {{ s.docker.arch }}</mk-desc-item>
              <mk-desc-item term="Resources">{{ s.docker.ncpu }} CPUs · {{ f.bytes(s.docker.memTotal, 0) }}</mk-desc-item>
              <mk-desc-item term="Storage driver"><span class="mono">{{ s.docker.driver }}</span> at <span class="mono">{{ s.docker.rootDir }}</span></mk-desc-item>
              <mk-desc-item term="Logging"><span class="mono">{{ s.docker.loggingDriver }}</span> · cgroup v{{ s.docker.cgroupVersion }}</mk-desc-item>
              <mk-desc-item term="Containers">{{ s.docker.containers }} total · {{ s.docker.running }} running · {{ s.docker.paused }} paused · {{ s.docker.stopped }} stopped</mk-desc-item>
            </mk-description-list>
          </mk-card>
          <mk-card padding="md" class="donut-card">
            <mk-card-header><mk-card-title>Docker disk usage</mk-card-title></mk-card-header>
            <mk-donut-chart [slices]="slices()" [size]="180" [thickness]="26" [centerLabel]="f.bytes(total(), 0)" centerSublabel="total" label="Docker disk usage by kind" />
          </mk-card>
        </div>

        <h2 class="section-title">Images</h2>
        <mk-table [columns]="imageColumns" [data]="s.images" trackKey="id" density="compact" [stackAt]="700">
          <ng-template mkTableCell="tags" let-value let-row="row">
            @if (row.dangling) {
              <span class="muted mono">{{ f.shortId(row.id.replace('sha256:', '')) }}</span> <mk-badge tone="warning" size="sm">dangling</mk-badge>
            } @else {
              @for (t of value; track t) {
                <div class="mono">{{ t }}</div>
              }
            }
          </ng-template>
          <ng-template mkTableCell="containers" let-value>
            @if (value > 0) {
              <mk-badge tone="success" size="sm">{{ value }} in use</mk-badge>
            } @else {
              <mk-badge tone="neutral" size="sm">unused</mk-badge>
            }
          </ng-template>
        </mk-table>

        <h2 class="section-title">Volumes</h2>
        @if (s.volumes.length === 0) {
          <p class="muted">No named volumes — data lives in bind mounts.</p>
        } @else {
          <mk-table [columns]="volumeColumns" [data]="s.volumes" trackKey="name" density="compact" [stackAt]="700">
            <ng-template mkTableCell="refCount" let-value>
              @if (value > 0) {
                <mk-badge tone="success" size="sm">{{ value }} in use</mk-badge>
              } @else {
                <mk-badge tone="neutral" size="sm">unused</mk-badge>
              }
            </ng-template>
          </mk-table>
        }

        <h2 class="section-title">Networks</h2>
        <mk-table [columns]="networkColumns" [data]="s.networks" trackKey="id" density="compact" [stackAt]="700">
          <ng-template mkTableCell="containers" let-value>
            <span class="row">
              @for (c of value; track c) {
                <mk-tag size="sm" variant="outline">{{ c }}</mk-tag>
              }
            </span>
          </ng-template>
        </mk-table>
      }
    </div>
  `,
  styles: [
    `
      .mt {
        margin-top: var(--mk-space-4);
      }
      .donut-card {
        display: flex;
        flex-direction: column;
        align-items: center;
      }
    `,
  ],
})
export class SystemPage {
  private readonly api = inject(ApiService);
  private readonly dialog = inject(MkDialogService);
  private readonly toast = inject(MkToastService);
  protected readonly live = inject(LiveService);
  protected readonly f = { ago, bytes, shortId };

  protected readonly info = signal<SystemInfo | null>(null);
  protected readonly loading = signal(false);
  protected readonly pruning = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly total = computed(() => {
    const u = this.info()?.usage;
    return u ? u.images + u.containers + u.volumes + u.buildCache : 0;
  });
  protected readonly slices = computed<MkChartSlice[]>(() => {
    const u = this.info()?.usage;
    if (!u) return [];
    return [
      { name: 'Images', value: u.images },
      { name: 'Containers', value: u.containers },
      { name: 'Volumes', value: u.volumes },
      { name: 'Build cache', value: u.buildCache },
    ].filter((s) => s.value > 0);
  });

  protected readonly imageColumns: MkTableColumn<ImageInfo>[] = [
    { key: 'tags', header: 'Image', sortable: true, stack: 'title' },
    { key: 'size', header: 'Size', sortable: true, align: 'end', width: '110px', format: (v) => bytes(v as number) },
    { key: 'sharedSize', header: 'Shared', sortable: true, align: 'end', width: '110px', format: (v) => bytes(v as number) },
    { key: 'containers', header: 'Used by', sortable: true, width: '110px' },
    { key: 'created', header: 'Created', sortable: true, width: '130px', format: (v) => ago(v as number) },
  ];
  protected readonly volumeColumns: MkTableColumn<VolumeInfo>[] = [
    { key: 'name', header: 'Volume', sortable: true, stack: 'title' },
    { key: 'driver', header: 'Driver', width: '100px' },
    { key: 'mountpoint', header: 'Mountpoint' },
    { key: 'size', header: 'Size', sortable: true, align: 'end', width: '110px', format: (v) => bytes(v as number) },
    { key: 'refCount', header: 'Used by', sortable: true, width: '110px' },
  ];
  protected readonly networkColumns: MkTableColumn<NetworkInfo>[] = [
    { key: 'name', header: 'Network', sortable: true, stack: 'title' },
    { key: 'driver', header: 'Driver', width: '100px' },
    { key: 'subnet', header: 'Subnet', width: '160px', format: (v) => (v as string) || '—' },
    { key: 'internal', header: 'Internal', width: '90px', format: (v) => (v ? 'yes' : 'no') },
    { key: 'containers', header: 'Containers' },
  ];

  constructor() {
    void this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    try {
      this.info.set(await this.api.system());
      this.error.set(null);
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.loading.set(false);
    }
  }

  async prune(mode: 'dangling' | 'unused'): Promise<void> {
    const s = this.info();
    const ok = await this.dialog.confirm({
      title: mode === 'dangling' ? 'Remove dangling images?' : 'Remove all unused images?',
      message:
        mode === 'dangling'
          ? 'Untagged layers left behind by image updates. Safe: nothing running references them.'
          : `Every image with no container (running or stopped) plus the build cache — about ${bytes(s?.usage.imagesReclaimable ?? 0)} + ${bytes(s?.usage.buildCache ?? 0)}. A rollback would need to pull again.`,
      confirmText: 'Prune',
      tone: mode === 'dangling' ? 'warning' : 'danger',
      icon: 'trash',
    });
    if (!ok) return;
    this.pruning.set(true);
    try {
      const r = await this.api.prune(mode, mode === 'unused');
      this.toast.success(r.message);
      await this.load();
    } catch (e) {
      this.toast.danger(errorMessage(e), { title: 'Prune failed' });
    } finally {
      this.pruning.set(false);
    }
  }
}
