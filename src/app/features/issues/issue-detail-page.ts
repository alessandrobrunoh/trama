// The task page: the task's story as a conversation (description, comments, events) with the composer docked
// at the bottom, and the property column (`TaskInspector`) beside it; the people, the status, the thread link and
// the actions sit in the top bar.
import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import {
  LucideChevronDown,
  LucideChevronRight,
  LucideChevronUp,
  LucideCopy,
  LucideDynamicIcon,
  LucideEllipsis,
  LucideGitBranch,
  LucideLink,
  LucidePanelRight,
  LucideSparkles,
  LucideTrash2,
  LucideX,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import {
  TramaStore,
  Viewport,
  isTypingTarget,
  usePageShortcuts,
  type ActorRef,
  type Issue,
} from '../../core';
import { StatusBar } from '../../layout/status-bar';
import { PageChrome, TopBarActions, usePageCrumbs, type PageTitle } from '../../layout/page-chrome';
import { CommentComposer } from '../../shared/comments';
import { EmptyState } from '../../shared/empty-state';
import { EntityChip } from '../../shared/entity-chip';
import { IssueKindLabel } from '../../shared/issue';
import { Kbd } from '../../shared/kbd';
import { RelativeTimePipe } from '../../shared/pipes';
import { AiActions } from '../ai-actions/ai-actions.service';
import { IssueActions, type IssuePromptField } from './issue-actions';
import { IssueStream, IssueTitle } from './issue-detail-parts';
import { SOURCE_LABEL, isClosedIssue } from './issue-model';
import { IssueCommandDialog, IssueProp } from './issue-prop';
import { IssueThreadLink } from './issue-thread-link';
import { ProjectGlyph } from '../projects/project-glyph';
import { TaskInspector } from './task-inspector';
import { TaskChildren } from './task-children';
import { TaskStatusWizard } from './task-status-wizard';
import { buildSubtree, percent } from './task-subtree-model';

@Component({
  selector: 'app-issue-detail-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    HlmButtonImports,
    HlmDropdownMenuImports,
    HlmTooltip,
    LucideDynamicIcon,
    TopBarActions,
    StatusBar,
    CommentComposer,
    EmptyState,
    EntityChip,
    IssueKindLabel,
    Kbd,
    RelativeTimePipe,
    IssueProp,
    IssueTitle,
    IssueStream,
    IssueCommandDialog,
    IssueThreadLink,
    ProjectGlyph,
    TaskInspector,
    TaskStatusWizard,
  ],
  host: { class: 'flex h-full min-h-0 flex-col' },
  template: `
    @if (issue(); as i) {
      <ng-template appTopBarActions>
        @if (nav().total > 1) {
          <span class="text-muted-foreground mr-1 text-xs tabular-nums max-md:hidden"
            >{{ nav().index + 1 }} / {{ nav().total }}</span
          >
          <button
            hlmBtn
            variant="ghost"
            size="icon-sm"
            class="text-muted-foreground max-md:hidden"
            aria-label="Previous task"
            hlmTooltip="Previous task · K"
            [disabled]="!nav().prev"
            (click)="go(nav().prev)"
          >
            <svg [lucideIcon]="upIcon" [size]="15"></svg>
          </button>
          <button
            hlmBtn
            variant="ghost"
            size="icon-sm"
            class="text-muted-foreground max-md:hidden"
            aria-label="Next task"
            hlmTooltip="Next task · J"
            [disabled]="!nav().next"
            (click)="go(nav().next)"
          >
            <svg [lucideIcon]="downIcon" [size]="15"></svg>
          </button>
        }
        <button
          hlmBtn
          variant="ghost"
          size="sm"
          class="text-muted-foreground"
          aria-label="Copy link"
          hlmTooltip="Copy link · ⌘⇧L"
          (click)="actions.copyLinks([i.id])"
        >
          <svg [lucideIcon]="linkIcon" [size]="14"></svg>
          @if (!viewport.isMobile()) {
            <span class="max-xl:hidden">Copy link</span>
          }
        </button>
        <button
          hlmBtn
          variant="ghost"
          size="icon-sm"
          class="text-muted-foreground"
          [hlmDropdownMenuTrigger]="more"
          aria-label="Task actions"
          hlmTooltip="More actions"
        >
          <svg [lucideIcon]="moreIcon" [size]="16"></svg>
        </button>
        <ng-template #more>
          <hlm-dropdown-menu class="w-60">
            <hlm-dropdown-menu-group>
              <button hlmDropdownMenuItem (triggered)="actions.copyKeys([i.id])">
                <svg [lucideIcon]="copyIcon" [size]="14"></svg> Copy key
                <hlm-dropdown-menu-shortcut><app-kbd keys="mod+shift+k" /></hlm-dropdown-menu-shortcut>
              </button>
              <button hlmDropdownMenuItem (triggered)="actions.copyLinks([i.id])">
                <svg [lucideIcon]="linkIcon" [size]="14"></svg> Copy link
                <hlm-dropdown-menu-shortcut
                  ><app-kbd keys="mod+shift+l"
                /></hlm-dropdown-menu-shortcut>
              </button>
              <button hlmDropdownMenuItem (triggered)="actions.copyTitle(i.id)">
                <svg [lucideIcon]="copyIcon" [size]="14"></svg> Copy key and title
              </button>
              <button hlmDropdownMenuItem (triggered)="actions.copyBranch(i.id)">
                <svg [lucideIcon]="branchIcon" [size]="14"></svg> Copy git branch name
                <hlm-dropdown-menu-shortcut
                  ><app-kbd keys="mod+shift+g"
                /></hlm-dropdown-menu-shortcut>
              </button>
            </hlm-dropdown-menu-group>
            @if (ai.available()) {
              <hlm-dropdown-menu-separator />
              <hlm-dropdown-menu-group>
                <button hlmDropdownMenuItem (triggered)="ai.request('summarize', i.id)">
                  <svg [lucideIcon]="sparkles" [size]="14" class="text-primary"></svg>
                  Summarize with AI
                </button>
                @if (canEdit()) {
                  <button hlmDropdownMenuItem (triggered)="ai.request('triage', i.id)">
                    <svg [lucideIcon]="sparkles" [size]="14" class="text-primary"></svg>
                    Suggest properties with AI
                  </button>
                  <button hlmDropdownMenuItem (triggered)="ai.request('improve', i.id)">
                    <svg [lucideIcon]="sparkles" [size]="14" class="text-primary"></svg>
                    Improve description with AI
                  </button>
                }
              </hlm-dropdown-menu-group>
            }
            @if (canEdit()) {
              <hlm-dropdown-menu-separator />
              <hlm-dropdown-menu-group>
                @if (i.duplicateOfId) {
                  <button hlmDropdownMenuItem (triggered)="actions.clearDuplicate(i.id)">
                    <svg [lucideIcon]="xIcon" [size]="14"></svg> Not a duplicate
                  </button>
                } @else {
                  <button hlmDropdownMenuItem (triggered)="actions.openPrompt('duplicate', [i.id])">
                    <svg [lucideIcon]="copyIcon" [size]="14"></svg> Mark as duplicate…
                    <hlm-dropdown-menu-shortcut
                      ><app-kbd keys="shift+d"
                    /></hlm-dropdown-menu-shortcut>
                  </button>
                }
              </hlm-dropdown-menu-group>
              @if (store.allowed('deleteIssues')) {
                <hlm-dropdown-menu-separator />
                <button hlmDropdownMenuItem variant="destructive" (triggered)="remove()">
                  <svg [lucideIcon]="trash" [size]="14"></svg> Delete task…
                  <hlm-dropdown-menu-shortcut
                    ><app-kbd keys="mod+backspace"
                  /></hlm-dropdown-menu-shortcut>
                </button>
              }
            }
          </hlm-dropdown-menu>
        </ng-template>
      </ng-template>

      <div class="flex min-h-0 flex-1 max-md:flex-col">
      <div class="flex min-h-0 min-w-0 flex-1 flex-col">
      <app-issue-stream #stream [issue]="i" (quote)="composer()?.quote($event)">
        <header class="flex flex-col gap-2">
          <!-- Where it sits: the chain of parents (any depth), then this task's type and key. -->
          <nav class="text-muted-foreground flex flex-wrap items-center gap-x-1 gap-y-1 text-xs" aria-label="Task path">
            @if (ancestors().hidden) {
              <span aria-hidden="true">…</span>
              <svg [lucideIcon]="crumbIcon" [size]="12" aria-hidden="true"></svg>
            }
            @for (a of ancestors().shown; track a.id) {
              <a
                class="hover:text-foreground focus-visible:ring-ring max-w-[14rem] truncate rounded-sm font-mono outline-none hover:underline focus-visible:ring-2"
                [routerLink]="['/', slug(), 'tasks', a.key]"
                [attr.title]="a.title"
                >{{ a.key }}</a
              >
              <svg [lucideIcon]="crumbIcon" [size]="12" aria-hidden="true"></svg>
            }
            <app-issue-kind [kind]="i.kind" showLabel />
            <span aria-hidden="true">·</span>
            <span class="font-mono">{{ i.key }}</span>
            @if (i.source !== 'manual') {
              <span aria-hidden="true">·</span>
              <span>via {{ sourceLabel() }}</span>
            }
          </nav>
          @if (duplicate(); as dup) {
            <div class="bg-muted flex flex-wrap items-center gap-2 rounded-lg px-3 py-2 text-[13px]">
              <span class="text-muted-foreground">Duplicate of</span>
              <app-entity-chip type="issue" [ref]="dup.id" />
              @if (canEdit()) {
                <button
                  hlmBtn
                  variant="ghost"
                  size="sm"
                  class="text-muted-foreground ml-auto h-6 px-2 text-xs"
                  (click)="actions.clearDuplicate(i.id)"
                >
                  Not a duplicate
                </button>
              }
            </div>
          }
          <app-issue-title
            #title
            [value]="i.title"
            [canEdit]="canEdit()"
            (save)="store.updateIssue(i.id, { title: $event })"
          />
          <!-- The key properties, editable in place; everything else is in the property column. -->
          <div class="-ml-1.5 flex flex-wrap items-center gap-x-0.5 gap-y-1" role="group" aria-label="Properties">
            <app-issue-prop [issue]="i" field="status" showLabel />
            <app-issue-prop [issue]="i" field="priority" showLabel />
            <app-issue-prop [issue]="i" field="assignee" showLabel />
            @if (project(); as p) {
              <a
                class="hover:bg-accent focus-visible:ring-ring inline-flex h-7 max-w-[12rem] min-w-0 items-center gap-1.5 rounded-md px-1.5 text-[13px] outline-none focus-visible:ring-2"
                [routerLink]="['/', slug(), 'projects', p.id]"
                [attr.title]="'Project · ' + p.name"
              >
                <app-project-glyph [project]="p" [size]="13" />
                <span class="truncate">{{ p.name }}</span>
              </a>
            }
            @if (canEdit()) {
              <app-task-status-wizard [issue]="i" />
            }
            <app-issue-thread-link variant="action" [issue]="i" [canEdit]="canEdit()" />
            <button
              hlmBtn
              variant="ghost"
              size="sm"
              class="text-muted-foreground md:hidden"
              aria-controls="task-details"
              [attr.aria-expanded]="details()"
              (click)="details.set(!details())"
            >
              <svg [lucideIcon]="panelIcon" [size]="14"></svg> All details
            </button>
          </div>
          @if (subtasks().total) {
            <div class="flex max-w-xs items-center gap-2 text-xs">
              <span class="text-muted-foreground tabular-nums">{{ subtasks().done }}/{{ subtasks().total }} subtasks</span>
              <span class="bg-foreground/10 h-1 flex-1 overflow-hidden rounded-full" aria-hidden="true">
                <span class="bg-status-shipped block h-full rounded-full" [style.width.%]="subtasks().percent"></span>
              </span>
            </div>
          }
        </header>
      </app-issue-stream>

      @if (canEdit()) {
        <!-- Phones scroll the whole page (see styles.css), so the composer sticks to the bottom instead. -->
        <div class="bg-background shrink-0 px-4 pt-1 pb-3 max-md:sticky max-md:bottom-0 max-md:z-[5] sm:px-8">
          <app-comment-composer
            #composer
            dock
            class="mx-auto max-w-3xl"
            placeholder="Leave a comment…"
            [draftKey]="'comment:issue:' + i.id"
            (submitted)="send($event, composer)"
          >
            <app-issue-prop [issue]="i" field="status" />
            <app-issue-prop [issue]="i" field="priority" />
            <app-issue-prop [issue]="i" field="assignee" />
          </app-comment-composer>
        </div>
      }
      </div>
      @if (!viewport.isMobile() || details()) {
        <aside
          id="task-details"
          class="border-border shrink-0 overflow-y-auto max-md:border-t md:w-[320px] md:border-l"
          aria-label="Task details"
        >
          <app-task-inspector [idOrKey]="i.id" />
        </aside>
      }
      </div>

      <app-status-bar>
        <span class="font-mono">{{ i.key }}</span>
        @if (projectName(); as p) {
          <span>{{ p }}</span>
        }
        <span>{{ commentCount() }} {{ commentCount() === 1 ? 'comment' : 'comments' }}</span>
        @if (subtasks().total) {
          <span>Subtasks {{ subtasks().done }}/{{ subtasks().total }}</span>
        }
        <span end>Updated {{ i.updatedAt | relativeTime }}</span>
      </app-status-bar>

      <app-issue-command-dialog />
    } @else if (store.ready()) {
      <app-empty-state
        title="Task not found"
        [description]="
          'There is no task ' + (key() ?? '') + '. It may have been deleted, or the link is wrong.'
        "
      >
        <a hlmBtn size="sm" variant="outline" [routerLink]="['/', slug(), 'tasks']">Back to tasks</a>
      </app-empty-state>
    }
  `,
})
export class IssueDetailPage {
  private readonly router = inject(Router);
  private readonly document = inject(DOCUMENT);
  private readonly chrome = inject(PageChrome);
  protected readonly viewport = inject(Viewport);
  /** Phones: whether the property column is shown below the conversation. */
  protected readonly details = signal(false);
  protected readonly store = inject(TramaStore);
  protected readonly actions = inject(IssueActions);
  protected readonly ai = inject(AiActions);
  private readonly children = inject(TaskChildren);

