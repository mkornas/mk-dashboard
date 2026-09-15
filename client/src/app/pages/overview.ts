import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { MkPageHeader } from '@mk-kit/ui/navigation';
import { MkCard, MkCardHeader, MkCardTitle, MkLineChart, MkProgressBar, MkSparkline, MkStatCard, MkTag } from '@mk-kit/ui/data';
import { MkAlert } from '@mk-kit/ui/feedback';
import { MkBadge, MkEmptyState, MkSpinner } from '@mk-kit/ui/status';
import { MkIcon } from '@mk-kit/ui/icon';
import { MkSelect } from '@mk-kit/ui/forms';
import type { MkChartSeries } from '@mk-kit/ui/data';
import { ApiService } from '../core/api.service';
import { LiveService } from '../core/live.service';
import { ViewportService, downsample, sparseLabels } from '../core/viewport.service';
import { bytes, duration, percent, rate, shortImage } from '../core/format';
import { type ChartRange, RANGE_OPTIONS, axisLabel, rangeLabel, storedHistory } from '../shared/history-range';
import { usageTone } from '../shared/status';
import { StatusChip } from '../shared/status-chip';
import { ContainerActions } from '../shared/container-actions';

const CHIP_LABELS: Array<[RegExp, string]> = [
  [/^(coretemp|k10temp|zenpower|cpu_thermal|x86_pkg_temp)/, 'CPU'],
  [/^nvme/, 'NVMe'],
  [/^(acpitz|pch_)/, 'Board'],
  [/^(iwlwifi|ath|mt76)/, 'Wi-Fi'],
  [/^(r8169|e1000|igc|igb)/, 'NIC'],
  [/^spd5118|^jc42/, 'RAM'],
  [/^drivetemp/, 'Disk'],
  [/^amdgpu|^nouveau|^i915/, 'GPU'],
];
function chipLabel(chip: string): string {
  return CHIP_LABELS.find(([re]) => re.test(chip))?.[1] ?? chip;
}

