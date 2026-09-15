/**
 * The charts' range picker: "Live" is the sampler's per-sample ring pushed
 * over SSE; the other ranges come from the stored history (minutes for a
 * day, hours for a month) and are re-fetched every minute while selected.
 */
import { DestroyRef, type Signal, effect, inject, signal, untracked } from '@angular/core';
import type { HistoryRange } from '../../../../shared/types';
import { dayTime, time, timeShort } from '../core/format';

export type ChartRange = 'live' | HistoryRange;

export const RANGE_OPTIONS: Array<{ label: string; value: ChartRange }> = [
  { label: 'Live', value: 'live' },
  { label: '1 hour', value: '1h' },
  { label: '24 hours', value: '24h' },
  { label: '7 days', value: '7d' },
  { label: '30 days', value: '30d' },
];

export function rangeLabel(range: ChartRange): string {
  return RANGE_OPTIONS.find((o) => o.value === range)?.label ?? range;
}

/** How a point's time is written on the axis: seconds live, minutes within a day, day + time beyond. */
export function axisLabel(range: ChartRange, narrow: boolean): (ts: number) => string {
  if (range === '7d' || range === '30d') return dayTime;
  if (range === 'live' && !narrow) return time;
  return timeShort;
}

/**
 * Points for the selected stored range, refreshed every minute while it stays
 * selected; empty for "live". `deps` is read inside the effect so a change
 * there (another container) reloads too. Call from an injection context.
 */
export function storedHistory<T>(range: Signal<ChartRange>, load: (range: HistoryRange) => Promise<T[]>, deps: () => unknown = () => undefined): Signal<T[]> {
  const out = signal<T[]>([]);
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };
  effect(() => {
    const r = range();
    deps();
    untracked(() => {
      stop();
      out.set([]);
      if (r === 'live') return;
      const go = () =>
        load(r)
          .then((points) => {
            if (range() === r) out.set(points);
          })
          .catch(() => undefined);
      void go();
      timer = setInterval(go, 60_000);
    });
  });
  inject(DestroyRef).onDestroy(stop);
  return out.asReadonly();
}