  /** From the parent `:workspaceSlug` route segment. */
  readonly workspaceSlug = input<string>();
  /** Route param: project-based issue key (`CORA-142`) or id. */
  readonly key = input<string>();

  private readonly titleEditor = viewChild<IssueTitle>('title');
  private readonly stream = viewChild<IssueStream>('stream');
  protected readonly composer = viewChild<CommentComposer>('composer');

  protected readonly slug = computed(() => this.store.slug() ?? this.workspaceSlug() ?? '');
  protected readonly canEdit = computed(() => this.store.can('member'));
  protected readonly issue = computed(() => this.store.getIssue(this.key()));
  /** The parents of the task, oldest first (a subtask can sit under a subtask to any depth); long chains keep the nearest. */
  protected readonly ancestors = computed(() => {
    const chain: Issue[] = [];
    const seen = new Set<string>();
    let at = this.issue();
    while (at?.parentId && !seen.has(at.parentId)) {
      seen.add(at.parentId);
      const parent = this.store.issueById().get(at.parentId);
      if (!parent) break;
      chain.unshift(parent);
      at = parent;
    }
    return { shown: chain.slice(-3), hidden: chain.length > 3 };
  });
  protected readonly project = computed(() => this.store.getProject(this.issue()?.projectId));
  protected readonly duplicate = computed(() => {
    const id = this.issue()?.duplicateOfId;
    return id ? this.store.issueById().get(id) : undefined;
  });
  protected readonly sourceLabel = computed(() => SOURCE_LABEL[this.issue()?.source ?? ''] ?? '');
  protected readonly projectName = computed(() => this.store.getProject(this.issue()?.projectId)?.name);
  protected readonly commentCount = computed(() => {
    const id = this.issue()?.id;
    return id ? this.store.commentCountFor({ type: 'issue', id }) : 0;
  });
  /** Everything below the task, at any depth. */
  protected readonly subtasks = computed(() => {
    const id = this.issue()?.id;
    if (!id) return { total: 0, done: 0, percent: 0 };
    const entries = this.store.settings().statuses.issue;
    const tree = buildSubtree(id, this.children.byParent(), (t) => isClosedIssue(t, entries));
    return { total: tree.total, done: tree.done, percent: percent(tree.done, tree.total) };
  });

