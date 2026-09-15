import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MkBreadcrumb, MkBreadcrumbItem, MkPageHeader, MkTab, MkTabs } from '@mk-kit/ui/navigation';
import { MkCard, MkCardHeader, MkCardTitle, MkDescItem, MkDescriptionList, MkLineChart, MkLogViewer, MkSkeletonPreset, MkTimeline, MkTimelineItem } from '@mk-kit/ui/data';
import type { MkChartSeries } from '@mk-kit/ui/data';
import { MkTable, type MkTableColumn } from '@mk-kit/ui/table';
import { MkBadge, MkEmptyState } from '@mk-kit/ui/status';
import { MkButton } from '@mk-kit/ui/button';
import { MkIcon } from '@mk-kit/ui/icon';
import { MkSelect, MkSwitch } from '@mk-kit/ui/forms';
import { MkTooltip } from '@mk-kit/ui/feedback';
import type { ContainerDetail, ContainerHistoryPoint, ContainerTop, DockerEvent } from '../../../../shared/types';
import { ApiService, errorMessage } from '../core/api.service';
import { LiveService } from '../core/live.service';
import { ViewportService, downsample, sparseLabels } from '../core/viewport.service';
import { ago, bytes, dateTime, duration, percent, rate, shortId, time } from '../core/format';
import { type ChartRange, RANGE_OPTIONS, axisLabel, storedHistory } from '../shared/history-range';
import { healthTone } from '../shared/status';
import { StatusChip } from '../shared/status-chip';
import { ContainerActions } from '../shared/container-actions';
import { EventList } from '../shared/event-list';

const MAX_LOG_LINES = 5000;

