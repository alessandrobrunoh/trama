import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  booleanAttribute,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { LucideCornerDownRight, LucideDynamicIcon, LucidePlus } from '@lucide/angular';
import { HlmButton } from '@spartan-ng/helm/button';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { TramaStore, type Issue } from '../../core';
import { ActorAvatar } from '../../shared/actor-avatar';
import { V3Check, V3Thread } from '../../shared/v3';
import { isClosedIssue, quietToggleStatus, subtaskStatus } from './issue-model';
import { IssueProp } from './issue-prop';
import { IssueActions } from './issue-actions';
import { TaskBurnup, hasBurnup, taskBurnModel } from './task-burnup';
import { TaskChildren } from './task-children';
import { TaskSectionHead } from './task-section-head';
import { buildRows, buildSubtree, percent, type SubtreeRow } from './task-subtree-model';

/**
 * The subtasks of a task as a tree that goes as deep as the data does (sub-sub-...-tasks), in the v3 "Subtasks"
 * section: a header with the count and "Add subtask", a 3px progress bar (the burn-up once work has started) and one 38px row per task: check, key,
 * title, thread link, estimate, status, assignee. Double click opens the task. The tree is built from the store's
 * flat list in one pass, no request per level.
 *
 * `flat` lists only the direct children of `issue` (minus `exclude`): the "Other subtasks of TRM-128" of a subtask.
 *
 * Keyboard (rows are a roving-tabindex tree): ↑ ↓ move, → enters the first child, ← goes to the parent,
 * Enter opens. New subtasks start in the parent's project and status; Enter in the input adds one and keeps the
 * input open for the next, Esc closes it.
 */
@Component({
  selector: 'app-issue-subtasks',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    HlmButton,
    HlmInputImports,
    ActorAvatar,
    IssueProp,
    LucideDynamicIcon,
    TaskBurnup,
    TaskSectionHead,
    V3Check,
    V3Thread,
  ],
  host: { class: 'flex min-w-0 flex-col' },
  template: `
    <app-task-section-head [title]="flat() ? title() : 'Subtasks'" [caption]="caption()">
      @if (!flat() && canCreate()) {
        <button
          hlmBtn
          type="button"
          variant="ghost"
          class="h-[25px]"
          [attr.aria-label]="'Add subtask to ' + issue().key"
          (click)="startAdd(issue().id)"
        >
          <svg [lucideIcon]="plusIcon" [size]="13" aria-hidden="true"></svg>
          Add subtask
        </button>
      }
    </app-task-section-head>

    @if (!flat() && tree().total > 0) {
      @if (burnup()) {
        <app-task-burnup class="my-2.5" [issue]="issue()" [tasks]="allTasks()" />
      } @else {
        <div
          id="issue-subtasks-progress"
          class="bg-secondary h-[3px] w-full"
          role="progressbar"
          aria-label="Subtasks finished"
          [attr.aria-valuenow]="progress()"
          aria-valuemin="0"
          aria-valuemax="100"
        >
          <span class="bg-green block h-full transition-[width]" [style.width.%]="progress()"></span>
        </div>
      }
    }

    <div
      role="tree"
      [attr.aria-label]="flat() ? title() : 'Subtasks'"
      class="flex min-w-0 flex-col"
      (keydown)="onKeydown($event)"
    >
      @for (row of rows(); track rowKey(row)) {
        @if (row.kind === 'node') {
          @let n = row.node;
          @let c = n.task;
          <div
            role="treeitem"
            class="group hover:bg-hover focus-visible:ring-ring border-border flex min-h-[38px] min-w-0 items-center gap-2.5 border-b pr-3.5 outline-none focus-visible:ring-2"
            [style.padding-left.px]="14 + n.depth * 18"
            [attr.data-id]="c.id"
            [attr.aria-level]="n.depth + 1"
            [attr.tabindex]="tabbable(c.id) ? 0 : -1"
            (focus)="active.set(c.id)"
            (dblclick)="openChild(c, $event)"
          >
            <svg [lucideIcon]="indentIcon" [size]="13" class="text-faint shrink-0" aria-hidden="true"></svg>
            <button
              type="button"
              tabindex="-1"
              class="focus-visible:ring-ring inline-flex shrink-0 outline-none focus-visible:ring-2 disabled:cursor-default"
              [attr.aria-label]="closed(c) ? 'Reopen ' + c.key : 'Mark ' + c.key + ' done'"
              [disabled]="!canEdit()"
              (click)="toggleDone(c)"
            >
              <v3-check [done]="closed(c)" />
            </button>
            <span class="text-faint shrink-0 font-mono text-[11px] leading-[14px]">{{ c.key }}</span>
            <a
              [routerLink]="['/', slug(), 'tasks', c.key]"
              tabindex="-1"
              class="text-foreground min-w-0 flex-1 truncate text-[13px] leading-4 outline-none hover:underline"
              [class.text-muted-foreground]="closed(c)"
              >{{ c.title }}</a
            >
            <v3-thread class="max-sm:hidden" [issue]="c" />
            @if (showEstimate(c)) {
              <app-issue-prop class="max-sm:hidden" [issue]="c" field="estimate" chip />
            }
            <app-issue-prop [issue]="c" field="status" chip [caret]="false" />
            @if (c.assigneeId) {
              <app-actor-avatar [actor]="{ type: 'user', id: c.assigneeId }" [size]="22" />
            } @else {
              <span class="size-[22px] shrink-0" aria-hidden="true"></span>
            }
          </div>
        } @else {
          <div
            class="border-border flex min-h-[38px] items-center gap-2.5 border-b pr-3.5"
            role="none"
            [style.padding-left.px]="14 + row.depth * 18"
          >
            <svg [lucideIcon]="indentIcon" [size]="13" class="text-faint shrink-0" aria-hidden="true"></svg>
            <input
              #field
              hlmInput
              class="h-7 min-w-0 flex-1 text-[13px]"
              placeholder="Subtask title, Enter to add"
              aria-label="Subtask title"
              autocomplete="off"
              [value]="draft()"
              (input)="draft.set($any($event.target).value)"
              (keydown.enter)="onEnter($event)"
              (keydown.escape)="close($event)"
              (keydown)="$event.stopPropagation()"
              (blur)="onBlur()"
            />
          </div>
        }
      }
    </div>
  `,
})
export class IssueSubtasks {
  private readonly store = inject(TramaStore);
  private readonly router = inject(Router);
  private readonly children = inject(TaskChildren);
  private readonly actions = inject(IssueActions);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  /** The task whose subtasks are listed. */
  readonly issue = input.required<Issue>();
  /** List only the direct children, without folding, adding or progress (the siblings of a subtask). */
  readonly flat = input(false, { transform: booleanAttribute });
  /** A child to leave out of a `flat` list (the subtask the page is about). */
  readonly exclude = input<string | null>(null);
  /** Heading of a `flat` list. */
  readonly title = input('Subtasks');

