// The main column of the task page (v3 "06 Task detail" / "07 Subtask detail"): whatever the page projects first
// (the parent banner, the title block with its description), then the AI cards, the Subtasks, the Delta thread
// record, the other subtasks of the parent, the Activity (comments) with a folded task history, and the composer
// the page projects last. The component is the scroller.
import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { LucideChevronRight, LucideDynamicIcon } from '@lucide/angular';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import {
  ISSUE_STATUS_META,
  TramaStore,
  fullDate,
  type Issue,
  type IssueStatus,
} from '../../core';
import { AiIssueSection } from '../ai-actions/ai-issue-cards';
import { ActorAvatar } from '../../shared/actor-avatar';
import { CommentItem, CommentsLoader } from '../../shared/comments';
import { RelativeTimePipe } from '../../shared/pipes';
import { StatusIcon } from '../../shared/status';
import { IssueSubtasks } from './issue-subtasks';
import { buildStream, type StreamEvent } from './issue-stream-model';
import { TaskChildren } from './task-children';
import { TaskRecord } from './task-record';
import { TaskSectionHead } from './task-section-head';

@Component({
  selector: 'app-issue-stream',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ActorAvatar,
    AiIssueSection,
    CommentItem,
    CommentsLoader,
    HlmTooltip,
    IssueSubtasks,
    LucideDynamicIcon,
    NgTemplateOutlet,
    RelativeTimePipe,
    StatusIcon,
    TaskRecord,
    TaskSectionHead,
  ],
  host: { class: 'relative flex min-h-0 flex-1' },
  template: `
    <div
      #scroller
      class="focus-visible:ring-ring/40 min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain scroll-smooth px-4 py-5 outline-none focus-visible:ring-2 focus-visible:ring-inset motion-reduce:scroll-auto max-md:overflow-visible md:px-11 md:py-8"
      tabindex="0"
      role="region"
      aria-label="Task conversation"
    >
      <div class="mx-auto flex w-full max-w-[860px] flex-col gap-7">
        <ng-content />

        <app-ai-issue-section [issue]="issue()" [showActions]="false" />

        @if (showSubtasks()) {
          <app-issue-subtasks #subtasks [issue]="issue()" />
        }

        <app-task-record [issue]="issue()" [canEdit]="canEdit()" (newSubtask)="addSubtask()" />

        @if (parentIssue(); as p) {
          @if (hasSiblings()) {
            <app-issue-subtasks flat [issue]="p" [exclude]="issue().id" [title]="'Other subtasks of ' + p.key" />
          }
        }

        <section class="flex min-w-0 flex-col gap-3.5" aria-label="Activity">
          <app-task-section-head title="Activity" [caption]="activityCaption()" />
          <app-comments-loader [subject]="subject()" />
          @for (c of comments(); track c.id) {
            <app-comment-item [comment]="c" quotable (quote)="quote.emit($event)" />
          } @empty {
            <p class="text-faint font-mono text-[11px]">No comments yet.</p>
          }

          @if (events().length) {
            <div class="flex flex-col gap-1">
              <button
                type="button"
                class="text-faint hover:text-muted-foreground focus-visible:ring-ring flex w-fit items-center gap-1.5 font-mono text-[10.5px] outline-none focus-visible:ring-2"
                [attr.aria-expanded]="history()"
                (click)="history.set(!history())"
              >
                <svg
                  [lucideIcon]="chevron"
                  [size]="12"
                  class="shrink-0 transition-transform"
                  [class.rotate-90]="history()"
                  aria-hidden="true"
                ></svg>
                Task history · {{ events().length }} {{ events().length === 1 ? 'change' : 'changes' }}
              </button>
              @if (history()) {
                <ul class="flex flex-col gap-0.5 pl-1">
                  @for (e of events(); track e.id) {
                    <li class="flex min-w-0 gap-2.5">
                      <span class="flex w-4 shrink-0 justify-center pt-1">
                        <app-actor-avatar [actor]="e.ev.actor" [size]="16" />
                      </span>
                      <ng-container [ngTemplateOutlet]="detail" [ngTemplateOutletContext]="{ $implicit: e }" />
                    </li>
                  }
                </ul>
              }
            </div>
          }

          <!-- The frame keeps the comment box inside Activity, one section gap under the last entry. -->
          <ng-content select="[composer]" />
        </section>
      </div>
    </div>

    <ng-template #detail let-e>
      <div class="text-muted-foreground flex min-h-6 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
        <span class="text-foreground">{{ store.actorName(e.ev.actor) }}</span>
        <span>{{ e.view.verb }}</span>
        @if (e.view.from) {
          <span class="inline-flex items-center gap-1"
            ><app-status-icon [status]="e.view.from" entity="issue" [size]="12" />{{ statusLabel(e.view.from) }}</span
          >
          <span aria-hidden="true">→</span>
        }
        @if (e.view.to) {
          <span class="text-foreground inline-flex items-center gap-1"
            ><app-status-icon [status]="e.view.to" entity="issue" [size]="12" />{{ statusLabel(e.view.to) }}</span
          >
        }
        <span aria-hidden="true">·</span>
        <time [attr.datetime]="e.at" [hlmTooltip]="full(e.at)">{{ e.at | relativeTime }}</time>
      </div>
    </ng-template>
  `,
})
export class IssueStream {
  protected readonly store = inject(TramaStore);
  private readonly children = inject(TaskChildren);
  private readonly injector = inject(Injector);