/** One container: live stats, config, logs (followed), processes, health history. */
@Component({
  selector: 'app-container-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, MkBreadcrumb, MkBreadcrumbItem, MkPageHeader, MkTab, MkTabs, MkCard, MkCardHeader, MkCardTitle, MkDescItem, MkDescriptionList, MkLineChart, MkLogViewer, MkSkeletonPreset, MkTimeline, MkTimelineItem, MkTable, MkBadge, MkEmptyState, MkButton, MkIcon, MkSelect, MkSwitch, MkTooltip, StatusChip, ContainerActions, EventList],
  template: `
    <div class="page">
      @if (error(); as e) {
        <mk-empty-state icon="octagon-alert" title="Container not found" [description]="e">
          <a mkButton variant="outline" routerLink="/containers" mkEmptyStateActions>Back to containers</a>
        </mk-empty-state>
      } @else if (detail(); as d) {
        <mk-page-header [heading]="d.name" [description]="d.image">
          <mk-breadcrumb mkPageHeaderBreadcrumb>
            <mk-breadcrumb-item href="/containers"><a routerLink="/containers" class="plain">Containers</a></mk-breadcrumb-item>
            @if (d.stack) {
              <mk-breadcrumb-item>{{ d.stack }}</mk-breadcrumb-item>
            }
            <mk-breadcrumb-item>{{ d.name }}</mk-breadcrumb-item>
          </mk-breadcrumb>
          <div mkPageHeaderMeta class="row">
            <app-status-chip [container]="liveState()" />
            @if (d.url) {
              <a [href]="d.url" target="_blank" rel="noopener" class="plain muted row" style="gap:4px"><mk-icon name="external-link" size="sm" /> {{ d.url }}</a>
            }
          </div>
          <div mkPageHeaderActions>
            <app-container-actions [c]="liveState()" (done)="reload()" />
          </div>
        </mk-page-header>

        <div class="grid grid--stats">
          <mk-card padding="sm"><div class="kpi"><span class="kpi__l">CPU</span><span class="kpi__v">{{ stats() ? f.percent(stats()!.cpuPercent, 1) : '—' }}</span></div></mk-card>
          <mk-card padding="sm"><div class="kpi"><span class="kpi__l">Memory</span><span class="kpi__v">{{ stats() ? f.bytes(stats()!.memUsage, 0) : '—' }}</span><span class="kpi__h">{{ stats()?.memLimit ? 'of ' + f.bytes(stats()!.memLimit, 0) + ' limit' : 'no limit' }}</span></div></mk-card>
          <mk-card padding="sm"><div class="kpi"><span class="kpi__l">Network</span><span class="kpi__v">↓ {{ stats() ? f.rate(stats()!.netRxRate) : '—' }}</span><span class="kpi__h">↑ {{ stats() ? f.rate(stats()!.netTxRate) : '—' }} · total {{ stats() ? f.bytes(stats()!.netRx, 0) : '—' }} / {{ stats() ? f.bytes(stats()!.netTx, 0) : '—' }}</span></div></mk-card>
          <mk-card padding="sm"><div class="kpi"><span class="kpi__l">Disk I/O</span><span class="kpi__v">{{ stats() ? f.bytes(stats()!.blockWrite, 0) : '—' }}</span><span class="kpi__h">written · {{ stats() ? f.bytes(stats()!.blockRead, 0) : '—' }} read</span></div></mk-card>
          <mk-card padding="sm"><div class="kpi"><span class="kpi__l">Uptime</span><span class="kpi__v">{{ d.state === 'running' && d.startedAt ? f.duration((now() - d.startedAt) / 1000) : '—' }}</span><span class="kpi__h">{{ stats()?.pids ?? 0 }} pids · {{ d.restartCount }} restarts</span></div></mk-card>
        </div>

        <mk-tabs [(selectedIndex)]="tab" class="tabs">
          <mk-tab label="Overview">
            <div class="grid grid--2">
              <mk-card padding="md">
                <mk-card-header>
                  <div class="head">
                    <mk-card-title>Resources</mk-card-title>
                    <mk-select [options]="rangeOptions" [(value)]="range" size="sm" aria-label="Chart range" class="range" />
                  </div>
                </mk-card-header>
                @if (chart().length > 1) {
                  <mk-line-chart [categories]="categories()" [series]="series()" [height]="viewport.narrow() ? 180 : 200" [area]="true" [showLegend]="true" label="CPU and memory of this container" />
                } @else {
                  <p class="muted">{{ range() === 'live' ? 'Collecting samples…' : 'No stored samples in this range yet.' }}</p>
                }
              </mk-card>
              <mk-card padding="md">
                <mk-card-header><mk-card-title>Health</mk-card-title></mk-card-header>
                @if (d.healthcheck) {
                  <p class="mono small">{{ d.healthcheck }}</p>
                  <div class="row"><mk-badge [tone]="healthTone(d.health)">{{ d.health }}</mk-badge>@if (d.failingStreak) { <span class="muted small">failing streak {{ d.failingStreak }}</span> }</div>
                  @if (d.healthLog.length) {
                    <mk-timeline class="health-log">
                      @for (h of healthLog(); track h.start) {
                        <mk-timeline-item [tone]="h.exitCode === 0 ? 'success' : 'danger'" [time]="f.time(h.end)" [heading]="h.exitCode === 0 ? 'ok' : 'exit ' + h.exitCode">
                          @if (h.output) {
                            <span class="mono small muted">{{ h.output.slice(0, 200) }}</span>
                          }
                        </mk-timeline-item>
                      }
                    </mk-timeline>
                  }
                } @else {
                  <p class="muted">No healthcheck defined.</p>
                }
              </mk-card>
            </div>

            <mk-card padding="md" class="mt">
              <mk-card-header><mk-card-title>Configuration</mk-card-title></mk-card-header>
              <mk-description-list layout="grid">
                <mk-desc-item term="Id"><span class="mono">{{ f.shortId(d.id) }}</span></mk-desc-item>
                <mk-desc-item term="Image"><span class="mono">{{ d.image }}</span><br /><span class="mono muted small">{{ d.imageId }}</span></mk-desc-item>
                <mk-desc-item term="Status">{{ d.status }}@if (d.exitCode && d.state !== 'running') { <span class="muted"> · exit code {{ d.exitCode }}</span> }</mk-desc-item>
                <mk-desc-item term="Created">{{ f.dateTime(d.created) }} ({{ f.ago(d.created) }})</mk-desc-item>
                <mk-desc-item term="Started">{{ f.dateTime(d.startedAt) }}</mk-desc-item>
                @if (d.finishedAt && d.state !== 'running') {
                  <mk-desc-item term="Finished">{{ f.dateTime(d.finishedAt) }}</mk-desc-item>
                }
                <mk-desc-item term="Restart policy"><span class="mono">{{ d.restartPolicy }}</span></mk-desc-item>
                <mk-desc-item term="Stack">{{ d.stack ?? '—' }}@if (d.service) { <span class="muted"> · service {{ d.service }}</span> }</mk-desc-item>
                <mk-desc-item term="Watchtower">{{ d.watchtower ? 'enabled' : 'not managed' }}</mk-desc-item>
                <mk-desc-item term="Ports">
                  @if (d.ports.length === 0) { <span class="muted">none</span> }
                  @for (p of d.ports; track p.private + p.type + (p.public ?? '')) {
                    <span class="mono port">{{ p.public ? (p.ip && p.ip !== '0.0.0.0' ? p.ip + ':' : '') + p.public + ' → ' : '' }}{{ p.private }}/{{ p.type }}{{ p.public ? '' : ' (internal)' }}</span>
                  }
                </mk-desc-item>
                <mk-desc-item term="Networks">
                  @for (n of d.networks; track n.name) {
                    <span class="mono port">{{ n.name }}<span class="muted"> {{ n.ip }}</span></span>
                  }
                </mk-desc-item>
                <mk-desc-item term="Mounts">
                  @if (d.mounts.length === 0) { <span class="muted">none</span> }
                  @for (m of d.mounts; track m.destination) {
                    <span class="mono port">{{ m.source }} → {{ m.destination }}<span class="muted"> {{ m.rw ? 'rw' : 'ro' }}</span></span>
                  }
                </mk-desc-item>
                <mk-desc-item term="Memory limit">{{ d.memoryLimit ? f.bytes(d.memoryLimit, 0) : 'unlimited' }}</mk-desc-item>
                <mk-desc-item term="Command"><span class="mono">{{ (d.entrypoint.concat(d.cmd)).join(' ') || '—' }}</span></mk-desc-item>
                <mk-desc-item term="User / workdir"><span class="mono">{{ d.user || 'root' }} · {{ d.workingDir || '/' }}</span></mk-desc-item>
                <mk-desc-item term="Logging"><span class="mono">{{ d.logDriver }}{{ d.tty ? ' · tty' : '' }}</span></mk-desc-item>
              </mk-description-list>
            </mk-card>
          </mk-tab>

          <mk-tab label="Logs">
            <mk-card padding="none" class="logs">
              <div class="logs__bar row">
                <label class="row toggle"><mk-switch [(checked)]="follow" size="sm" aria-label="Follow logs" /><span>follow</span></label>
                <mk-select [options]="tailOptions" [(value)]="tail" size="sm" aria-label="Lines to load" class="tail" />
                <span class="muted small">{{ lines().length }} lines{{ streaming() ? ' · streaming' : '' }}</span>
                <span style="flex:1"></span>
                <button mkButton variant="ghost" size="sm" (click)="lines.set([])" mkTooltip="Clear the view"><mk-icon name="trash" /> Clear</button>
              </div>
              <mk-log-viewer [lines]="lines()" [(follow)]="follow" [wrap]="false" [maxLines]="maxLogLines" class="logs__view" [ariaLabel]="d.name + ' logs'" />
            </mk-card>
          </mk-tab>

          <mk-tab label="Processes">
            <div class="row mt-sm">
              <button mkButton variant="outline" size="sm" [loading]="topLoading()" (click)="loadTop()"><mk-icon name="refresh" /> Refresh</button>
              @if (top()) { <span class="muted small">{{ top()!.processes.length }} processes</span> }
            </div>
            @if (top(); as t) {
              <mk-table [columns]="topColumns()" [data]="topRows()" density="compact" [zebra]="true" />
            } @else if (d.state !== 'running') {
              <p class="muted">The container is not running.</p>
            } @else {
              <mk-skeleton-preset preset="table" [rows]="5" />
            }
          </mk-tab>

          <mk-tab label="Events">
            <app-event-list [events]="events()" [hideContainer]="true" />
          </mk-tab>

          <mk-tab label="Environment">
            <mk-card padding="md">
              <mk-card-header><mk-card-title>Environment <span class="muted small">(secret-looking values are hidden)</span></mk-card-title></mk-card-header>
              <mk-description-list layout="grid" [divided]="true">
                @for (e of d.env; track e.key) {
                  <mk-desc-item [term]="e.key"><span class="mono" [class.muted]="e.redacted">{{ e.value }}</span></mk-desc-item>
                }
              </mk-description-list>
            </mk-card>
            <mk-card padding="md" class="mt">
              <mk-card-header><mk-card-title>Labels</mk-card-title></mk-card-header>
              <mk-description-list layout="grid" [divided]="true">
                @for (l of labels(); track l.key) {
                  <mk-desc-item [term]="l.key"><span class="mono">{{ l.value }}</span></mk-desc-item>
                }
              </mk-description-list>
            </mk-card>
          </mk-tab>
        </mk-tabs>
      } @else {
        <mk-skeleton-preset preset="card" [rows]="6" />
      }
    </div>
  `,
  styles: [
    `
      .kpi {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
      }
      .kpi__v {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .kpi__l {
        font-size: var(--mk-font-size-xs);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--mk-text-muted);
      }
      .kpi__v {
        font-size: var(--mk-font-size-xl);
        font-weight: var(--mk-font-weight-semibold);
        font-variant-numeric: tabular-nums;
      }
      .kpi__h {
        font-size: var(--mk-font-size-xs);
        color: var(--mk-text-muted);
      }
      .tabs {
        display: block;
        margin-top: var(--mk-space-5);
      }
      .mt {
        margin-top: var(--mk-space-4);
      }
      .mt-sm {
        margin: var(--mk-space-3) 0;
      }
      .small {
        font-size: var(--mk-font-size-xs);
      }
      .port {
        display: block;
      }
      .health-log {
        margin-top: var(--mk-space-3);
        max-height: 260px;
        overflow: auto;
      }
      .logs {
        margin-top: var(--mk-space-3);
        overflow: hidden;
      }
      .logs__bar {
        padding: var(--mk-space-2) var(--mk-space-3);
        border-bottom: 1px solid var(--mk-border-subtle);
      }
      .logs__view {
        display: block;
        height: min(70vh, 640px);
      }
      .toggle {
        gap: var(--mk-space-1);
        font-size: var(--mk-font-size-sm);
        color: var(--mk-text-muted);
        cursor: pointer;
      }
      .head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--mk-space-2);
      }
      .range {
        flex: 0 0 auto;
      }
      .tail {
        width: 130px;
      }
    `,
  ],
})
export class ContainerDetailPage {
  readonly id = input.required<string>();