  protected readonly plusIcon = LucidePlus;
  protected readonly indentIcon = LucideCornerDownRight;

  protected readonly slug = computed(() => this.store.slug() ?? '');
  protected readonly canCreate = computed(() => this.store.allowed('createIssues'));
  protected readonly canEdit = computed(() => this.store.can('member'));
  private readonly entries = computed(() => this.store.settings().statuses.issue);

  protected readonly tree = computed(() =>
    buildSubtree(this.issue().id, this.children.byParent(), (t) => isClosedIssue(t, this.entries())),
  );
  protected readonly progress = computed(() => percent(this.tree().done, this.tree().total));
  /** Every task below, for the burn-up. */
  protected readonly allTasks = computed(() => Array.from(this.tree().byId.values(), (n) => n.task));
  /** Once some subtask has been started the burn-up replaces the thin bar (v3 "Task detail · Progress"). */
  protected readonly burnup = computed(() =>
    hasBurnup(taskBurnModel(this.issue(), this.allTasks(), this.store.estimateScale())),
  );

  protected readonly caption = computed(() => {
    if (this.flat()) return 'each with 0 or 1 thread';
    const t = this.tree();
    return `${t.total ? `${t.done} of ${t.total} done` : 'none yet'} · each subtask can link its own Delta thread`;
  });

  private readonly noneCollapsed: ReadonlySet<string> = new Set();

  /** The task a new subtask is being typed under (the page's own task for the top level). */
  protected readonly addingTo = signal<string | null>(null);
  protected readonly draft = signal('');
  private readonly busy = signal(false);
  private readonly field = viewChild<ElementRef<HTMLInputElement>>('field');

  protected readonly rows = computed<SubtreeRow<Issue>[]>(() => {
    if (this.flat()) {
      const skip = this.exclude();
      return this.tree()
        .roots.filter((n) => n.task.id !== skip)
        .map((node) => ({ kind: 'node' as const, node }));
    }
    return buildRows(this.issue().id, this.tree().roots, this.noneCollapsed, this.addingTo());
  });
  private readonly nodeIds = computed(() =>
    this.rows().flatMap((r) => (r.kind === 'node' ? [r.node.task.id] : [])),
  );

