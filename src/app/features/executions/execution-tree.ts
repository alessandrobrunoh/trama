// Execution tree of one workstream: parent → subthreads with connector lines, state menu,
// performers, provider, progress note, branch, session link and row actions.
import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  LucideCheck,
  LucideChevronDown,
  LucideChevronRight,
  LucideCircleCheck,
  LucideDynamicIcon,
  LucideEllipsis,
  LucideExternalLink,
  LucideGitBranch,
  LucideLink,
  LucideMessageSquarePlus,
  LucidePlus,
  LucideTrash2,
  LucideWorkflow,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import {
  EXECUTION_STATES,
  EXECUTION_STATE_META,
  NablaStore,
  UiStore,
  TERMINAL_EXECUTION_STATES,
  type Execution,
  type ExecutionNode,
  type ExecutionState,
} from '../../core';
import { AvatarStack } from '../../shared/actor-avatar';
import { ProviderIcon, providerLabel } from '../../shared/provider-icon';
import { StatusIcon } from '../../shared/status';
import { RelativeTimePipe } from '../../shared/pipes';
import type { ExecAction } from './execution-dialogs';

interface Row {
  e: Execution;
  depth: number;
  /** For each ancestor level: does a vertical guide continue through this row? */
  guides: boolean[];
  last: boolean;
  hasChildren: boolean;
}

/** State dropdown for one execution (also used on the execution detail page). */
@Component({
  selector: 'app-execution-state-menu',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButtonImports, HlmDropdownMenuImports, StatusIcon, LucideDynamicIcon],
  host: { class: 'inline-flex' },
  template: `
    <button
      hlmBtn
      variant="ghost"
      size="icon-sm"
      class="size-7 shrink-0"
      [hlmDropdownMenuTrigger]="menu"
      [disabled]="!canEdit()"
      [attr.aria-label]="'State: ' + label()"
    >
      <app-status-icon [status]="execution().state" [size]="15" />
    </button>
    <ng-template #menu>
      <hlm-dropdown-menu class="w-44">
        <hlm-dropdown-menu-label>Set state</hlm-dropdown-menu-label>
        <hlm-dropdown-menu-group>
          @for (s of states; track s) {
            <button hlmDropdownMenuItem (triggered)="set(s)">
              <app-status-icon [status]="s" /> {{ meta[s].label }}
              @if (s === execution().state) {
                <svg [lucideIcon]="check" [size]="13" class="ml-auto"></svg>
              }
            </button>
          }
        </hlm-dropdown-menu-group>
      </hlm-dropdown-menu>
    </ng-template>
  `,
})
export class ExecutionStateMenu {
  private readonly store = inject(NablaStore);
  readonly execution = input.required<Execution>();
  protected readonly states = EXECUTION_STATES;
  protected readonly meta = EXECUTION_STATE_META;
  protected readonly check = LucideCheck;
  protected readonly canEdit = computed(() => this.store.can('member'));
  protected readonly label = computed(() => EXECUTION_STATE_META[this.execution().state].label);
  protected set(s: ExecutionState): void {
    if (s !== this.execution().state) void this.store.updateExecution(this.execution().id, { state: s });
  }
}

