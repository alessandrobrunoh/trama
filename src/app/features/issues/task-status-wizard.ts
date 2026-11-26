// "Check status": a small panel that reads the evidence about a task (subtasks, linked PRs and CI, the timer,
// the last activity, recent comments) with the rules of `task-status-model`, proposes the status the work is
// really in and lets the person apply it with one click or pick another. Nothing is changed until they do.
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import {
  LucideChevronRight,
  LucideDynamicIcon,
  LucideScanSearch,
  LucideTriangleAlert,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmPopoverImports } from '@spartan-ng/helm/popover';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import {
  TimeEntriesStore,
  TramaStore,
  resolveStatusEntry,
  statusTypeOf,
  type Issue,
  type IssueStatus,
} from '../../core';
import { StatusIcon } from '../../shared/status';
import { IssueActions } from './issue-actions';
import { TaskChildren } from './task-children';
import {
  DAY_MS,
  proposeStatus,
  type ArtifactEvidence,
  type Confidence,
  type StatusEvidence,
  type StatusType,
} from './task-status-model';

const CONFIDENCE: Record<Confidence, { label: string; tone: string }> = {
  high: { label: 'High confidence', tone: 'text-status-shipped' },
  medium: { label: 'Medium confidence', tone: 'text-foreground' },
  low: { label: 'Low confidence', tone: 'text-muted-foreground' },
};

const RECENT_TRACK_MS = 3 * DAY_MS;

@Component({
  selector: 'app-task-status-wizard',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButtonImports, HlmPopoverImports, HlmTooltip, LucideDynamicIcon, StatusIcon],
  host: { class: 'inline-flex shrink-0' },
  template: `
    <hlm-popover align="end" sideOffset="6" [state]="state()" (stateChanged)="onState($event)">
      @if (variant() === 'link') {
        <button
          hlmPopoverTrigger
          type="button"
          class="text-faint hover:text-foreground focus-visible:ring-ring inline-flex h-6 items-center gap-1 px-1.5 font-mono text-[10.5px] outline-none focus-visible:ring-2"
          aria-label="Check status"
        >
          <svg [lucideIcon]="scanIcon" [size]="12" aria-hidden="true"></svg> Check
        </button>
      } @else {
        <button
          hlmPopoverTrigger
          hlmBtn
          type="button"
          variant="ghost"
          size="sm"
          class="text-muted-foreground"
          aria-label="Check status"
          hlmTooltip="Check what status the work is really in"
        >
          <svg [lucideIcon]="scanIcon" [size]="14" aria-hidden="true"></svg>
          <span>Check status</span>
        </button>
      }
      <hlm-popover-content *hlmPopoverPortal="let ctx" class="w-[19rem] p-0" (click)="$event.stopPropagation()">
        @let p = proposal();
        <div class="flex flex-col gap-3 p-3.5" role="group" aria-label="Status check">
          <div class="flex items-center justify-between gap-2 text-xs">
            <span class="text-muted-foreground">{{ p.changes ? 'Suggested status' : 'Status check' }}</span>
            <span [class]="confidence().tone">{{ confidence().label }}</span>
          </div>

          <div class="flex items-center gap-2">
            <app-status-icon [status]="proposedId()" entity="issue" [size]="18" />
            <div class="min-w-0">
              <p class="truncate text-[15px] leading-tight">{{ proposedName() }}</p>
              <p class="text-muted-foreground mt-0.5 text-xs">
                {{ p.changes ? 'Now ' + currentName() : 'Looks right as it is' }}
              </p>
            </div>
          </div>

          <ul class="flex flex-col gap-1.5 text-[13px]" aria-label="Why">
            @for (reason of p.reasons; track reason) {
              <li class="flex items-start gap-2">
                <span class="bg-muted-foreground/50 mt-[7px] size-1 shrink-0 rounded-full" aria-hidden="true"></span>
                <span>{{ reason }}</span>
              </li>
            }
          </ul>

          @if (p.warnings.length) {
            <ul class="text-status-blocked flex flex-col gap-1 text-xs" aria-label="Worth knowing">
              @for (w of p.warnings; track w) {
                <li class="flex items-start gap-1.5">
                  <svg [lucideIcon]="warnIcon" [size]="12" class="mt-0.5 shrink-0" aria-hidden="true"></svg>
                  <span>{{ w }}</span>
                </li>
              }
            </ul>
          }

          @if (canEdit()) {
            <div class="flex items-center gap-1.5">
              @if (p.changes) {
                <button hlmBtn size="sm" type="button" (click)="apply(proposedId())">
                  Apply {{ proposedName() }}
                </button>
              }
              <button
                hlmBtn
                size="sm"
                type="button"
                variant="ghost"
                class="text-muted-foreground"
                [attr.aria-expanded]="picking()"
                (click)="picking.set(!picking())"
              >
                {{ p.changes ? 'Pick another' : 'Change status' }}
                <svg
                  [lucideIcon]="chevron"
                  [size]="13"
                  class="transition-transform"
                  [class.rotate-90]="picking()"
                  aria-hidden="true"
                ></svg>
              </button>
              @if (p.changes) {
                <button hlmBtn size="sm" type="button" variant="ghost" class="text-muted-foreground ml-auto" (click)="close()">
                  Keep
                </button>
              }
            </div>
            @if (picking()) {
              <ul class="-mx-1.5 -mb-1 flex flex-col" role="list" aria-label="Statuses">
                @for (entry of options(); track entry.id) {
                  <li>
                    <button
                      type="button"
                      class="hover:bg-hover focus-visible:ring-ring flex h-8 w-full items-center gap-2 rounded-md px-1.5 text-left text-[13px] outline-none focus-visible:ring-2"
                      [attr.aria-current]="entry.id === currentId() ? 'true' : null"
                      (click)="apply(entry.id)"
                    >
                      <app-status-icon [status]="entry.id" entity="issue" [size]="14" />
                      <span class="min-w-0 flex-1 truncate">{{ entry.name }}</span>
                      @if (entry.id === currentId()) {
                        <span class="text-muted-foreground text-xs">Current</span>
                      }
                    </button>
                  </li>
                }
              </ul>
            }
          }
        </div>
      </hlm-popover-content>
    </hlm-popover>
  `,
})
export class TaskStatusWizard {
  private readonly store = inject(TramaStore);
  private readonly actions = inject(IssueActions);
  private readonly time = inject(TimeEntriesStore);
  private readonly children = inject(TaskChildren);

