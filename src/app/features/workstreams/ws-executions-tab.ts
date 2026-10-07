import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { LucideDynamicIcon, LucidePlus } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { NablaStore, type Workstream } from '../../core';
import { ExecutionDialogs, type ExecAction } from '../executions/execution-dialogs';
import { ExecutionTree } from '../executions/execution-tree';
import { InputRequestCard } from '../executions/input-request-card';
import { isTerminal } from './ws-model';

@Component({
  selector: 'app-ws-executions-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButtonImports, LucideDynamicIcon, ExecutionTree, ExecutionDialogs, InputRequestCard],
  host: { class: 'block' },
  template: `
    <div class="flex items-center gap-2 border-b px-4 py-2 sm:px-6">
      <span class="text-muted-foreground text-xs">
        {{ list().length }} execution{{ list().length === 1 ? '' : 's' }} · {{ active() }} active
      </span>
      @if (canEdit()) {
        <button hlmBtn size="sm" class="ml-auto" (click)="action.set({ kind: 'create', workstreamId: ws().id })">
          <svg [lucideIcon]="plus" [size]="14"></svg>New execution
        </button>
      }
    </div>
    @if (openInputs().length) {
      <div class="grid gap-2 border-b px-4 py-3 sm:px-6">
        @for (r of openInputs(); track r.id) {
          <app-input-request-card [request]="r" />
        }
      </div>
    }
    <app-execution-tree [workstreamId]="ws().id" (action)="action.set($event)" />
    <app-execution-dialogs [(action)]="action" />
  `,
})
export class WsExecutionsTab {
  private readonly store = inject(NablaStore);
  readonly ws = input.required<Workstream>();
  protected readonly action = signal<ExecAction | null>(null);
  protected readonly plus = LucidePlus;
  protected readonly canEdit = computed(() => this.store.can('member'));
  protected readonly list = computed(() => this.store.executionsByWorkstream().get(this.ws().id) ?? []);
  protected readonly active = computed(() => this.list().filter((e) => !isTerminal(e)).length);
  protected readonly openInputs = computed(() =>
    (this.store.inputRequestsByWorkstream().get(this.ws().id) ?? []).filter((r) => r.state === 'open'),
  );

  /** Called by the detail page's `c` shortcut. */
  openCreate(): void {
    this.action.set({ kind: 'create', workstreamId: this.ws().id });
  }
}