/** The ⋯ actions of an execution row. */
@Component({
  selector: 'app-execution-actions',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButtonImports, HlmDropdownMenuImports, LucideDynamicIcon],
  host: { class: 'inline-flex' },
  template: `
    @if (canEdit()) {
      <button hlmBtn variant="ghost" size="icon-sm" class="text-muted-foreground size-7" [hlmDropdownMenuTrigger]="menu" aria-label="Execution actions">
        <svg [lucideIcon]="more" [size]="15"></svg>
      </button>
      <ng-template #menu>
        <hlm-dropdown-menu class="w-52">
          <hlm-dropdown-menu-group>
            <button hlmDropdownMenuItem (triggered)="act.emit({ kind: 'progress', executionId: execution().id })">
              <svg [lucideIcon]="msg" [size]="14"></svg> Report progress
            </button>
            @if (!terminal()) {
              <button hlmDropdownMenuItem (triggered)="act.emit({ kind: 'complete', executionId: execution().id })">
                <svg [lucideIcon]="done" [size]="14"></svg> Complete
              </button>
            }
            <button hlmDropdownMenuItem (triggered)="act.emit({ kind: 'create', workstreamId: execution().workstreamId, parentExecutionId: execution().id })">
              <svg [lucideIcon]="plus" [size]="14"></svg> Add child execution
            </button>
            <button hlmDropdownMenuItem (triggered)="act.emit({ kind: 'deps', executionId: execution().id })">
              <svg [lucideIcon]="link" [size]="14"></svg> Edit dependencies
            </button>
          </hlm-dropdown-menu-group>
          <hlm-dropdown-menu-separator />
          <button hlmDropdownMenuItem variant="destructive" (triggered)="remove()">
            <svg [lucideIcon]="trash" [size]="14"></svg> Delete
          </button>
        </hlm-dropdown-menu>
      </ng-template>
    }
  `,
})
export class ExecutionActions {
  private readonly store = inject(NablaStore);
  private readonly ui = inject(UiStore);
  readonly execution = input.required<Execution>();
  readonly act = output<ExecAction>();
  protected readonly canEdit = computed(() => this.store.can('member'));
  protected readonly terminal = computed(() => TERMINAL_EXECUTION_STATES.includes(this.execution().state));
  protected readonly more = LucideEllipsis;
  protected readonly msg = LucideMessageSquarePlus;
  protected readonly done = LucideCircleCheck;
  protected readonly plus = LucidePlus;
  protected readonly link = LucideLink;
  protected readonly trash = LucideTrash2;

  protected remove(): void {
    const e = this.execution();
    this.ui.setConfirmDelete({
      title: `Delete “${e.title}”?`,
      description: 'The execution and its sub-executions are removed. Artifacts stay attached to the workstream.',
      onConfirm: async () => {
        await this.store.deleteExecution(e.id);
      },
    });
  }
}

