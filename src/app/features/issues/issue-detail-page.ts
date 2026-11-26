// The task page (v3 "06 Task detail", "07 Subtask detail", "34 Task detail · Progress"): the title block with its
// description, the Subtasks, the Delta thread record and the Activity in the main column (`IssueStream`), the
// property column (`TaskInspector`) beside it. The timer, Share and Set status sit in the top bar; the crumbs read
// "workspace / project / parent keys / key / title". A subtask opens on a banner that points to its parent.
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
import { LucideCornerUpLeft, LucideDynamicIcon, LucidePanelRight } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import {
  Clipboard,
  TramaStore,
  Viewport,
  isTypingTarget,
  usePageShortcuts,
  type Issue,
} from '../../core';
import { PageChrome, TopBarActions, usePageCrumbs, type Crumb, type PageTitle } from '../../layout/page-chrome';
import { AgoPipe } from '../../shared/ago';
import { CommentComposer } from '../../shared/comments';
import { EmptyState } from '../../shared/empty-state';
import { Kbd } from '../../shared/kbd';
import { V3Source } from '../../shared/v3';
import { IssueActions, type IssuePromptField } from './issue-actions';
import { IssueDescription, IssueTitle } from './issue-detail-parts';
import { IssueStream } from './issue-stream';
import { IssueCommandDialog } from './issue-prop';
import { TaskInspector } from './task-inspector';
import { TaskTimerPill } from './task-timer-pill';

@Component({
  selector: 'app-issue-detail-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    HlmButtonImports,
    LucideDynamicIcon,
    TopBarActions,
    AgoPipe,
    CommentComposer,
    EmptyState,
    Kbd,
    V3Source,
    IssueTitle,
    IssueDescription,
    IssueStream,
    IssueCommandDialog,
    TaskInspector,
    TaskTimerPill,
  ],
  host: { class: 'flex h-full min-h-0 flex-col' },
  template: `
    @if (issue(); as i) {
      <ng-template appTopBarActions>
        <app-task-timer-pill [issueId]="i.id" [taskKey]="i.key" />
        <button hlmBtn variant="outline" type="button" (click)="share()">
          Share <app-kbd keys="shift+s" />
        </button>
        @if (canEdit()) {
          <button hlmBtn variant="outline" type="button" (click)="prompt('status')">
            Set status <app-kbd keys="s" />
          </button>
        }
      </ng-template>

      <div class="flex min-h-0 flex-1 max-md:flex-col">
        <div class="flex min-h-0 min-w-0 flex-1 flex-col">
          <app-issue-stream #feed [issue]="i" (quote)="composer()?.quote($event)">
            <!-- A subtask: where it belongs, and whether the parent has a thread of its own. -->
            @if (parent(); as p) {
              <div class="bg-card border-border flex min-w-0 items-center gap-2.5 border px-3.5 py-2.5">
                <svg [lucideIcon]="parentIcon" [size]="14" class="text-faint shrink-0" aria-hidden="true"></svg>
                <span class="text-faint shrink-0 font-mono text-[10px] leading-[12px] max-sm:hidden">SUBTASK OF</span>
                <a
                  [routerLink]="['/', slug(), 'tasks', p.key]"
                  class="flex min-w-0 items-center gap-2.5 outline-none hover:underline focus-visible:underline"
                >
                  <span class="text-muted-foreground shrink-0 font-mono text-[11px] leading-[14px]">{{ p.key }}</span>
                  <span class="text-foreground truncate text-[13px] leading-4">{{ p.title }}</span>
                </a>
                <span class="flex-1"></span>
                <span
                  class="inline-flex shrink-0 items-center gap-[5px] border px-[7px] py-0.5 font-mono text-[10.5px] leading-[14px] whitespace-nowrap max-sm:hidden"
                  [class]="p.threadUrl ? 'border-delta-line/40 text-delta' : 'border-border text-faint'"
                >
                  <span class="size-1.5 shrink-0" [class]="p.threadUrl ? 'bg-delta-line' : 'bg-faint'" aria-hidden="true"></span>
                  {{ p.threadUrl ? 'parent has its own thread' : 'parent has no thread' }}
                </span>
              </div>
            }

            <header class="flex flex-col gap-3">
              <div class="flex flex-wrap items-center gap-2.5">
                <span class="text-muted-foreground font-mono text-[11.5px] leading-[14px]">{{ i.key }}</span>
                @if (parent() && i.source === 'manual' && !i.externalUrl) {
                  <span class="bg-secondary text-muted-foreground px-[7px] py-0.5 font-mono text-[10.5px] leading-[14px]">Trama-only subtask</span>
                } @else {
                  <v3-source [issue]="i" />
                }
                @if (i.externalRef?.syncedAt; as at) {
                  <span class="text-faint font-mono text-[10.5px] leading-[13px]">synced {{ at | ago }} ago</span>
                }
                <button
                  hlmBtn
                  variant="ghost"
                  type="button"
                  class="-my-1 ml-auto md:hidden"
                  aria-controls="task-details"
                  [attr.aria-expanded]="details()"
                  (click)="details.set(!details())"
                >
                  <svg [lucideIcon]="panelIcon" [size]="14"></svg> All details
                </button>
              </div>
              <app-issue-title
                #title
                [value]="i.title"
                [canEdit]="canEdit()"
                (save)="store.updateIssue(i.id, { title: $event })"
              />
              <app-issue-description
                #desc
                [value]="i.body ?? ''"
                [canEdit]="canEdit()"
                (save)="store.updateIssue(i.id, { body: $event || null })"
              />
            </header>

            @if (canEdit()) {
              <!-- Phones scroll the whole page (see styles.css), so the composer sticks to the bottom instead. -->
              <div composer class="bg-background max-md:sticky max-md:bottom-0 max-md:z-[5] max-md:pt-1 max-md:pb-3">
                <app-comment-composer
                  #composer
                  dock
                  placeholder="Leave a comment…"
                  [draftKey]="'comment:issue:' + i.id"
                  (submitted)="send($event, composer)"
                />
              </div>
            }
          </app-issue-stream>
        </div>
        @if (!viewport.isMobile() || details()) {
          <aside
            id="task-details"
            class="border-border bg-card shrink-0 overflow-y-auto max-md:border-t md:w-[300px] md:border-l"
            aria-label="Task details"
          >
            <app-task-inspector [idOrKey]="i.id" />
          </aside>
        }
      </div>

      <app-issue-command-dialog />
    } @else if (store.ready()) {
      <app-empty-state
        title="Task not found"
        [description]="
          'There is no task ' + (key() ?? '') + '. It may have been deleted, or the link is wrong.'
        "
      >
        <a hlmBtn variant="outline" [routerLink]="['/', slug(), 'tasks']">Back to tasks</a>
      </app-empty-state>
    }
  `,
})
export class IssueDetailPage {
  private readonly router = inject(Router);
  private readonly document = inject(DOCUMENT);
  private readonly chrome = inject(PageChrome);
  private readonly clipboard = inject(Clipboard);
  protected readonly viewport = inject(Viewport);
  /** Phones: whether the property column is shown below the conversation. */
  protected readonly details = signal(false);
  protected readonly store = inject(TramaStore);
  protected readonly actions = inject(IssueActions);