/** Front page: host vitals, live charts, alerts and every stack at a glance. */
@Component({
  selector: 'app-overview',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, MkPageHeader, MkCard, MkCardHeader, MkCardTitle, MkLineChart, MkProgressBar, MkSparkline, MkStatCard, MkTag, MkAlert, MkBadge, MkEmptyState, MkSpinner, MkIcon, MkSelect, StatusChip, ContainerActions],
  template: `
    @if (snap(); as s) {
      <div class="page">
        <mk-page-header [heading]="s.info.hostname" [description]="s.info.os + ' · ' + s.info.kernel + ' · ' + s.info.cpuModel">
          <div mkPageHeaderMeta class="row">
            <mk-tag tone="neutral" size="sm"><mk-icon name="timer" size="sm" /> up {{ f.duration(s.host.uptime) }}</mk-tag>
            @if (s.docker) {
              <mk-tag tone="neutral" size="sm"><mk-icon name="container" size="sm" /> docker {{ s.docker.version }}</mk-tag>
              <mk-tag [tone]="s.docker.running === s.docker.containers ? 'success' : 'neutral'" size="sm"><mk-icon name="boxes" size="sm" /> {{ s.docker.running }}/{{ s.docker.containers }} containers · {{ s.stacks.length }} stacks</mk-tag>
            }
          </div>
        </mk-page-header>

        @if (s.alerts.length) {
          <div class="alerts">
            @for (a of s.alerts; track a.title) {
              <mk-alert [tone]="a.level" [title]="a.title">
                {{ a.detail }}
                @if (a.link) {
                  <a [routerLink]="a.link" class="alert-link">Open</a>
                }
              </mk-alert>
            }
          </div>
        }

        <div class="grid grid--stats">
          <mk-stat-card label="CPU" [value]="f.percent(s.host.cpu.percent)" [hint]="s.info.cpuCount + ' cores' + (pkgTemp() ? ' · ' + pkgTemp() + ' °C' : '') + (s.host.cpu.iowait > 2 ? ' · iowait ' + f.percent(s.host.cpu.iowait) : '')">
            <mk-sparkline mkStatIcon [data]="cpuSpark()" type="area" [min]="0" [max]="100" [width]="80" [height]="28" label="CPU history" />
          </mk-stat-card>
          <mk-stat-card label="Memory" [value]="f.bytes(s.host.memory.used, 1)" [hint]="f.percent(s.host.memory.percent) + ' of ' + f.bytes(s.host.memory.total, 0) + (s.host.memory.swapUsed ? ' · swap ' + f.bytes(s.host.memory.swapUsed) : '')">
            <mk-sparkline mkStatIcon [data]="memSpark()" type="area" [min]="0" [max]="100" color="var(--mk-chart-2)" [width]="80" [height]="28" label="Memory history" />
          </mk-stat-card>
          <mk-stat-card label="Load" [value]="s.host.load.one.toFixed(2)" [hint]="'5m ' + s.host.load.five.toFixed(2) + ' · 15m ' + s.host.load.fifteen.toFixed(2) + ' · ' + s.host.load.running + ' running'">
            <mk-icon mkStatIcon name="activity" />
          </mk-stat-card>
          @if (rootDisk(); as d) {
            <mk-stat-card label="Disk" [value]="f.percent(d.percent)" [hint]="f.bytes(d.used, 0) + ' of ' + f.bytes(d.total, 0) + ' on ' + d.mount">
              <mk-icon mkStatIcon name="hard-drive" />
            </mk-stat-card>
          }
          <mk-stat-card label="Network ↓" [value]="f.rate(s.host.netRxRate)" [hint]="'↑ ' + f.rate(s.host.netTxRate) + (s.host.net.length ? ' · ' + ifaceNames() : '')">
            <mk-sparkline mkStatIcon [data]="netSpark()" type="bar" color="var(--mk-chart-3)" [width]="80" [height]="28" label="Download history" />
          </mk-stat-card>
        </div>

        <div class="grid grid--2 charts">
          <mk-card padding="md">
            <mk-card-header>
              <div class="head">
                <mk-card-title>Last {{ windowLabel() }}</mk-card-title>
                <mk-select [options]="rangeOptions" [(value)]="range" size="sm" aria-label="Chart range" class="range" />
              </div>
            </mk-card-header>
            @if (hist().length > 1) {
              <mk-line-chart [categories]="categories()" [series]="series()" [height]="viewport.narrow() ? 190 : 220" [area]="true" [showLegend]="true" label="CPU and memory over time" />
            } @else {
              <p class="muted">{{ range() === 'live' ? 'Collecting samples…' : 'No stored samples in this range yet.' }}</p>
            }
          </mk-card>
          <mk-card padding="md">
            <mk-card-header><mk-card-title>Disks &amp; sensors</mk-card-title></mk-card-header>
            <div class="stack">
              @for (d of s.host.disks; track d.device) {
                <div class="disk">
                  <div class="disk__row">
                    <span class="mono">{{ d.mount }}</span>
                    <span class="muted">{{ f.bytes(d.free, 0) }} free · {{ d.fstype }}</span>
                  </div>
                  <mk-progress-bar [value]="d.percent" [tone]="usageTone(d.percent)" size="sm" [attr.aria-label]="d.mount + ' usage'" />
                </div>
              }
              @if (s.host.temperatures.length) {
                <div class="temps">
                  @for (t of temps(); track t.chip + t.label) {
                    <mk-tag [tone]="tempTone(t.celsius, t.high, t.critical)" variant="soft" size="sm"><mk-icon name="thermometer" size="sm" /> {{ t.label }} {{ t.celsius }} °C</mk-tag>
                  }
                </div>
              }
              @if (s.checks.length) {
                <div class="checks" aria-label="Reachability">
                  @for (c of s.checks; track c.name) {
                    <a routerLink="/network" class="check plain" [class.check--down]="!c.up" [title]="c.target + (c.error ? ' — ' + c.error : '') + (c.certDaysLeft !== undefined ? ' · cert ' + c.certDaysLeft + ' d' : '')">
                      <span class="check__dot"></span>{{ c.name }}
                      @if (c.certDaysLeft !== undefined && c.certDaysLeft <= 14) {
                        <mk-icon name="shield-alert" size="sm" />
                      }
                    </a>
                  }
                </div>
              }
              @if (s.host.cpu.cores.length > 1) {
                <div class="cores" [attr.aria-label]="'Per-core CPU usage'">
                  @for (c of s.host.cpu.cores; track $index) {
                    <span class="core" [style.--v]="c / 100" [title]="'core ' + $index + ': ' + f.percent(c)"></span>
                  }
                </div>
              }
            </div>
          </mk-card>
        </div>

        <h2 class="section-title">Stacks</h2>
        @if (s.stacks.length === 0) {
          <mk-empty-state icon="boxes" title="No containers" [description]="s.docker ? 'Nothing is running on this host yet.' : 'Docker is not reachable — check the socket mount.'" />
        } @else {
          <div class="grid grid--cards">
            @for (st of s.stacks; track st.name) {
              <mk-card padding="none" class="stack-card" [class.stack-card--bad]="st.unhealthy > 0">
                <div class="stack-card__head">
                  <div class="stack-card__title">
                    <strong>{{ st.name }}</strong>
                    @if (st.description) {
                      <span class="muted">{{ st.description }}</span>
                    }
                  </div>
                  <div class="row">
                    @if (st.url) {
                      <a [href]="st.url" target="_blank" rel="noopener" class="plain stack-card__link" [title]="st.url"><mk-icon name="external-link" size="sm" /></a>
                    }
                    <mk-badge [tone]="st.unhealthy ? 'danger' : st.running === st.total ? 'success' : 'neutral'" size="sm">{{ st.running }}/{{ st.total }}</mk-badge>
                  </div>
                </div>
                <ul class="stack-card__list">
                  @for (c of st.containers; track c.id) {
                    <li class="crow">
                      <app-status-chip [container]="c" />
                      <a class="plain crow__name" [routerLink]="['/containers', c.id]" [title]="f.shortImage(c.image)">{{ c.name }}</a>
                      <span class="crow__stats muted nowrap">
                        @if (c.stats) {
                          {{ f.percent(c.stats.cpuPercent, 1) }} · {{ f.bytes(c.stats.memUsage, 0) }}
                        } @else {
                          {{ c.status }}
                        }
                      </span>
                      <app-container-actions [c]="c" [compact]="true" />
                    </li>
                  }
                </ul>
                @if (st.workingDir) {
                  <div class="stack-card__foot mono muted">{{ st.workingDir }}</div>
                }
              </mk-card>
            }
          </div>
        }
      </div>
    } @else {
      <div class="page loading">
        <mk-spinner size="lg" label="Connecting to the server" />
        @if (!live.connected()) {
          <p class="muted">Waiting for the server…</p>
        }
      </div>
    }
  `,
  styles: [
    `
      .alerts {
        display: grid;
        gap: var(--mk-space-2);
        margin-bottom: var(--mk-space-4);
      }
      .alert-link {
        margin-left: var(--mk-space-2);
        font-weight: var(--mk-font-weight-semibold);
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
      .charts {
        margin-top: var(--mk-space-4);
      }
      .stack {
        display: grid;
        gap: var(--mk-space-3);
      }
      .disk__row {
        display: flex;
        justify-content: space-between;
        gap: var(--mk-space-2);
        font-size: var(--mk-font-size-sm);
        margin-bottom: 4px;
      }
      .temps {
        display: flex;
        flex-wrap: wrap;
        gap: var(--mk-space-1);
      }
      .checks {
        display: flex;
        flex-wrap: wrap;
        gap: var(--mk-space-1);
      }
      .check {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: var(--mk-font-size-xs);
        padding: 2px 8px;
        border-radius: 999px;
        border: 1px solid var(--mk-border-subtle);
      }
      .check__dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: var(--mk-success);
      }
      .check--down {
        border-color: var(--mk-danger);
        color: var(--mk-danger);
      }
      .check--down .check__dot {
        background: var(--mk-danger);
      }
      .cores {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(18px, 1fr));
        gap: 3px;
        height: 22px;
      }
      .core {
        border-radius: 3px;
        background: linear-gradient(to top, var(--mk-chart-1) calc(var(--v) * 100%), var(--mk-border-subtle) calc(var(--v) * 100%));
      }
      .loading {
        display: grid;
        place-items: center;
        gap: var(--mk-space-3);
        min-height: 50vh;
      }
      .stack-card {
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }
      .stack-card--bad {
        outline: 1px solid var(--mk-danger);
      }
      .stack-card__head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--mk-space-2);
        padding: var(--mk-space-3) var(--mk-space-4);
        border-bottom: 1px solid var(--mk-border-subtle);
      }
      .stack-card__title {
        display: flex;
        flex-direction: column;
        min-width: 0;
      }
      .stack-card__title .muted {
        font-size: var(--mk-font-size-sm);
      }
      .stack-card__link {
        display: inline-flex;
        color: var(--mk-text-muted);
      }
      .stack-card__list {
        list-style: none;
        margin: 0;
        padding: var(--mk-space-1) 0;
        flex: 1;
      }
      .crow {
        display: grid;
        grid-template-columns: auto 1fr auto auto;
        align-items: center;
        gap: var(--mk-space-2);
        padding: var(--mk-space-1) var(--mk-space-4);
      }
      .crow__name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .crow__stats {
        font-size: var(--mk-font-size-sm);
        font-variant-numeric: tabular-nums;
      }
      .stack-card__foot {
        padding: var(--mk-space-2) var(--mk-space-4);
        font-size: var(--mk-font-size-xs);
        border-top: 1px solid var(--mk-border-subtle);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
    `,
  ],
})
export class OverviewPage {
  protected readonly live = inject(LiveService);
  protected readonly viewport = inject(ViewportService);
  private readonly router = inject(Router);
  protected readonly f = { bytes, duration, percent, rate, shortImage };
  protected readonly usageTone = usageTone;