  private readonly api = inject(ApiService);
  private readonly live = inject(LiveService);
  protected readonly viewport = inject(ViewportService);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly f = { ago, bytes, dateTime, duration, percent, rate, shortId, time };
  protected readonly healthTone = healthTone;
  protected readonly maxLogLines = MAX_LOG_LINES;

  protected readonly detail = signal<ContainerDetail | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly tab = signal(0);
  protected readonly now = signal(Date.now());

  // logs
  protected readonly lines = signal<string[]>([]);
  protected readonly follow = signal(true);
  protected readonly tail = signal<unknown>(300);
  protected readonly streaming = signal(false);
  protected readonly tailOptions = [
    { label: '100 lines', value: 100 },
    { label: '300 lines', value: 300 },
    { label: '1000 lines', value: 1000 },
    { label: '5000 lines', value: 5000 },
  ];
  private source?: EventSource;

  // processes
  protected readonly top = signal<ContainerTop | null>(null);
  protected readonly topLoading = signal(false);
  protected readonly events = signal<DockerEvent[]>([]);
  protected readonly topColumns = computed<MkTableColumn<Record<string, unknown>>[]>(() =>
    (this.top()?.titles ?? []).map((t, i) => ({ key: `c${i}`, header: t, sortable: true, align: /CPU|MEM|PID/i.test(t) ? 'end' : 'start' })),
  );
  protected readonly topRows = computed(() => (this.top()?.processes ?? []).map((p) => Object.fromEntries(p.map((v, i) => [`c${i}`, v]))));