  /** Assignee, reporter and everyone who commented: the avatar group of the top bar. */
  private readonly people = computed<ActorRef[]>(() => {
    const i = this.issue();
    if (!i) return [];
    const out: ActorRef[] = [];
    const seen = new Set<string>();
    const add = (actor: ActorRef | undefined): void => {
      if (!actor) return;
      const id = `${actor.type}:${actor.id ?? ''}`;
      if (seen.has(id)) return;
      seen.add(id);
      out.push(actor);
    };
    if (i.assigneeId) add({ type: 'user', id: i.assigneeId });
    if (i.reporterId) add({ type: 'user', id: i.reporterId });
    for (const author of this.store.commentAuthorsFor({ type: 'issue', id: i.id })) add(author);
    return out;
  });

  /** Prev / next in the order the issue list last showed (falls back to most recently updated). */
  protected readonly nav = computed(() => {
    const id = this.issue()?.id;
    let order = this.actions.navOrder().filter((x) => this.store.issueById().has(x));
    if (!id || !order.includes(id)) {
      order = [...this.store.issues()]
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
        .map((i) => i.id);
    }
    const index = id ? order.indexOf(id) : -1;
    const keyOf = (n: number) =>
      n >= 0 && n < order.length ? this.store.issueById().get(order[n])?.key : undefined;
    return { index, total: order.length, prev: keyOf(index - 1), next: keyOf(index + 1) };
  });