@Component({
  selector: 'app-execution-tree',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    HlmTooltip,
    LucideDynamicIcon,
    AvatarStack,
    ProviderIcon,
    RelativeTimePipe,
    ExecutionStateMenu,
    ExecutionActions,
  ],
  host: { class: 'block' },
  template: `
    @for (r of rows(); track r.e.id) {
      @let e = r.e;
      <div
        class="hover:bg-muted/50 group flex min-h-10 flex-wrap items-center border-b px-4 sm:px-6 md:flex-nowrap"
        [class.bg-muted]="ui.focusedRowId() === e.id"
        [attr.data-row-id]="e.id"
      >
        <span class="flex min-w-0 flex-1 items-center max-md:basis-full">
          @for (g of r.guides; track $index) {
            <span class="relative h-10 w-5 shrink-0 self-stretch">
              @if (g) {
                <span class="border-border absolute inset-y-0 left-2.5 border-l"></span>
              }
            </span>
          }
          @if (r.depth > 0) {
            <span class="relative h-10 w-5 shrink-0 self-stretch">
              <span class="border-border absolute top-0 left-2.5 h-1/2 w-2.5 rounded-bl-md border-b border-l"></span>
              @if (!r.last) {
                <span class="border-border absolute inset-y-0 left-2.5 border-l"></span>
              }
            </span>
          }
          @if (r.hasChildren) {
            <button class="text-muted-foreground hover:text-foreground -ml-1 flex size-5 shrink-0 items-center justify-center rounded" (click)="toggle(e.id)" [attr.aria-label]="collapsed().has(e.id) ? 'Expand' : 'Collapse'" [attr.aria-expanded]="!collapsed().has(e.id)">
              <svg [lucideIcon]="collapsed().has(e.id) ? right : down" [size]="13"></svg>
            </button>
          } @else if (r.depth === 0) {
            <span class="w-4 shrink-0"></span>
          }
          <app-execution-state-menu [execution]="e" />
          <a
            [routerLink]="['/', slug(), 'executions', e.id]"
            class="hover:underline min-w-0 flex-1 truncate px-1.5 py-1 text-sm outline-none focus-visible:underline"
            [class.text-muted-foreground]="e.state === 'completed' || e.state === 'canceled'"
            >{{ e.title }}</a
          >
          @if (waiting(e); as w) {
            <span class="text-status-blocked mr-1 inline-flex shrink-0 items-center gap-1 text-xs" [hlmTooltip]="'Waiting on ' + w + ' execution(s)'" position="bottom">
              <svg [lucideIcon]="linkIcon" [size]="12"></svg>{{ w }}
            </span>
          }
        </span>
        <span class="flex items-center gap-2 max-md:order-last max-md:basis-full max-md:pb-1.5 max-md:pl-[34px]">
          <span class="text-muted-foreground hidden max-w-[16rem] truncate text-xs xl:inline" [hlmTooltip]="e.progressNote ?? ''" position="bottom">{{ e.progressNote }}</span>
          @if (e.branch) {
            <span class="text-muted-foreground bg-muted hidden max-w-36 items-center gap-1 truncate rounded px-1.5 py-0.5 font-mono text-[11px] lg:inline-flex">
              <svg [lucideIcon]="branch" [size]="11" class="shrink-0"></svg><span class="truncate">{{ e.branch }}</span>
            </span>
          }
          <app-provider-icon [provider]="e.provider" [size]="14" class="text-muted-foreground" [hlmTooltip]="label(e.provider)" position="bottom" />
          <span class="min-w-[3.25rem]">
            @if (e.performers.length) {
              <app-avatar-stack [actors]="e.performers" [max]="3" [size]="20" />
            }
          </span>
          @if (e.sessionUrl) {
            <a [href]="e.sessionUrl" target="_blank" rel="noopener" class="text-muted-foreground hover:text-foreground inline-flex size-6 items-center justify-center rounded hover:bg-accent" aria-label="Open session" [hlmTooltip]="'Open session'" position="bottom">
              <svg [lucideIcon]="ext" [size]="13"></svg>
            </a>
          } @else {
            <span class="size-6"></span>
          }
          <span class="text-muted-foreground hidden w-20 text-right text-xs whitespace-nowrap tabular-nums sm:inline">{{ e.updatedAt | relativeTime }}</span>
          <app-execution-actions [execution]="e" (act)="action.emit($event)" />
        </span>
      </div>
    } @empty {
      <div class="text-muted-foreground flex flex-col items-center gap-2 px-4 py-10 text-sm">
        <svg [lucideIcon]="flow" [size]="20"></svg>
        <p>No executions yet.</p>
      </div>
    }
  `,
})
export class ExecutionTree {
  protected readonly store = inject(NablaStore);
  protected readonly ui = inject(UiStore);
  readonly workstreamId = input.required<string>();
  readonly action = output<ExecAction>();

  protected readonly collapsed = signal<ReadonlySet<string>>(new Set());
  protected readonly slug = computed(() => this.store.slug() ?? '');
  protected readonly down = LucideChevronDown;
  protected readonly right = LucideChevronRight;
  protected readonly branch = LucideGitBranch;
  protected readonly ext = LucideExternalLink;
  protected readonly flow = LucideWorkflow;
  protected readonly linkIcon = LucideLink;
  protected readonly label = providerLabel;

  protected readonly rows = computed<Row[]>(() => {
    const roots = this.store.executionTrees().get(this.workstreamId()) ?? [];
    const collapsed = this.collapsed();
    const out: Row[] = [];
    const walk = (nodes: ExecutionNode[], depth: number, guides: boolean[]): void => {
      nodes.forEach((n, i) => {
        const last = i === nodes.length - 1;
        out.push({ e: n.execution, depth, guides, last, hasChildren: n.children.length > 0 });
        if (n.children.length && !collapsed.has(n.execution.id)) {
          // children's guide columns: ancestors' guides + this level (if it continues)
          walk(n.children, depth + 1, depth === 0 ? [] : [...guides, !last]);
        }
      });
    };
    walk(roots, 0, []);
    return out;
  });

  protected toggle(id: string): void {
    this.collapsed.update((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  /** Number of unfinished dependencies. */
  protected waiting(e: Execution): number {
    return e.dependsOnExecutionIds.filter((id) => {
      const d = this.store.getExecution(id);
      return d && d.state !== 'completed';
    }).length;
  }
}
