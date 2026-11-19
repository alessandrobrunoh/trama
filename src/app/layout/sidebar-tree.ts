import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import {
  LucideChevronRight,
  LucideDynamicIcon,
  LucideFolder,
  LucideFolderOpen,
} from '@lucide/angular';
import { HlmSidebarService } from '@spartan-ng/helm/sidebar';
import { statusTypeOf, type Issue, type Project } from '../core/contracts/domain';
import { NotificationsStore } from '../core/stores/notifications.store';
import { TramaStore } from '../core/stores/trama.store';
import { UiStore } from '../core/stores/ui.store';
import { isClosedIssue } from '../features/issues/issue-model';
import { StatusIcon } from '../shared/status';

/** Tasks shown per parent before the "N more" row. */
const PAGE = 40;

const OPEN_PREFIX = 'open:tree:';

/** Sort rank of the semantic status type: what is moving first, parked work last. */
const TYPE_RANK: Record<string, number> = {
  in_review: 0,
  in_progress: 1,
  todo: 2,
  backlog: 3,
  draft: 4,
};

interface TreeNode {
  /** `project:<id>`, `task:<id>` or `more:<parent id>`. */
  id: string;
  kind: 'project' | 'task' | 'more';
  /** 1 = project, 2 = task, 3 = subtask … */
  level: number;
  label: string;
  link: readonly string[];
  parentId: string | null;
  expandable: boolean;
  expanded: boolean;
  /** Position among its siblings (1-based) and their count, for aria-posinset / aria-setsize. */
  pos: number;
  size: number;
  status?: Issue['status'];
  key?: string;
  /** Blue dot: needs the current user (open attention item, unread notification). */
  needsMe: boolean;
  /** A collapsed row hides a descendant that needs the user. */
  needsMeBelow: boolean;
}

/**
 * The sidebar's Projects tree: project (folder) → open tasks (status glyph) → subtasks.
 * Children are only built for expanded rows (lazy), and the expanded set is remembered per viewer
 * (UiStore.foldedSections, `open:tree:<node id>`). A blue dot marks tasks that need the current user.
 * Keyboard: ↑/↓ move, → expands / enters, ← collapses / goes to the parent, Home/End, Space toggles,
 * Enter opens. Roving tabindex, ARIA `tree` with levels.
 */
