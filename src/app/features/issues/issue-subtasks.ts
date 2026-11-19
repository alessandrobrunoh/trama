import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import {
  LucideChevronRight,
  LucideChevronsDownUp,
  LucideChevronsUpDown,
  LucideCircleDashed,
  LucideDynamicIcon,
  LucidePlus,
} from '@lucide/angular';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import { TramaStore, type Issue } from '../../core';
import { isClosedIssue, subtaskStatus } from './issue-model';
import { IssueProp } from './issue-prop';
import { TaskChildren } from './task-children';
import {
  buildRows,
  buildSubtree,
  expandableIds,
  percent,
  type SubtreeNode,
  type SubtreeRow,
} from './task-subtree-model';

/**
 * The subtasks of a task as a collapsible tree that goes as deep as the data does (sub-sub-...-tasks). Each row
 * shows the status, key, title, the progress of everything below it and the assignee; the chevron folds a level,
 * "+" adds a subtask under any row, double click opens the task. The tree is built from the store's flat list in
 * one pass, no request per level.
 *
 * Keyboard (rows are a roving-tabindex tree): ↑ ↓ move, → expands or enters, ← collapses or goes to the parent,
 * Enter opens. New subtasks start in the parent's project and status; Enter in the input adds one and keeps the
 * input open for the next, Esc closes it.
 */
@Component({
  selector: 'app-issue-subtasks',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, HlmInputImports, HlmTooltip, IssueProp, LucideDynamicIcon],
  host: { class: 'block min-w-0' },
  template: `
    @if (tree().total > 0) {
      <div class="mb-1.5 flex items-center gap-2 px-1">
        <h2 id="issue-subtasks-heading" class="text-muted-foreground text-xs font-medium">Subtasks</h2>
        <span class="text-muted-foreground text-xs tabular-nums">{{ tree().done }}/{{ tree().total }}</span>
        <span
          class="bg-foreground/10 h-1 min-w-8 flex-1 overflow-hidden rounded-full"
          role="progressbar"
          aria-label="Subtasks finished"
          [attr.aria-valuenow]="progress()"
          aria-valuemin="0"
          aria-valuemax="100"
        >
          <span class="bg-status-shipped block h-full rounded-full transition-[width]" [style.width.%]="progress()"></span>
        </span>
        @if (expandable().length) {
          <button
            type="button"
            class="text-muted-foreground hover:bg-hover hover:text-foreground focus-visible:ring-ring inline-flex size-6 shrink-0 items-center justify-center rounded-md outline-none focus-visible:ring-2"
            [attr.aria-label]="allCollapsed() ? 'Expand all subtasks' : 'Collapse all subtasks'"
            [hlmTooltip]="allCollapsed() ? 'Expand all' : 'Collapse all'"
            (click)="toggleAll()"
          >
            <svg [lucideIcon]="allCollapsed() ? expandIcon : collapseIcon" [size]="14" aria-hidden="true"></svg>
          </button>
        }
      </div>
    }

    <div
      role="tree"
      aria-labelledby="issue-subtasks-heading"
      class="-mx-1 flex min-w-0 flex-col"
      (keydown)="onKeydown($event)"
    >
      @for (row of rows(); track rowKey(row)) {
        @if (row.kind === 'node') {
          @let n = row.node;
          @let c = n.task;
          <div
            role="treeitem"
            class="group hover:bg-hover focus-visible:ring-ring flex min-h-8 min-w-0 items-center gap-1 rounded-md pr-1 text-[13px] outline-none focus-visible:ring-2"
            [style.padding-left.px]="4 + n.depth * 16"
            [attr.data-id]="c.id"
            [attr.aria-level]="n.depth + 1"
            [attr.aria-expanded]="n.children.length ? !isCollapsed(c.id) : null"
            [attr.tabindex]="tabbable(c.id) ? 0 : -1"
            (focus)="active.set(c.id)"
            (dblclick)="openChild(c, $event)"
          >
            @if (n.children.length) {
              <button
                type="button"
                tabindex="-1"
                class="text-muted-foreground hover:text-foreground inline-flex size-5 shrink-0 items-center justify-center rounded-sm"
                [attr.aria-label]="(isCollapsed(c.id) ? 'Expand ' : 'Collapse ') + c.key"
                (click)="toggle(c.id)"
              >
                <svg
                  [lucideIcon]="chevron"
                  [size]="13"
                  class="transition-transform motion-reduce:transition-none"
                  [class.rotate-90]="!isCollapsed(c.id)"
                  aria-hidden="true"
                ></svg>
              </button>
            } @else {
              <span class="inline-block size-5 shrink-0" aria-hidden="true"></span>
            }
            <app-issue-prop [issue]="c" field="status" />
            <span class="text-muted-foreground shrink-0 font-mono text-[11px]">{{ c.key }}</span>
            <a
              [routerLink]="['/', slug(), 'tasks', c.key]"
              tabindex="-1"
              class="min-w-0 flex-1 truncate rounded-sm outline-none hover:underline"
              [class.text-muted-foreground]="closed(c)"
              >{{ c.title }}</a
            >
            @if (n.children.length) {
              <span
                class="text-muted-foreground flex shrink-0 items-center gap-1.5 text-[11px] tabular-nums"
                [hlmTooltip]="rollupTip(n)"
              >
                {{ n.descendantsDone }}/{{ n.descendants }}
                <span class="bg-foreground/10 h-1 w-7 overflow-hidden rounded-full max-sm:hidden" aria-hidden="true">
                  <span
                    class="bg-status-shipped block h-full rounded-full"
                    [style.width.%]="pct(n.descendantsDone, n.descendants)"
                  ></span>
                </span>
              </span>
            }
            @if (canCreate()) {
              <button
                type="button"
                tabindex="-1"
                class="text-muted-foreground hover:bg-accent hover:text-foreground inline-flex size-6 shrink-0 items-center justify-center rounded-md opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 max-md:opacity-100"
                [attr.aria-label]="'Add subtask to ' + c.key"
                hlmTooltip="Add subtask"
                (click)="startAdd(c.id)"
              >
                <svg [lucideIcon]="plusIcon" [size]="13" aria-hidden="true"></svg>
              </button>
            }
            <app-issue-prop [issue]="c" field="assignee" [avatarSize]="16" />
          </div>
        } @else {
          <div
            class="flex min-h-8 items-center gap-1.5 pr-1"
            role="none"
            [style.padding-left.px]="4 + row.depth * 16 + 20"
          >
            <span class="text-muted-foreground inline-flex size-6 shrink-0 items-center justify-center">
              <svg [lucideIcon]="draftIcon" [size]="14" aria-hidden="true"></svg>
            </span>
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

    @if (canCreate() && addingTo() !== issue().id) {
      <button
        type="button"
        class="text-muted-foreground hover:bg-hover hover:text-foreground focus-visible:ring-ring -mx-1 flex h-8 w-[calc(100%+0.5rem)] items-center gap-1.5 rounded-md px-1 text-left text-[13px] outline-none focus-visible:ring-2"
        [class.mt-0.5]="tree().total"
        [attr.aria-label]="'Add subtask to ' + issue().key"
        (click)="startAdd(issue().id)"
      >
        <span class="inline-flex size-6 shrink-0 items-center justify-center">
          <svg [lucideIcon]="plusIcon" [size]="14" aria-hidden="true"></svg>
        </span>
        Add subtask
      </button>
    }
  `,
})
export class IssueSubtasks {
  private readonly store = inject(TramaStore);
  private readonly router = inject(Router);
  private readonly children = inject(TaskChildren);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly issue = input.required<Issue>();