  protected readonly crumbIcon = LucideChevronRight;
  protected readonly panelIcon = LucidePanelRight;
  protected readonly moreIcon = LucideEllipsis;
  protected readonly trash = LucideTrash2;
  protected readonly copyIcon = LucideCopy;
  protected readonly linkIcon = LucideLink;
  protected readonly sparkles = LucideSparkles;
  protected readonly xIcon = LucideX;
  protected readonly branchIcon = LucideGitBranch;
  protected readonly upIcon = LucideChevronUp;
  protected readonly downIcon = LucideChevronDown;

  /** The key in the URL may be an old key (alias), an id or a different case: show the current key. */
  private readonly _canonicalUrl = effect(() => {
    const issue = this.issue();
    const ref = this.key();
    if (!issue || !ref || ref === issue.key || ref === issue.id) return;
    void this.router.navigate(['/', this.slug(), 'tasks', issue.key], { replaceUrl: true });
  });

  private readonly _crumbs = usePageCrumbs(() => [
    { label: 'Tasks', link: ['/', this.slug(), 'tasks'] },
    { label: this.issue()?.key ?? this.key() ?? '', mono: true },
  ]);

  /** The people behind the task go to the top bar's avatar group (and the title to the phone header). */
  private readonly _page = (() => {
    let mine: PageTitle | null = null;
    effect(() => {
      const i = this.issue();
      this.chrome.page.set(i ? (mine = { title: i.title, actors: this.people() }) : null);
    });
    inject(DestroyRef).onDestroy(() => {
      if (this.chrome.page() === mine) this.chrome.page.set(null);
    });
  })();