  /** From the parent `:workspaceSlug` route segment. */
  readonly workspaceSlug = input<string>();
  /** Route param: project-based issue key (`CORA-142`) or id. */
  readonly key = input<string>();

  private readonly titleEditor = viewChild<IssueTitle>('title');
  private readonly description = viewChild<IssueDescription>('desc');
  protected readonly stream = viewChild<IssueStream>('feed');
  protected readonly composer = viewChild<CommentComposer>('composer');

  protected readonly slug = computed(() => this.store.slug() ?? this.workspaceSlug() ?? '');
  protected readonly canEdit = computed(() => this.store.can('member'));
  protected readonly issue = computed(() => this.store.getIssue(this.key()));
  /** The parents of the task, oldest first (a subtask can sit under a subtask to any depth); long chains keep the nearest. */
  private readonly ancestors = computed(() => {
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
    return chain;
  });
  /** The direct parent: a task with one is a subtask. */
  protected readonly parent = computed(() => this.ancestors().at(-1));
  protected readonly project = computed(() => this.store.getProject(this.issue()?.projectId));

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

  protected readonly parentIcon = LucideCornerUpLeft;
  protected readonly panelIcon = LucidePanelRight;

  /** The key in the URL may be an old key (alias), an id or a different case: show the current key. */
  private readonly _canonicalUrl = effect(() => {
    const issue = this.issue();
    const ref = this.key();
    if (!issue || !ref || ref === issue.key || ref === issue.id) return;
    void this.router.navigate(['/', this.slug(), 'tasks', issue.key], { replaceUrl: true });
  });

  /** "workspace / Web app / TRM-128 / TRM-128.2 / Title": the project, the parents, the key, then the title. */
  private readonly _crumbs = usePageCrumbs((): readonly Crumb[] => {
    const i = this.issue();
    const out: Crumb[] = [];
    const p = this.project();
    if (p) out.push({ label: p.name, link: ['/', this.slug(), 'projects', p.id] });
    for (const a of this.ancestors().slice(-3)) out.push({ label: a.key, link: ['/', this.slug(), 'tasks', a.key] });
    if (!i) return [...out, { label: this.key() ?? '', mono: true }];
    return [...out, { label: i.key }, { label: i.title }];
  });

  /** The title goes to the phone header. */
  private readonly _page = (() => {
    let mine: PageTitle | null = null;
    effect(() => {
      const i = this.issue();
      this.chrome.page.set(i ? (mine = { title: i.title }) : null);
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
      run: () => this.description()?.start(),
    },
    {
      keys: 'shift+s',
      label: 'Share (copy link)',
      group: 'Task',
      when: () => !!this.issue(),
      run: () => this.share(),
    },
    {
      keys: 'o',
      label: 'Open the Delta thread',
      group: 'Delta',
      when: () => !!this.issue()?.threadUrl,
      run: () => this.openThread(),
    },
    {
      keys: 'shift+l',
      label: 'Copy the Delta thread link',
      group: 'Delta',
      when: () => !!this.issue()?.threadUrl,
      run: () => this.copyThread(),
    },
    {
      keys: 'shift+c',
      label: 'Copy the /trama command',
      group: 'Delta',
      when: () => !!this.issue(),
      run: () => this.copyCommand(),
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

  protected prompt(field: IssuePromptField): void {
    this.actions.openPrompt(field, this.ids());
  }

  /** "Share": the link to this task goes to the clipboard. */
  protected share(): void {
    this.actions.copyLinks(this.ids());
  }

  private openThread(): void {
    const url = this.issue()?.threadUrl;
    if (url) this.document.defaultView?.open(url, '_blank', 'noopener,noreferrer');
  }

  private copyThread(): void {
    const url = this.issue()?.threadUrl;
    if (url) void this.clipboard.copy(url, 'Thread link copied');
  }

  private copyCommand(): void {
    const key = this.issue()?.key;
    if (key) void this.clipboard.copy(`/trama ${key}`, 'Command copied');
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