  private readonly api = inject(ApiService);

  protected readonly snap = this.live.snapshot;
  /** The chart's window: the live ring, or a stored range fetched from the API. */
  protected readonly rangeOptions = RANGE_OPTIONS;
  protected readonly range = signal<ChartRange>('live');
  private readonly stored = storedHistory(this.range, (r) => this.api.history(r).then((h) => h.points));
  protected readonly hist = computed(() => (this.range() === 'live' ? this.live.history() : this.stored()));

  protected readonly cpuSpark = computed(() => this.live.history().slice(-60).map((h) => h.cpu));
  protected readonly memSpark = computed(() => this.live.history().slice(-60).map((h) => h.mem));
  protected readonly netSpark = computed(() => this.live.history().slice(-60).map((h) => h.netRx));
  protected readonly rootDisk = computed(() => {
    const disks = this.snap()?.host.disks ?? [];
    return disks.find((d) => d.mount === '/') ?? disks[0];
  });
  protected readonly ifaceNames = computed(() => (this.snap()?.host.net ?? []).map((n) => n.name).join(', '));
  protected readonly temps = computed(() => {
    const t = this.snap()?.host.temperatures ?? [];
    // one line per chip: the package/composite reading when there is one, else the max core
    const byChip = new Map<string, (typeof t)[number]>();
    for (const x of t) {
      const cur = byChip.get(x.chip);
      const isPkg = /package|composite|tctl|cpu/i.test(x.label);
      if (!cur || isPkg || (!/package|composite|tctl|cpu/i.test(cur.label) && x.celsius > cur.celsius)) byChip.set(x.chip, x);
    }
    return [...byChip.values()].map((x) => ({ ...x, label: chipLabel(x.chip) }));
  });
  protected readonly pkgTemp = computed(() => this.temps().find((t) => t.label === 'CPU')?.celsius);

