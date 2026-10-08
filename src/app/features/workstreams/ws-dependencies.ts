// Workstream dependencies: what this workstream waits on and what it blocks.
// A dependency `from → to` means `from` blocks `to` (API.md, /dependencies).
import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, untracked, viewChild } from '@angular/core';
import { LucideArrowLeftToLine, LucideArrowRightFromLine, LucideDynamicIcon, LucideGitFork, LucidePlus, LucideX } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import { NablaStore, Notifier, WORKSTREAM_STATUS_META, type Dependency, type Workstream } from '../../core';
import { EntityChip } from '../../shared/entity-chip';
import { Kbd } from '../../shared/kbd';
import { Picker } from './picker';
import { WsActions } from './ws-actions';
import { workstreamOptions } from './ws-model';

interface DepRow {
  dep: Dependency;
  other: Workstream;
  /** The blocker is not shipped yet. */
  blocking: boolean;
}

@Component({
  selector: 'app-ws-dependencies',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet, HlmButtonImports, HlmTooltip, LucideDynamicIcon, EntityChip, Kbd, Picker],
  host: { class: 'block' },
  template: `
    <section aria-labelledby="ws-deps-title">
      <header class="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
        <svg [lucideIcon]="forkIcon" [size]="15" class="text-muted-foreground"></svg>
        <h2 id="ws-deps-title" class="text-sm font-semibold">Dependencies</h2>
        <span class="text-muted-foreground text-xs">
          @if (blockingCount()) {
            <span class="text-status-blocked font-medium">waiting on {{ blockingCount() }}</span> ·
          }
          other workstreams this one waits on or blocks
        </span>
      </header>

      <div class="grid gap-3 sm:grid-cols-2">
        <div class="bg-card rounded-lg border border-border-strong">
          <div class="flex h-8 items-center gap-1.5 border-b px-2.5 text-xs font-medium">
            <svg [lucideIcon]="inIcon" [size]="13" class="text-muted-foreground"></svg>Waits on
            <span class="text-muted-foreground tabular-nums">{{ waitsOn().length }}</span>
            @if (canEdit()) {
              <app-picker
                #waitPicker
                class="ml-auto"
                variant="bare"
                label="Add a workstream this one waits on"
                searchPlaceholder="Search workstreams…"
                triggerClass="size-6 justify-center text-muted-foreground hover:text-foreground"
                align="end"
                [options]="candidates()"
                [value]="[]"
                (valueChange)="add('waits', $event[0])"
              >
                <svg [lucideIcon]="plusIcon" [size]="13"></svg>
              </app-picker>
            }
          </div>
          <ul class="flex flex-col p-1">
            @for (d of waitsOn(); track d.dep.id) {
              <ng-container *ngTemplateOutlet="row; context: { $implicit: d }" />
            } @empty {
              <li class="text-muted-foreground px-1.5 py-1.5 text-xs">Not waiting on anything.</li>
            }
          </ul>
        </div>
        <div class="bg-card rounded-lg border border-border-strong">
          <div class="flex h-8 items-center gap-1.5 border-b px-2.5 text-xs font-medium">
            <svg [lucideIcon]="outIcon" [size]="13" class="text-muted-foreground"></svg>Blocks
            <span class="text-muted-foreground tabular-nums">{{ blocks().length }}</span>
            @if (canEdit()) {
              <app-picker
                class="ml-auto"
                variant="bare"
                label="Add a workstream this one blocks"
                searchPlaceholder="Search workstreams…"
                triggerClass="size-6 justify-center text-muted-foreground hover:text-foreground"
                align="end"
                [options]="candidates()"
                [value]="[]"
                (valueChange)="add('blocks', $event[0])"
              >
                <svg [lucideIcon]="plusIcon" [size]="13"></svg>
              </app-picker>
            }
          </div>
          <ul class="flex flex-col p-1">
            @for (d of blocks(); track d.dep.id) {
              <ng-container *ngTemplateOutlet="row; context: { $implicit: d }" />
            } @empty {
              <li class="text-muted-foreground px-1.5 py-1.5 text-xs">Nothing waits on this.</li>
            }
          </ul>
        </div>
      </div>
      @if (canEdit()) {
        <p class="text-muted-foreground mt-1.5 text-[11px]">Press <app-kbd keys="d" /> to add a workstream this one waits on.</p>
      }
    </section>

    <ng-template #row let-d>
      <li class="group/dep hover:bg-hover flex min-h-8 items-center gap-2 rounded-md px-1.5">
        <app-entity-chip type="workstream" [ref]="d.other.id" class="min-w-0 flex-1" />
        @if (d.blocking) {
          <span class="text-status-blocked shrink-0 text-[11px]" [hlmTooltip]="statusLabel(d.other) + ', not shipped yet'">blocking</span>
        } @else {
          <span class="text-muted-foreground shrink-0 text-[11px]">resolved</span>
        }
        @if (canEdit()) {
          <button hlmBtn variant="ghost" size="icon-xs" class="text-muted-foreground opacity-0 group-hover/dep:opacity-100 focus-visible:opacity-100 max-md:opacity-100" aria-label="Remove dependency" hlmTooltip="Remove dependency" (click)="remove(d)">
            <svg [lucideIcon]="xIcon" [size]="12"></svg>
          </button>
        }
      </li>
    </ng-template>
  `,
})
export class WsDependencies {
  private readonly store = inject(NablaStore);
  private readonly notify = inject(Notifier);
  private readonly actions = inject(WsActions);
  readonly ws = input.required<Workstream>();