  private readonly _keys = usePageShortcuts([
    {
      keys: 's',
      label: 'Change status',
      group: 'Task',
      when: () => this.editable(),
      run: () => this.prompt('status'),
    },
    {
      keys: 'p',
      label: 'Set priority',
      group: 'Task',
      when: () => this.editable(),
      run: () => this.prompt('priority'),
    },
    {
      keys: 'shift+p',
      label: 'Move to project…',
      group: 'Task',
      when: () => this.editable(),
      run: () => this.prompt('project'),
    },
    {
      keys: 'a',
      label: 'Assign to…',
      group: 'Task',
      when: () => this.editable(),
      run: () => this.prompt('assignee'),
    },
    {
      keys: 'i',
      label: 'Assign to me',
      group: 'Task',
      when: () => this.editable(),
      run: () => this.ids().length && this.actions.toggleAssignMe(this.ids()),
    },
    {
      keys: 'l',
      label: 'Add labels',
      group: 'Task',
      when: () => this.editable(),
      run: () => this.prompt('label'),
    },
    {
      keys: 'shift+d',
      label: 'Mark as duplicate',
      group: 'Task',
      when: () => this.editable() && !this.issue()?.duplicateOfId,
      run: () => this.prompt('duplicate'),
    },
    {
      keys: 'r',
      label: 'Rename',
      group: 'Task',
      when: () => this.editable(),
      run: () => this.titleEditor()?.start(),
    },
    {
      keys: 'e',
      label: 'Edit description',
      group: 'Task',
      when: () => this.editable(),
      run: () => this.stream()?.editDescription(),
    },
    {
      keys: 'mod+shift+k',
      label: 'Copy task key',
      group: 'Task',
      run: () => this.actions.copyKeys(this.ids()),
    },
    {
      keys: 'mod+shift+l',
      label: 'Copy task link',
      group: 'Task',
      run: () => this.actions.copyLinks(this.ids()),
    },
    {
      keys: 'mod+shift+g',
      label: 'Copy git branch name',
      group: 'Task',
      run: () => this.copyBranch(),
    },
    {
      keys: 'mod+shift+.',
      label: 'Copy git branch name',
      group: 'Task',
      hidden: true,
      run: () => this.copyBranch(),
    },
    {
      keys: 'mod+shift+>',
      label: 'Copy git branch name',
      group: 'Task',
      hidden: true,
      run: () => this.copyBranch(),
    },
    {
      keys: 'mod+backspace',
      label: 'Delete task',
      group: 'Task',
      when: () => this.editable() && !this.typing(),
      run: () => this.remove(),
    },
    {
      keys: 'j',
      label: 'Next task',
      group: 'Task',
      when: () => !!this.nav().next,
      run: () => this.go(this.nav().next),
    },
    {
      keys: 'k',
      label: 'Previous task',
      group: 'Task',
      when: () => !!this.nav().prev,
      run: () => this.go(this.nav().prev),
    },
    {
      keys: 'alt+down',
      label: 'Next task',
      group: 'Task',
      when: () => !!this.nav().next,
      run: () => this.go(this.nav().next),
    },
    {
      keys: 'alt+up',
      label: 'Previous task',
      group: 'Task',
      when: () => !!this.nav().prev,
      run: () => this.go(this.nav().prev),
    },
  ]);

  private copyBranch(): void {
    const id = this.issue()?.id;
    if (id) this.actions.copyBranch(id);
  }

  private ids(): string[] {
    const id = this.issue()?.id;
    return id ? [id] : [];
  }

  private editable(): boolean {
    return this.canEdit() && !!this.issue();
  }

  private typing(): boolean {
    return isTypingTarget(this.document.activeElement);
  }

  private prompt(field: IssuePromptField): void {
    this.actions.openPrompt(field, this.ids());
  }


  protected go(key: string | undefined): void {
    if (key) void this.router.navigate(['/', this.slug(), 'tasks', key]);
  }

  protected async send(body: string, composer: CommentComposer): Promise<void> {
    const id = this.issue()?.id;
    if (!id) return composer.fail();
    const posted = await this.store.addComment({ type: 'issue', id }, body);
    if (posted) {
      composer.reset();
      this.stream()?.scrollToEnd();
    } else composer.fail();
  }

  protected remove(): void {
    const issue = this.issue();
    if (!issue) return;
    this.actions.remove([issue.id], () => void this.router.navigate(['/', this.slug(), 'tasks']));
  }
}