  /** On a phone: ~60 averaged points and 3 labels; on desktop up to 240 points (every live sample) and 6 labels. */
  private readonly plotted = computed(() => {
    const h = this.hist();
    const narrow = this.viewport.narrow();
    const n = narrow ? 60 : Math.min(h.length, 240);
    const t = downsample(h, n, (p) => p.t);
    return { t, cpu: downsample(h, n, (p) => p.cpu), mem: downsample(h, n, (p) => p.mem), labels: narrow ? 3 : 6, format: axisLabel(this.range(), narrow) };
  });
  protected readonly categories = computed(() => {
    const p = this.plotted();
    return sparseLabels(p.t.length, p.labels, (i) => p.format(p.t[i]));
  });
  protected readonly series = computed<MkChartSeries[]>(() => {
    const p = this.plotted();
    return [
      { name: 'CPU %', data: p.cpu.map((v) => Math.round(v)) },
      { name: 'Memory %', data: p.mem.map((v) => Math.round(v)) },
    ];
  });
  protected readonly windowLabel = computed(() => {
    if (this.range() !== 'live') return rangeLabel(this.range()).toLowerCase();
    const h = this.hist();
    if (h.length < 2) return 'minutes';
    return duration((h[h.length - 1].t - h[0].t) / 1000);
  });

  tempTone(c: number, high?: number, crit?: number): 'neutral' | 'warning' | 'danger' {
    const limit = crit ?? high;
    if (limit && c >= limit - 5) return 'danger';
    if ((limit && c >= limit - 15) || (!limit && c >= 80)) return 'warning';
    return 'neutral';
  }
}