  readonly issue = input.required<Issue>();
  /** A "Quote reply" was chosen on a comment: the page puts the text in the composer. */
  readonly quote = output<string>();

  protected readonly chevron = LucideChevronRight;
  protected readonly history = signal(false);

  private readonly scroller = viewChild.required<ElementRef<HTMLElement>>('scroller');
  private readonly subtasks = viewChild<IssueSubtasks>('subtasks');

  protected readonly canEdit = computed(() => this.store.can('member'));
  protected readonly hasChildren = computed(() => this.children.of(this.issue().id).length > 0);
  /**
   * The Subtasks section: always on a top-level task someone may add to, and on a subtask only once it has its
   * own (the frame of a subtask has none).
   */
  protected readonly showSubtasks = computed(
    () =>
      this.hasChildren() ||
      this.forceSubtasks() ||
      (!this.issue().parentId && this.store.allowed('createIssues')),
  );
  protected readonly subject = computed(() => ({ type: 'issue' as const, id: this.issue().id }));

  protected readonly parentIssue = computed(() => {
    const id = this.issue().parentId;
    return id ? this.store.issueById().get(id) : undefined;
  });
  protected readonly hasSiblings = computed(() => {
    const p = this.parentIssue();
    return !!p && this.children.of(p.id).some((c) => c.id !== this.issue().id);
  });

  protected readonly comments = computed(() =>
    [...this.store.commentsFor(this.subject())].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0)),
  );
  /** The task's own events, oldest first (the history under the activity). */
  protected readonly events = computed<StreamEvent[]>(() =>
    buildStream(this.store.eventsBySubject().get(`issue:${this.issue().id}`) ?? [], []).flatMap((e) =>
      e.kind === 'events' ? e.events : [],
    ),
  );
  protected readonly activityCaption = computed(() => {
    const i = this.issue();
    const synced = i.source === 'github' ? 'GitHub' : i.source === 'gitlab' ? 'GitLab' : '';
    return synced ? `comments sync with the ${synced} issue` : 'comments live in Trama';
  });

  constructor() {
    // A new task: start at the top.
    let last: string | undefined;
    effect(() => {
      const id = this.issue().id;
      if (last !== undefined && last !== id) {
        this.scroller().nativeElement.scrollTo({ top: 0, behavior: 'instant' });
        this.history.set(false);
        this.forceSubtasks.set(false);
        this.pendingAdd.set(false);
      }
      last = id;
    });
    effect(() => {
      const section = this.subtasks();
      if (section && this.pendingAdd()) {
        this.pendingAdd.set(false);
        section.addSubtask();
      }
    });
  }

  /** Opens the new-subtask input of the Subtasks section (the "New subtask" of the thread record, the menu). */
  addSubtask(): void {
    const section = this.subtasks();
    if (section) {
      section.addSubtask();
      return;
    }
    // A subtask without children has no section yet: show it, then open the input once it is there.
    this.forceSubtasks.set(true);
    this.pendingAdd.set(true);
  }
  private readonly forceSubtasks = signal(false);
  private readonly pendingAdd = signal(false);

  /** Scrolls to the newest entry once it is rendered (after posting a comment). */
  scrollToEnd(): void {
    afterNextRender(
      () => {
        const el = this.scroller().nativeElement;
        el.scrollTo({ top: el.scrollHeight });
        // Phones scroll the whole page instead of the stream.
        const page = el.ownerDocument.getElementById('main-content');
        if (el.scrollHeight <= el.clientHeight) page?.scrollTo({ top: page.scrollHeight });
      },
      { injector: this.injector },
    );
  }

  protected statusLabel(s: IssueStatus): string {
    return ISSUE_STATUS_META[s].label;
  }

  protected full(iso: string): string {
    return fullDate(iso);
  }
}
