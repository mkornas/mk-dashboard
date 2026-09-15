import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MkBadge, MkEmptyState } from '@mk-kit/ui/status';
import type { DockerEvent } from '../../../../shared/types';
import { dateTimeSec } from '../core/format';

/** A compact timeline of docker events, newest first. */
@Component({
  selector: 'app-event-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, MkBadge, MkEmptyState],
  template: `
    @if (events().length === 0) {
      <mk-empty-state icon="history" title="No events yet" description="Container starts, stops, exits, OOM kills and health changes show up here as they happen." size="sm" />
    } @else {
      <ul class="ev">
        @for (e of events(); track e.t + e.id + e.action) {
          <li class="ev__row" [class.ev__row--danger]="e.level === 'danger'" [class.ev__row--warning]="e.level === 'warning'">
            <span class="ev__time muted nowrap">{{ f.dateTime(e.t) }}</span>
            <mk-badge [tone]="e.level === 'danger' ? 'danger' : e.level === 'warning' ? 'warning' : 'neutral'" size="sm" variant="soft">{{ e.action }}</mk-badge>
            <span class="ev__what">
              @if (!hideContainer()) {
                <a [routerLink]="['/containers', e.id]" class="plain"><strong>{{ e.container }}</strong></a>
                @if (e.stack && e.stack !== e.container) {
                  <span class="muted small"> · {{ e.stack }}</span>
                }
              }
              @if (e.detail) {
                <span class="muted"> {{ hideContainer() ? '' : '— ' }}{{ e.detail }}</span>
              }
            </span>
          </li>
        }
      </ul>
    }
  `,
  styles: [
    `
      .ev {
        list-style: none;
        margin: var(--mk-space-3) 0 0;
        padding: 0;
      }
      .ev__row {
        display: grid;
        grid-template-columns: 170px auto 1fr;
        gap: var(--mk-space-3);
        align-items: center;
        padding: var(--mk-space-1) var(--mk-space-2);
        border-left: 3px solid transparent;
        font-size: var(--mk-font-size-sm);
      }
      .ev__row--warning {
        border-left-color: var(--mk-warning);
      }
      .ev__row--danger {
        border-left-color: var(--mk-danger);
      }
      .small {
        font-size: var(--mk-font-size-xs);
      }
      @media (max-width: 640px) {
        .ev__row {
          grid-template-columns: auto 1fr;
        }
        .ev__time {
          grid-column: 1 / -1;
        }
      }
    `,
  ],
})
export class EventList {
  readonly events = input.required<DockerEvent[]>();
  readonly hideContainer = input(false);
  protected readonly f = { dateTime: dateTimeSec };
}