  protected readonly forkIcon = LucideGitFork;
  protected readonly inIcon = LucideArrowLeftToLine;
  protected readonly outIcon = LucideArrowRightFromLine;
  protected readonly plusIcon = LucidePlus;
  protected readonly xIcon = LucideX;
  protected readonly canEdit = computed(() => this.store.can('member'));
  private readonly waitPicker = viewChild<Picker>('waitPicker');

  /** Blockers: dependencies pointing at this workstream. */
  protected readonly waitsOn = computed<DepRow[]>(() =>
    (this.store.incomingDependencies().get(this.ws().id) ?? [])
      .filter((d) => d.fromType === 'workstream')
      .map((dep) => ({ dep, other: this.store.getWorkstream(dep.fromId) }))
      .filter((r): r is { dep: Dependency; other: Workstream } => !!r.other)
      .map((r) => ({ ...r, blocking: r.other.status !== 'shipped' })),
  );
  /** Workstreams waiting on this one. */
  protected readonly blocks = computed<DepRow[]>(() =>
    (this.store.outgoingDependencies().get(this.ws().id) ?? [])
      .filter((d) => d.toType === 'workstream')
      .map((dep) => ({ dep, other: this.store.getWorkstream(dep.toId) }))
      .filter((r): r is { dep: Dependency; other: Workstream } => !!r.other)
      .map((r) => ({ ...r, blocking: this.ws().status !== 'shipped' })),
  );
  protected readonly blockingCount = computed(() => this.waitsOn().filter((d) => d.blocking).length);
  protected readonly candidates = computed(() => {
    const linked = new Set([this.ws().id, ...this.waitsOn().map((d) => d.other.id), ...this.blocks().map((d) => d.other.id)]);
    return workstreamOptions(this.store.workstreams().filter((w) => !linked.has(w.id) && w.status !== 'canceled'));
  });

  constructor() {
    effect(() => {
      const i = this.actions.intent();
      if (i?.kind === 'add-dependency') untracked(() => this.waitPicker() && this.actions.consume('add-dependency', this.ws().id) && this.waitPicker()!.open());
    });
  }

  protected statusLabel(w: Workstream): string {
    return WORKSTREAM_STATUS_META[w.status].label;
  }

  protected async add(kind: 'waits' | 'blocks', otherId: string | undefined): Promise<void> {
    if (!otherId) return;
    const me = this.ws().id;
    const [fromId, toId] = kind === 'waits' ? [otherId, me] : [me, otherId];
    const dep = await this.store.addDependency({ fromType: 'workstream', fromId, toType: 'workstream', toId });
    const other = this.store.getWorkstream(otherId);
    if (dep && other) {
      this.notify.success(kind === 'waits' ? `Now waiting on ${other.key}` : `${other.key} now waits on ${this.ws().key}`, {
        action: { label: 'Undo', run: () => void this.store.removeDependency(dep.id) },
      });
    }
  }

  protected remove(d: DepRow): void {
    const { fromType, fromId, toType, toId } = d.dep;
    void this.store.removeDependency(d.dep.id);
    this.notify.success('Dependency removed', {
      action: { label: 'Undo', run: () => void this.store.addDependency({ fromType, fromId, toType, toId }) },
    });
  }
}