@Component({
  selector: 'app-sidebar-tree',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, RouterLinkActive, LucideDynamicIcon, StatusIcon],
  host: { class: 'block' },
  template: `
    <ul
      role="tree"
      aria-label="Projects and tasks"
      class="flex flex-col gap-px"
      (keydown)="onKeydown($event)"
      (focusin)="onFocusIn($event)"
    >
      @for (n of nodes(); track n.id) {
        <li role="none" class="relative">
          <a
            role="treeitem"
            [routerLink]="link(n)"
            routerLinkActive
            #rla="routerLinkActive"
            [routerLinkActiveOptions]="{ paths: n.kind === 'project' ? 'subset' : 'exact', queryParams: 'ignored', fragment: 'ignored', matrixParams: 'ignored' }"
            ariaCurrentWhenActive="page"
            [attr.data-node]="n.id"
            [attr.tabindex]="n.id === tabStop() ? 0 : -1"
            [attr.aria-level]="n.level"
            [attr.aria-expanded]="n.expandable ? n.expanded : null"
            [attr.aria-setsize]="n.size"
            [attr.aria-posinset]="n.pos"
            [attr.aria-selected]="rla.isActive"
            class="text-sidebar-foreground hover:bg-sidebar-accent/60 focus-visible:ring-sidebar-ring flex h-8 w-full items-center gap-1.5 rounded-sm pe-2 text-[13px] outline-hidden focus-visible:ring-2 max-md:h-11 max-md:text-[15px]"
            [class.bg-sidebar-accent]="rla.isActive"
            [style.padding-inline-start.rem]="0.375 + (n.level - 1) * 0.875"
            (click)="onActivate()"
          >
            <span class="size-4 shrink-0" aria-hidden="true"></span>
            @switch (n.kind) {
              @case ('project') {
                <svg
                  [lucideIcon]="n.expanded ? folderOpen : folder"
                  [size]="15"
                  class="text-muted-foreground shrink-0"
                ></svg>
              }
              @case ('task') {
                <app-status-icon entity="issue" [status]="$any(n.status)" [size]="14" />
              }
            }
            <span
              class="truncate-fade min-w-0 flex-1"
              [class.text-muted-foreground]="n.kind === 'more'"
              [class.ms-5]="n.kind === 'more'"
              >{{ n.label }}</span
            >
            @if (n.needsMe || (!n.expanded && n.needsMeBelow)) {
              <span
                class="bg-primary size-1.5 shrink-0 rounded-full"
                [class.opacity-50]="!n.needsMe"
                role="img"
                aria-label="Needs you"
              ></span>
            }
          </a>
          @if (n.expandable) {
            <button
              type="button"
              tabindex="-1"
              aria-hidden="true"
              class="text-muted-foreground hover:text-foreground hover:bg-sidebar-accent absolute top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded-sm max-md:size-8"
              [style.inset-inline-start.rem]="0.375 + (n.level - 1) * 0.875 - 0.125"
              (mousedown)="$event.preventDefault()"
              (click)="toggle(n.id)"
            >
              <svg
                [lucideIcon]="chevron"
                [size]="13"
                class="transition-transform"
                [class.rotate-90]="n.expanded"
              ></svg>
            </button>
          }
        </li>
      } @empty {
        <li role="none" class="text-muted-foreground px-2 py-1 text-xs">No projects yet</li>
      }
    </ul>
  `,
})
export class SidebarTree {
  private readonly store = inject(TramaStore);
  private readonly ui = inject(UiStore);
  private readonly notifications = inject(NotificationsStore);
  private readonly sidebar = inject(HlmSidebarService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected readonly chevron = LucideChevronRight;
  protected readonly folder = LucideFolder;
  protected readonly folderOpen = LucideFolderOpen;

  private readonly slug = computed(() => this.store.slug() ?? '');
  private readonly focused = signal<string | null>(null);

  /** Open (not done / canceled) tasks, by what they hang under. */
  private readonly open = computed(() => {
    const entries = this.store.settings().statuses.issue;
    return this.store.issues().filter((i) => !isClosedIssue(i, entries));
  });

  private readonly rank = computed(() => {
    const entries = this.store.settings().statuses.issue;
    const rank = new Map<string, number>();
    for (const i of this.store.issues())
      rank.set(i.id, TYPE_RANK[statusTypeOf(entries, i.status) ?? i.status] ?? 5);
    return rank;
  });

  /** Keys of the tasks that need the current user: open attention items and unread notifications. */
  private readonly needsMeIds = computed(() => {
    const ids = new Set<string>();
    for (const a of this.store.openAttention()) if (a.issueId) ids.add(a.issueId);
    for (const n of this.notifications.items()) {
      if (n.readAt) continue;
      const m = /^(?:tasks|issues)\/([^/?#]+)/.exec(n.link);
      const issue = m ? this.store.getIssue(decodeURIComponent(m[1])) : undefined;
      if (issue) ids.add(issue.id);
    }
    return ids;
  });

  /** Open tasks grouped by parent task, and root tasks by project (a subtask of a closed or foreign parent counts as a root). */
  private readonly structure = computed(() => {
    const open = this.open();
    const byId = new Map(open.map((i) => [i.id, i]));
    const rank = this.rank();
    const children = new Map<string, Issue[]>();
    const roots = new Map<string, Issue[]>();
    for (const i of open) {
      const parent = i.parentId ? byId.get(i.parentId) : undefined;
      if (parent && parent.projectId === i.projectId) {
        (children.get(parent.id) ?? children.set(parent.id, []).get(parent.id)!).push(i);
      } else if (i.projectId) {
        (roots.get(i.projectId) ?? roots.set(i.projectId, []).get(i.projectId)!).push(i);
      }
    }
    const needs = this.needsMeIds();
    const sort = (a: Issue, b: Issue): number =>
      Number(needs.has(b.id)) - Number(needs.has(a.id)) ||
      (rank.get(a.id) ?? 5) - (rank.get(b.id) ?? 5) ||
      b.number - a.number;
    for (const list of children.values()) list.sort(sort);
    for (const list of roots.values()) list.sort(sort);
    return { children, roots };
  });

  /** A task or a project has a descendant that needs the user. */
  private readonly needsMeBelow = computed(() => {
    const { children, roots } = this.structure();
    const needs = this.needsMeIds();
    const memo = new Map<string, boolean>();
    const below = (issue: Issue): boolean => {
      const hit = memo.get(issue.id);
      if (hit !== undefined) return hit;
      memo.set(issue.id, false);
      const value = (children.get(issue.id) ?? []).some((c) => needs.has(c.id) || below(c));
      memo.set(issue.id, value);
      return value;
    };
    const out = new Set<string>();
    for (const [projectId, list] of roots)
      if (list.some((i) => needs.has(i.id) || below(i))) out.add(`project:${projectId}`);
    for (const list of children.values())
      for (const i of list) if (below(i)) out.add(`task:${i.id}`);
    for (const list of roots.values())
      for (const i of list) if (below(i)) out.add(`task:${i.id}`);
    return out;
  });

  private readonly expandedIds = computed(() => {
    const set = new Set<string>();
    for (const id of this.ui.foldedSections())
      if (id.startsWith(OPEN_PREFIX)) set.add(id.slice(OPEN_PREFIX.length));
    return set;
  });

  protected readonly projects = computed<readonly Project[]>(() =>
    this.store
      .projects()
      .filter((p) => p.status !== 'completed' && p.status !== 'canceled')
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name)),
  );

  /** The visible rows in order: expanded branches are built, collapsed ones are not. */
  protected readonly nodes = computed<readonly TreeNode[]>(() => {
    const { children, roots } = this.structure();
    const expanded = this.expandedIds();
    const needs = this.needsMeIds();
    const below = this.needsMeBelow();
    const out: TreeNode[] = [];

    const pushTasks = (list: readonly Issue[], level: number, parentId: string, moreLink: readonly string[]): void => {
      const shown = list.slice(0, PAGE);
      shown.forEach((issue, index) => {
        const id = `task:${issue.id}`;
        const kids = children.get(issue.id) ?? [];
        const isOpen = kids.length > 0 && expanded.has(id);
        out.push({
          id,
          kind: 'task',
          level,
          label: issue.title,
          key: issue.key,
          link: ['tasks', issue.key],
          parentId,
          expandable: kids.length > 0,
          expanded: isOpen,
          pos: index + 1,
          size: list.length,
          status: issue.status,
          needsMe: needs.has(issue.id),
          needsMeBelow: below.has(id),
        });
        if (isOpen) pushTasks(kids, level + 1, id, ['tasks', issue.key]);
      });
      if (list.length > shown.length)
        out.push({
          id: `more:${parentId}`,
          kind: 'more',
          level,
          label: `${list.length - shown.length} more…`,
          link: moreLink,
          parentId,
          expandable: false,
          expanded: false,
          pos: shown.length + 1,
          size: list.length,
          needsMe: false,
          needsMeBelow: false,
        });
    };

    const projects = this.projects();
    projects.forEach((p, index) => {
      const id = `project:${p.id}`;
      const tasks = roots.get(p.id) ?? [];
      const isOpen = tasks.length > 0 && expanded.has(id);
      out.push({
        id,
        kind: 'project',
        level: 1,
        label: p.name,
        link: ['projects', p.id],
        parentId: null,
        expandable: tasks.length > 0,
        expanded: isOpen,
        pos: index + 1,
        size: projects.length,
        needsMe: false,
        needsMeBelow: below.has(id),
      });
      if (isOpen) pushTasks(tasks, 2, id, ['projects', p.id]);
    });
    return out;
  });

  /** The one row in the tab order: the last focused, else the first. */
  protected readonly tabStop = computed(() => {
    const nodes = this.nodes();
    const f = this.focused();
    return f && nodes.some((n) => n.id === f) ? f : (nodes[0]?.id ?? null);
  });

  protected link(n: TreeNode): readonly string[] {
    return ['/', this.slug(), ...n.link];
  }

  protected toggle(id: string): void {
    this.ui.toggleFolded(OPEN_PREFIX + id);
  }

  protected onActivate(): void {
    this.sidebar.setOpenMobile(false);
  }

  protected onFocusIn(event: FocusEvent): void {
    const id = (event.target as HTMLElement).closest<HTMLElement>('[role="treeitem"]')?.dataset['node'];
    if (id) this.focused.set(id);
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const el = (event.target as HTMLElement).closest<HTMLElement>('[role="treeitem"]');
    const id = el?.dataset['node'];
    if (!id) return;
    const nodes = this.nodes();
    const index = nodes.findIndex((n) => n.id === id);
    const node = nodes[index];
    if (!node) return;
    let target: TreeNode | undefined;
    switch (event.key) {
      case 'ArrowDown':
        target = nodes[index + 1];
        break;
      case 'ArrowUp':
        target = nodes[index - 1];
        break;
      case 'Home':
        target = nodes[0];
        break;
      case 'End':
        target = nodes[nodes.length - 1];
        break;
      case 'ArrowRight':
        if (node.expandable && !node.expanded) this.toggle(id);
        else if (node.expanded) target = nodes[index + 1];
        break;
      case 'ArrowLeft':
        if (node.expanded) this.toggle(id);
        else target = nodes.find((n) => n.id === node.parentId);
        break;
      case ' ':
        if (node.expandable) this.toggle(id);
        break;
      default:
        return;
    }
    event.preventDefault();
    if (target) this.focusNode(target.id);
  }

  private focusNode(id: string): void {
    this.focused.set(id);
    this.host.nativeElement.querySelector<HTMLElement>(`[data-node="${CSS.escape(id)}"]`)?.focus();
  }
}
