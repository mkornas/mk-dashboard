import { DOCUMENT, Injectable, inject, signal } from '@angular/core';

/** Narrow-screen flag (≤ 640px) for components that need to choose, not just reflow. */
@Injectable({ providedIn: 'root' })
export class ViewportService {
  private readonly window = inject(DOCUMENT).defaultView;
  readonly narrow = signal(false);

  constructor() {
    const mql = this.window?.matchMedia?.('(max-width: 640px)');
    if (!mql) return;
    this.narrow.set(mql.matches);
    mql.addEventListener('change', (e) => this.narrow.set(e.matches));
  }
}

/** Average consecutive points into at most `n` buckets, keeping the last point exact. */
export function downsample<T>(points: T[], n: number, pick: (p: T) => number): number[] {
  if (points.length <= n) return points.map(pick);
  const size = points.length / n;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const start = Math.floor(i * size);
    const end = Math.max(start + 1, Math.floor((i + 1) * size));
    let sum = 0;
    for (let j = start; j < end; j++) sum += pick(points[j]);
    out.push(sum / (end - start));
  }
  out[out.length - 1] = pick(points[points.length - 1]);
  return out;
}

/** Category labels: `labels` evenly spaced, blank elsewhere. */
export function sparseLabels(count: number, labels: number, format: (index: number) => string): string[] {
  if (count === 0) return [];
  const step = Math.max(1, (count - 1) / Math.max(1, labels - 1));
  const marks = new Set<number>();
  for (let k = 0; k < labels; k++) marks.add(Math.round(k * step));
  marks.add(count - 1);
  return Array.from({ length: count }, (_, i) => (marks.has(i) ? format(i) : ''));
}
