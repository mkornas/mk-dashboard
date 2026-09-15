import type { MkTone } from '@mk-kit/ui/core';
import type { ContainerSummary, HealthStatus } from '../../../../shared/types';

/** One word for the chip, one tone for the colour. */
export function containerStatus(c: Pick<ContainerSummary, 'state' | 'health'>): { label: string; tone: MkTone } {
  if (c.state === 'running') {
    if (c.health === 'unhealthy') return { label: 'unhealthy', tone: 'danger' };
    if (c.health === 'starting') return { label: 'starting', tone: 'warning' };
    return { label: c.health === 'healthy' ? 'healthy' : 'running', tone: 'success' };
  }
  if (c.state === 'restarting') return { label: 'restarting', tone: 'danger' };
  if (c.state === 'paused') return { label: 'paused', tone: 'warning' };
  return { label: c.state, tone: 'neutral' };
}

export function healthTone(h: HealthStatus): MkTone {
  return h === 'healthy' ? 'success' : h === 'unhealthy' ? 'danger' : h === 'starting' ? 'warning' : 'neutral';
}

export function usageTone(percent: number): MkTone {
  return percent >= 90 ? 'danger' : percent >= 75 ? 'warning' : 'primary';
}