  protected readonly chevron = LucideChevronRight;
  protected readonly plusIcon = LucidePlus;
  protected readonly draftIcon = LucideCircleDashed;
  protected readonly collapseIcon = LucideChevronsDownUp;
  protected readonly expandIcon = LucideChevronsUpDown;

  protected readonly slug = computed(() => this.store.slug() ?? '');
  protected readonly canCreate = computed(() => this.store.allowed('createIssues'));
  private readonly entries = computed(() => this.store.settings().statuses.issue);

  protected readonly tree = computed(() =>
    buildSubtree(this.issue().id, this.children.byParent(), (t) => isClosedIssue(t, this.entries())),
  );
  protected readonly progress = computed(() => percent(this.tree().done, this.tree().total));
  protected readonly expandable = computed(() => expandableIds(this.tree()));

  /** Tasks the reader folded. Everything starts open. */
  private readonly collapsed = signal<ReadonlySet<string>>(new Set());
  protected readonly allCollapsed = computed(() => {
    const ids = this.expandable();
    return ids.length > 0 && ids.every((id) => this.collapsed().has(id));
  });

  /** The task a new subtask is being typed under (the page's own task for the top level). */
  protected readonly addingTo = signal<string | null>(null);
  protected readonly draft = signal('');
  private readonly busy = signal(false);
  private readonly field = viewChild<ElementRef<HTMLInputElement>>('field');

  protected readonly rows = computed<SubtreeRow<Issue>[]>(() =>
    buildRows(this.issue().id, this.tree().roots, this.collapsed(), this.addingTo()),
  );
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
        this.collapsed.set(new Set());
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

  protected pct(done: number, total: number): number {
    return percent(done, total);
  }

  protected rollupTip(n: SubtreeNode<Issue>): string {
    const direct = n.children.length;
    const open = n.descendants - n.descendantsDone;
    return `${direct} direct ${direct === 1 ? 'subtask' : 'subtasks'}, ${n.descendants} in all · ${n.descendantsDone} finished, ${open} open`;
  }

  protected isCollapsed(id: string): boolean {
    return this.collapsed().has(id);
  }

  protected toggle(id: string, open?: boolean): void {
    this.collapsed.update((set) => {
      const next = new Set(set);
      const shouldOpen = open ?? next.has(id);
      if (shouldOpen) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  protected toggleAll(): void {
    this.collapsed.set(this.allCollapsed() ? new Set() : new Set(this.expandable()));
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
        if (!node.children.length) return;
        if (this.isCollapsed(id)) this.toggle(id, true);
        else this.focusRow(node.children[0].task.id);
        break;
      case 'ArrowLeft':
        if (node.children.length && !this.isCollapsed(id)) this.toggle(id, false);
        else if (node.task.parentId && node.task.parentId !== this.issue().id) this.focusRow(node.task.parentId);
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
    if (parentId !== this.issue().id) this.toggle(parentId, true);
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