  /** The row from the live snapshot, so state/stats keep moving without re-inspecting. */
  protected readonly liveRow = computed(() => this.live.containers().find((c) => c.id === this.detail()?.id) ?? null);
  protected readonly liveState = computed(() => this.liveRow() ?? this.detail()!);
  protected readonly stats = computed(() => this.liveRow()?.stats ?? this.detail()?.stats);
  protected readonly history = signal<ContainerHistoryPoint[]>([]);
  /** The chart's window: the live samples, or a stored range for this container's name. */
  protected readonly rangeOptions = RANGE_OPTIONS;
  protected readonly range = signal<ChartRange>('live');
  private readonly stored = storedHistory(
    this.range,
    (r) => {
      const name = this.detail()?.name;
      return name ? this.api.containerHistory(name, r).then((h) => h.points) : Promise.resolve([]);
    },
    () => this.detail()?.name,
  );
  protected readonly chart = computed(() => (this.range() === 'live' ? this.history() : this.stored()));
  private readonly plotted = computed(() => {
    const h = this.chart();
    const narrow = this.viewport.narrow();
    const n = narrow ? 60 : Math.min(h.length, 240);
    return { t: downsample(h, n, (p) => p.t), cpu: downsample(h, n, (p) => p.cpu), mem: downsample(h, n, (p) => p.mem), labels: narrow ? 3 : 5, format: axisLabel(this.range(), narrow) };
  });
  protected readonly categories = computed(() => {
    const p = this.plotted();
    return sparseLabels(p.t.length, p.labels, (i) => p.format(p.t[i]));
  });
  protected readonly series = computed<MkChartSeries[]>(() => {
    const p = this.plotted();
    return [
      { name: 'CPU %', data: p.cpu.map((v) => Math.round(v * 10) / 10) },
      { name: 'Memory MB', data: p.mem.map((v) => Math.round(v / 1048576)) },
    ];
  });
  protected readonly healthLog = computed(() => [...(this.detail()?.healthLog ?? [])].reverse());
  protected readonly labels = computed(() =>
    Object.entries(this.detail()?.labels ?? {})
      .map(([key, value]) => ({ key, value }))
      .sort((a, b) => a.key.localeCompare(b.key)),
  );

