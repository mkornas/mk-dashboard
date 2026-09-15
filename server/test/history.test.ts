import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HistoryStore } from '../src/history.ts';
import type { Snapshot } from '../../shared/types.ts';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 10, 0, 0, 0);

function snap(t: number, cpu: number, containers: Array<[string, number, number]> = []): Snapshot {
  return {
    t,
    host: { cpu: { percent: cpu }, memory: { percent: 50 }, netRxRate: 1000, netTxRate: 100 },
    containers: containers.map(([name, cpuPercent, memUsage]) => ({ name, stats: { cpuPercent, memUsage } })),
  } as unknown as Snapshot;
}

test('samples are averaged per minute for the host and per container name', () => {
  const h = new HistoryStore({ dataDir: '', historyDays: 30 });
  h.record(snap(T0, 10, [['app', 1, 100]]));
  h.record(snap(T0 + 3000, 30, [['app', 3, 300]]));
  h.record(snap(T0 + MINUTE, 50)); // a new minute writes the one before
  const host = h.host('1h', T0 + MINUTE);
  assert.deepEqual(host.points, [{ t: T0, cpu: 20, mem: 50, netRx: 1000, netTx: 100 }]);
  assert.equal(host.step, MINUTE);
  assert.deepEqual(h.container('app', '1h', T0 + MINUTE).points, [{ t: T0, cpu: 2, mem: 200 }]);
  assert.deepEqual(h.container('other', '1h', T0 + MINUTE).points, []);
  h.close();
});

test('minutes roll up into hours when the hour turns; ranges pick the right table; old rows go', () => {
  const h = new HistoryStore({ dataDir: '', historyDays: 3 });
  // five days of one sample per minute, cpu = hour of day, in a single pass
  const start = T0 - 5 * DAY;
  for (let t = start; t < T0; t += MINUTE) h.record(snap(t, new Date(t).getUTCHours(), [['app', 5, 1e6]]));
  h.record(snap(T0, 0)); // turns the last hour
  const day = h.host('24h', T0);
  assert.equal(day.step, MINUTE);
  assert.equal(day.points.length, 24 * 60);
  const week = h.host('7d', T0);
  assert.equal(week.step, HOUR);
  assert.equal(week.points.length, 3 * 24, 'hours older than DASH_HISTORY_DAYS are pruned');
  assert.equal(week.points[0].t, T0 - 3 * DAY);
  assert.equal(week.points[13].cpu, 13, 'an hour row is the average of its minutes');
  assert.equal(h.host('1h', T0).points.length, 60);
  assert.equal(h.container('app', '30d', T0).points.length, 3 * 24);
  assert.ok(h.host('24h', T0 - 3 * DAY).points.every((p) => p.t >= T0 - 2 * DAY), 'minutes older than two days are pruned');
  h.close();
});

test('an unknown range is refused by the type guard', async () => {
  const { isRange } = await import('../src/history.ts');
  assert.equal(isRange('24h'), true);
  assert.equal(isRange('2d'), false);
  assert.equal(isRange(undefined), false);
});