  readonly issue = input.required<Issue>();
  /** `action`: a text button for the top bar. `link`: a quiet "Check" next to the status row. */
  readonly variant = input<'action' | 'link'>('action');

  protected readonly scanIcon = LucideScanSearch;
  protected readonly warnIcon = LucideTriangleAlert;
  protected readonly chevron = LucideChevronRight;

  protected readonly state = signal<'open' | 'closed'>('closed');
  protected readonly picking = signal(false);
  /** Frozen when the panel opens, so the answer does not shift while it is read. */
  private readonly now = signal(Date.now());

  protected readonly canEdit = computed(() => this.store.can('member'));
  private readonly entries = computed(() => this.store.settings().statuses.issue);
  protected readonly options = computed(() => this.entries());
  protected readonly currentId = computed(() => this.issue().status as string);
  private readonly currentType = computed<StatusType>(
    () => (statusTypeOf(this.entries(), this.issue().status) ?? 'todo') as StatusType,
  );

  /** Everything the rules read, gathered from what the app already holds. */
  private readonly evidence = computed<StatusEvidence>(() => {
    const i = this.issue();
    const now = this.now();
    const entries = this.entries();
    const typeOf = (status: string) => statusTypeOf(entries, status);

    const kids = this.children.of(i.id);
    const subtasks = { total: kids.length, done: 0, canceled: 0, inProgress: 0, inReview: 0 };
    for (const k of kids) {
      const t = typeOf(k.status);
      if (t === 'done') subtasks.done++;
      else if (t === 'canceled') subtasks.canceled++;
      else if (t === 'in_progress') subtasks.inProgress++;
      else if (t === 'in_review') subtasks.inReview++;
    }

    const artifacts: ArtifactEvidence[] = (this.store.artifactsByIssue().get(i.id) ?? []).map((a) => ({
      kind: a.kind,
      state: a.state,
      ci: a.ci,
      review: a.review,
      hasConflicts: a.hasConflicts,
      ref: a.externalId ?? undefined,
    }));

    const mine = this.time.entries().filter((e) => e.issueId === i.id);
    const running = mine.some((e) => !e.endedAt);
    let recentMs = 0;
    let lastTracked = 0;
    for (const e of mine) {
      if (!e.endedAt) continue;
      const end = Date.parse(e.endedAt);
      lastTracked = Math.max(lastTracked, end);
      const from = Math.max(Date.parse(e.startedAt), now - RECENT_TRACK_MS);
      if (end > from) recentMs += end - from;
    }

    const subject = { type: 'issue' as const, id: i.id };
    const comments = [...this.store.commentsFor(subject)]
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map((c) => ({ body: c.body, at: c.createdAt }));
    const newestEvent = this.store.eventsBySubject().get(`issue:${i.id}`)?.[0]?.at;
    const last = [i.updatedAt, newestEvent, comments[0]?.at, lastTracked ? new Date(lastTracked).toISOString() : undefined]
      .filter((x): x is string => !!x)
      .sort()
      .pop();

    const ext = i.externalRef;
    return {
      now,
      current: this.currentType(),
      duplicateOf: i.duplicateOfId ? this.store.issueById().get(i.duplicateOfId)?.key : undefined,
      subtasks,
      artifacts,
      external:
        ext?.stateType
          ? { stateType: ext.stateType, label: `${ext.provider === 'github' ? 'GitHub' : ext.provider === 'linear' ? 'Linear' : 'The linked'} ${ext.key ?? 'issue'}` }
          : undefined,
      timer: { runningHere: running, recentMs },
      lastActivityAt: last,
      comments,
    };
  });

  protected readonly proposal = computed(() => proposeStatus(this.evidence()));
  protected readonly confidence = computed(() => CONFIDENCE[this.proposal().confidence]);

  /** The workspace's own status for the proposed type (the first one of that type). */
  protected readonly proposedId = computed(() => {
    const p = this.proposal();
    if (!p.changes) return this.currentId();
    return resolveStatusEntry(this.entries(), p.status as IssueStatus)?.id ?? p.status;
  });
  protected readonly proposedName = computed(
    () => resolveStatusEntry(this.entries(), this.proposedId())?.name ?? this.proposedId(),
  );
  protected readonly currentName = computed(
    () => resolveStatusEntry(this.entries(), this.currentId())?.name ?? this.currentId(),
  );

  protected onState(next: 'open' | 'closed'): void {
    this.state.set(next);
    if (next !== 'open') {
      this.picking.set(false);
      return;
    }
    this.now.set(Date.now());
    void this.time.load();
    void this.store.loadComments({ type: 'issue', id: this.issue().id }, { quiet: true });
  }

  protected close(): void {
    this.state.set('closed');
    this.picking.set(false);
  }

  protected apply(statusId: string): void {
    if (statusId !== this.currentId()) this.actions.setStatus([this.issue().id], statusId);
    this.close();
  }
}