  constructor() {
    effect(() => {
      const id = this.id();
      untracked(() => {
        this.detail.set(null);
        this.top.set(null);
        this.history.set([]);
        void this.reload();
        this.stopLogs();
        this.lines.set([]);
      });
    });
    // logs tab: open the stream when shown, close when left; reopen on tail change
    effect(() => {
      const show = this.tab() === 1 && !!this.detail();
      const tail = Number(this.tail());
      untracked(() => {
        this.stopLogs();
        if (show) this.startLogs(tail);
      });
    });
    effect(() => {
      if (this.tab() === 2 && this.detail() && !this.top()) untracked(() => void this.loadTop());
    });
    // live stats → append to the chart; the state change of a stop/start re-inspects
    effect(() => {
      const row = this.liveRow();
      const d = untracked(() => this.detail());
      if (!row || !d) return;
      untracked(() => {
        if (row.stats) this.history.update((h) => [...h.slice(-239), { t: Date.now(), cpu: row.stats!.cpuPercent, mem: row.stats!.memUsage }]);
        if (row.state !== d.state || row.status !== d.status) void this.reload();
      });
    });
    const tick = setInterval(() => this.now.set(Date.now()), 1000);
    this.destroyRef.onDestroy(() => {
      clearInterval(tick);
      this.stopLogs();
    });
  }

  async reload(): Promise<void> {
    try {
      const d = await this.api.container(this.id());
      this.detail.set(d);
      if (d.history.length) this.history.set(d.history);
      this.error.set(null);
      this.api.events(200, d.id).then((e) => this.events.set(e)).catch(() => undefined);
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }

  async loadTop(): Promise<void> {
    this.topLoading.set(true);
    try {
      this.top.set(await this.api.top(this.id()));
    } catch {
      this.top.set({ titles: [], processes: [] });
    } finally {
      this.topLoading.set(false);
    }
  }

  private startLogs(tail: number): void {
    this.lines.set([]);
    const es = new EventSource(`/api/containers/${encodeURIComponent(this.id())}/logs/stream?tail=${tail}&ngsw-bypass=true`);
    this.source = es;
    this.streaming.set(true);
    es.addEventListener('lines', (ev) => {
      const incoming = JSON.parse((ev as MessageEvent).data) as string[];
      this.lines.update((cur) => {
        const next = cur.length + incoming.length > MAX_LOG_LINES ? [...cur.slice(cur.length + incoming.length - MAX_LOG_LINES), ...incoming] : [...cur, ...incoming];
        return next;
      });
    });
    es.addEventListener('end', () => this.streaming.set(false));
    es.onerror = () => {
      this.streaming.set(false);
      es.close();
    };
  }

  private stopLogs(): void {
    this.source?.close();
    this.source = undefined;
    this.streaming.set(false);
  }
}
