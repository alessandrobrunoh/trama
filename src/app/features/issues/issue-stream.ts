// The main column of the task page (v3 "06 Task detail" / "07 Subtask detail"): whatever the page projects first
// (the parent banner, the title block with its description), then the AI cards, the Subtasks, the Delta thread
// record, the other subtasks of the parent, the Activity (comments), and the composer the page projects last.
// The component is the scroller.
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
  viewChild,
} from '@angular/core';
import { TramaStore, type Issue } from '../../core';
import { AiIssueSection } from '../ai-actions/ai-issue-cards';
import { CommentItem, CommentsLoader } from '../../shared/comments';
import { IssueSubtasks } from './issue-subtasks';
import { TaskChildren } from './task-children';
import { TaskRecord } from './task-record';
import { TaskSectionHead } from './task-section-head';

@Component({
  selector: 'app-issue-stream',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AiIssueSection, CommentItem, CommentsLoader, IssueSubtasks, TaskRecord, TaskSectionHead],
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
          <app-issue-subtasks [issue]="issue()" />
        }

        <app-task-record [issue]="issue()" />

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

          <!-- The frame keeps the comment box inside Activity, one section gap under the last entry. -->
          <ng-content select="[composer]" />
        </section>
      </div>
    </div>
  `,
})
export class IssueStream {
  protected readonly store = inject(TramaStore);
  private readonly children = inject(TaskChildren);
  private readonly injector = inject(Injector);

  readonly issue = input.required<Issue>();
  /** A "Quote reply" was chosen on a comment: the page puts the text in the composer. */
  readonly quote = output<string>();

  private readonly scroller = viewChild.required<ElementRef<HTMLElement>>('scroller');

  protected readonly hasChildren = computed(() => this.children.of(this.issue().id).length > 0);
  /**
   * The Subtasks section: always on a top-level task someone may add to, and on a subtask only once it has its
   * own (the frame of a subtask has none).
   */
  protected readonly showSubtasks = computed(
    () => this.hasChildren() || (!this.issue().parentId && this.store.allowed('createIssues')),
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
      }
      last = id;
    });
  }

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
}
