import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { MkBadge } from '@mk-kit/ui/status';
import type { ContainerSummary } from '../../../../shared/types';
import { containerStatus } from './status';

/** Coloured state pill for a container: healthy / running / exited / …. */
@Component({
  selector: 'app-status-chip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MkBadge],
  template: `<mk-badge [tone]="s().tone" size="sm">{{ s().label }}</mk-badge>`,
})
export class StatusChip {
  readonly container = input.required<Pick<ContainerSummary, 'state' | 'health'>>();
  protected readonly s = computed(() => containerStatus(this.container()));
}
