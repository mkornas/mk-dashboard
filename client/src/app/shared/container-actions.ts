import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { MkButton } from '@mk-kit/ui/button';
import { MkIcon } from '@mk-kit/ui/icon';
import { MkDialogService, MkToastService, MkTooltip } from '@mk-kit/ui/feedback';
import type { ContainerAction, ContainerSummary } from '../../../../shared/types';
import { ApiService, errorMessage } from '../core/api.service';
import { LiveService } from '../core/live.service';

/**
 * Start / stop / restart / update buttons for one container. Hidden entirely in
 * read-only mode; the disruptive ones confirm first.
 */
@Component({
  selector: 'app-container-actions',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MkButton, MkIcon, MkTooltip],
  template: `
    @if (!live.readonly()) {
      <span class="actions">
        @if (c().state === 'running' || c().state === 'paused') {
          <button mkButton variant="ghost" [size]="size()" [iconOnly]="compact()" mkTooltip="Restart" [loading]="busy() === 'restart'" [disabled]="!!busy()" (click)="run('restart')">
            <mk-icon name="rotate-cw" />@if (!compact()) {<span>Restart</span>}
          </button>
          <button mkButton variant="ghost" tone="danger" [size]="size()" [iconOnly]="compact()" mkTooltip="Stop" [loading]="busy() === 'stop'" [disabled]="!!busy()" (click)="run('stop')">
            <mk-icon name="square" />@if (!compact()) {<span>Stop</span>}
          </button>
        } @else {
          <button mkButton variant="ghost" tone="success" [size]="size()" [iconOnly]="compact()" mkTooltip="Start" [loading]="busy() === 'start'" [disabled]="!!busy()" (click)="run('start')">
            <mk-icon name="play" />@if (!compact()) {<span>Start</span>}
          </button>
        }
        @if (c().watchtower && live.meta()?.watchtower) {
          <button mkButton variant="ghost" [size]="size()" [iconOnly]="compact()" mkTooltip="Pull the latest image and recreate (watchtower)" [loading]="busy() === 'update'" [disabled]="!!busy()" (click)="run('update')">
            <mk-icon name="download" />@if (!compact()) {<span>Update</span>}
          </button>
        }
      </span>
    }
  `,
  styles: [
    `
      .actions {
        display: inline-flex;
        gap: var(--mk-space-1);
        align-items: center;
      }
    `,
  ],
})
export class ContainerActions {
  readonly c = input.required<Pick<ContainerSummary, 'id' | 'name' | 'state' | 'health' | 'watchtower' | 'image'>>();
  readonly compact = input(false);
  readonly done = output<ContainerAction>();

  protected readonly live = inject(LiveService);
  private readonly api = inject(ApiService);
  private readonly dialog = inject(MkDialogService);
  private readonly toast = inject(MkToastService);
  protected readonly busy = signal<ContainerAction | null>(null);
  protected readonly size = computed(() => (this.compact() ? 'sm' : 'md'));

  async run(action: ContainerAction): Promise<void> {
    const c = this.c();
    if (action === 'stop' || action === 'restart' || action === 'update') {
      const wording: Record<string, { title: string; message: string; tone: 'danger' | 'warning' | 'primary' }> = {
        stop: { title: `Stop ${c.name}?`, message: 'The container gets 15 seconds to shut down cleanly, then it is killed.', tone: 'danger' },
        restart: { title: `Restart ${c.name}?`, message: 'It will be unavailable for a few seconds.', tone: 'warning' },
        update: { title: `Update ${c.name}?`, message: `Watchtower pulls ${c.image} and recreates the container if the image changed.`, tone: 'primary' },
      };
      const w = wording[action];
      const ok = await this.dialog.confirm({ title: w.title, message: w.message, confirmText: action[0].toUpperCase() + action.slice(1), tone: w.tone });
      if (!ok) return;
    }
    this.busy.set(action);
    try {
      const r = await this.api.action(c.id, action);
      this.toast.success(r.message);
      this.done.emit(action);
    } catch (e) {
      this.toast.danger(errorMessage(e), { title: `${action} failed` });
    } finally {
      this.busy.set(null);
    }
  }
}