  /** Roving tabindex: the row last focused, else the first. */
  protected readonly active = signal<string | null>(null);

  constructor() {
    effect(() => this.field()?.nativeElement.focus());
    // Another task opened in the same page: start over.
    let last: string | undefined;
    effect(() => {
      const id = this.issue().id;
      if (last !== undefined && last !== id) {
        this.addingTo.set(null);
        this.draft.set('');
        this.active.set(null);
      }
      last = id;
    });
  }

  protected rowKey(row: SubtreeRow<Issue>): string {
    return row.kind === 'node' ? row.node.task.id : `add:${row.parentId}`;
  }

  protected tabbable(id: string): boolean {
    const ids = this.nodeIds();
    const active = this.active();
    return (active && ids.includes(active) ? active : ids[0]) === id;
  }

  protected closed(issue: Issue): boolean {
    return isClosedIssue(issue, this.entries());
  }

  /** Estimates are off in this workspace: a task without one shows no chip. */
  protected showEstimate(issue: Issue): boolean {
    return this.store.estimateScale() !== 'none' || (issue.estimate !== undefined && issue.estimate !== null);
  }

  /** The check: finishes the task, or puts it back to the workspace's "todo". */
  protected toggleDone(issue: Issue): void {
    if (!this.canEdit()) return;
    this.actions.setStatus([issue.id], quietToggleStatus(this.entries(), this.closed(issue)));
  }

  // ───────────────────────── opening ─────────────────────────

  /** Double click on a subtask row opens it (pickers, the title link and the buttons keep their own behavior). */
  protected openChild(child: Issue, event: MouseEvent): void {
    if ((event.target as HTMLElement | null)?.closest('a, button, input')) return;
    this.open(child);
  }

  private open(child: Issue): void {
    void this.router.navigate(['/', this.slug(), 'tasks', child.key]);
  }

  // ───────────────────────── keyboard ─────────────────────────

  protected onKeydown(event: KeyboardEvent): void {
    const el = event.target as HTMLElement | null;
    // Only the row itself: pickers, buttons and the input inside it keep their own keys.
    if (!el || el.getAttribute('role') !== 'treeitem' || event.altKey || event.ctrlKey || event.metaKey) return;
    const id = el.dataset['id'];
    const node = id ? this.tree().byId.get(id) : undefined;
    if (!id || !node) return;
    const ids = this.nodeIds();
    const at = ids.indexOf(id);

    switch (event.key) {
      case 'ArrowDown':
        this.focusRow(ids[at + 1]);
        break;
      case 'ArrowUp':
        this.focusRow(ids[at - 1]);
        break;
      case 'ArrowRight':
        if (!node.children.length || this.flat()) return;
        this.focusRow(node.children[0].task.id);
        break;
      case 'ArrowLeft':
        if (this.flat()) return;
        if (node.task.parentId && node.task.parentId !== this.issue().id) this.focusRow(node.task.parentId);
        break;
      case 'Home':
        this.focusRow(ids[0]);
        break;
      case 'End':
        this.focusRow(ids[ids.length - 1]);
        break;
      case 'Enter':
        this.open(node.task);
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  private focusRow(id: string | undefined): void {
    if (!id) return;
    this.active.set(id);
    queueMicrotask(() => this.host.nativeElement.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`)?.focus());
  }

  // ───────────────────────── adding ─────────────────────────

  protected startAdd(parentId: string): void {
    if (this.flat()) return;
    this.addingTo.set(parentId);
  }

  protected close(event?: Event): void {
    event?.stopPropagation();
    this.addingTo.set(null);
    this.draft.set('');
  }

  /** Leaving the input empty closes it; a typed title stays so a stray click does not lose it. */
  protected onBlur(): void {
    if (!this.draft().trim()) this.addingTo.set(null);
  }

  protected onEnter(event: Event): void {
    event.preventDefault();
    if ((event as KeyboardEvent).isComposing) return;
    void this.add();
  }

  private async add(): Promise<void> {
    const title = this.draft().trim();
    const parentId = this.addingTo();
    const parent = parentId === this.issue().id ? this.issue() : this.store.issueById().get(parentId ?? '');
    if (!title || !parent || this.busy()) return;
    this.busy.set(true);
    try {
      const created = await this.store.createIssue({
        kind: parent.kind,
        title,
        parentId: parent.id,
        projectId: parent.projectId,
        status: subtaskStatus(parent, this.entries()),
      });
      // Keep what was typed meanwhile; on failure the store has already said why and the title stays.
      if (created && this.draft().trim() === title) this.draft.set('');
    } finally {
      this.busy.set(false);
    }
  }
}
