// The milestones of a project as v3 "08 · Project" draws them: the next one open as a card (progress bar by
// status, legend, its open tasks), the others as a line with a thin bar, shipped ones as a single line.
// The counts and "view all" open the Tasks tab filtered by the milestone.
import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { RouterLink, type Params } from '@angular/router';
import { format } from 'date-fns';
import { TramaStore, resolveStatusEntry, statusTypeOf, type Issue, type Milestone, type Project } from '../../core';
import { ActorAvatar } from '../../shared/actor-avatar';
import { V3SectionTitle } from '../../shared/v3';
import {
  dateOfDay,
  dayOf,
  fmtNum,
  todayDay,
  unitsOf,
  type MilestoneState,
  type MilestoneStats,
} from '../milestones/milestone-model';
import { MilestoneInfo } from '../milestones/milestone-stats';
import { dueText } from './project-burnup-model';
import { tasksQuery } from './project-tasks-link';

const OPEN_VISIBLE = 4;

const SQUARE: Record<MilestoneState, string> = {
  done: 'bg-status-done',
  active: 'bg-status-in-progress',
  overdue: 'bg-red',
  idle: 'bg-faint',
  empty: 'bg-faint',
};

type Bucket = 'done' | 'review' | 'progress' | 'todo';

interface Segment {
  key: Bucket;
  label: string;
  cls: string;
  /** Tasks. */
  count: number;
  /** Points, or tasks when the project has no estimates. */
  units: number;
}

interface Card {
  ms: Milestone;
  state: MilestoneState;
  stats: MilestoneStats;
  issues: readonly Issue[];
  open: readonly Issue[];
  segments: readonly Segment[];
  when: string;
  summary: string;
  shipped: string;
}

const BUCKET: Record<string, Bucket | undefined> = {
  done: 'done',
  in_review: 'review',
  in_progress: 'progress',
  todo: 'todo',
  backlog: 'todo',
  draft: 'todo',
};

const SEGMENT_META: readonly { key: Bucket; label: string; cls: string }[] = [
  { key: 'done', label: 'Done', cls: 'bg-status-done' },
  { key: 'review', label: 'In review', cls: 'bg-delta-line' },
  { key: 'progress', label: 'In progress', cls: 'bg-status-in-progress' },
  { key: 'todo', label: 'Todo', cls: 'bg-line' },
];

/** The status types each bucket of the bar stands for (see `BUCKET`). */
const BUCKET_STATUS: Record<Bucket, readonly string[]> = {
  done: ['done'],
  review: ['in_review'],
  progress: ['in_progress'],
  todo: ['draft', 'backlog', 'todo'],
};

const OPEN_ORDER: Record<Bucket, number> = { progress: 0, review: 1, todo: 2, done: 3 };

@Component({
  selector: 'app-project-milestone-cards',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet, RouterLink, ActorAvatar, V3SectionTitle],
  host: { class: 'flex flex-col' },
  template: `
    <v3-section-title title="Milestones" [caption]="caption()" class="pb-2.5" />

    @for (c of cards(); track c.ms.id) {
      @let open = isOpen(c);
      @let shipped = c.state === 'done';
      <article
        class="border-border relative border [&:not(:first-child)]:-mt-px"
        [class.bg-card]="open"
        [attr.aria-label]="c.ms.name"
      >
        <div class="flex min-w-0 flex-col" [class]="open ? 'gap-2.5 px-4 py-3.5' : shipped ? 'px-4 py-3' : 'gap-2 px-4 py-3'">
          <div class="flex min-w-0 items-center gap-2.5">
            @if (!shipped) {
              <span class="size-2.5 shrink-0" [class]="square[c.state]" aria-hidden="true"></span>
            }
            <button
              type="button"
              class="flex min-w-0 flex-1 items-center gap-2.5 text-left outline-none focus-visible:underline"
              [attr.aria-expanded]="open"
              (click)="toggle(c)"
            >
              <span class="shrink-0 text-[15px] leading-5 font-semibold" [class]="shipped ? 'text-muted-foreground' : 'text-foreground'">{{ c.ms.name }}</span>
              <span class="text-faint min-w-0 truncate font-mono text-[10.5px] leading-[13px]">{{ shipped ? c.shipped : c.when }}</span>
              <span class="flex-1"></span>
              @if (shipped) {
                <span class="text-muted-foreground shrink-0 font-mono text-[10.5px] leading-[13px]">{{ open ? 'Close summary' : 'Open summary →' }}</span>
              }
            </button>
            @if (!shipped) {
              @if (c.issues.length) {
                <a
                  class="text-foreground shrink-0 font-mono text-[11px] leading-[14px] underline-offset-2 outline-none hover:underline focus-visible:underline"
                  [routerLink]="projectLink()"
                  [queryParams]="query(c)"
                  [attr.aria-label]="'Show the tasks of ' + c.ms.name"
                  >{{ c.summary }}</a
                >
              } @else {
                <span class="text-foreground shrink-0 font-mono text-[11px] leading-[14px]">{{ c.summary }}</span>
              }
            }
          </div>

          @if (!shipped) {
            @if (open) {
              <div class="flex h-1.5 w-full gap-0.5" role="img" [attr.aria-label]="c.summary">
                @for (s of c.segments; track s.key) {
                  <span class="h-1.5" [class]="s.cls" [style.flex]="s.units + ' 1 0'"></span>
                }
                @if (!c.segments.length) {
                  <span class="bg-line h-1.5 flex-1"></span>
                }
              </div>
              <div class="flex flex-wrap gap-4">
                @for (s of c.segments; track s.key) {
                  <a
                    class="text-faint hover:text-foreground inline-flex items-center gap-[5px] font-mono text-[10.5px] leading-[13px] outline-none focus-visible:underline"
                    [routerLink]="projectLink()"
                    [queryParams]="query(c, s.key)"
                  >
                    <span class="size-1.5" [class]="s.cls"></span>{{ s.label }} {{ s.count }}
                  </a>
                }
              </div>
            } @else {
              <div class="bg-line h-1 w-full" role="img" [attr.aria-label]="c.summary">
                <div class="bg-status-done h-1" [style.width.%]="c.stats.fraction * 100"></div>
              </div>
            }
          }
        </div>

        @if (open) {
          <div class="flex flex-col">
            @if (c.open.length) {
              <div class="border-border flex flex-col border-t">
                @for (i of c.open.slice(0, openVisible); track i.id) {
                  <ng-container [ngTemplateOutlet]="task" [ngTemplateOutletContext]="{ $implicit: i }" />
                }
              </div>
              <a
                class="text-muted-foreground hover:text-foreground px-4 py-2.5 text-left font-mono text-[10.5px] leading-[13px] outline-none focus-visible:underline"
                [routerLink]="projectLink()"
                [queryParams]="query(c)"
              >
                @if (c.open.length > openVisible) {
                  + {{ c.open.length - openVisible }} more open ·
                }
                view all {{ c.issues.length }}
              </a>
            } @else {
              <p class="text-faint border-border border-t px-4 py-3 font-mono text-[10.5px]">
                @if (c.issues.length) {
                  Nothing open.
                  <a class="hover:text-foreground underline underline-offset-2" [routerLink]="projectLink()" [queryParams]="query(c)">View all {{ c.issues.length }}</a>
                } @else {
                  No tasks in this milestone.
                }
              </p>
            }
          </div>
        }
      </article>
    }

    @if (!cards().length) {
      <p class="text-faint border-border border px-4 py-3 font-mono text-[10.5px]">No milestones yet.</p>
    }

    <ng-template #task let-i>
      <a
        class="border-border hover:bg-hover flex h-[33.5px] items-center gap-2.5 border-b px-4 outline-none focus-visible:underline"
        [routerLink]="['/', slug(), 'tasks', i.key]"
      >
        <span class="size-[7px] shrink-0" [style.background]="statusColor(i)" aria-hidden="true"></span>
        <span class="text-faint w-16 shrink-0 font-mono text-[10.5px] leading-[13px]">{{ i.key }}</span>
        <span class="text-foreground min-w-0 flex-1 truncate text-[13px] leading-4">{{ i.title }}</span>
        @if (i.threadUrl) {
          <span class="bg-delta-line size-[7px] shrink-0" title="Delta thread linked"></span>
        } @else {
          <span class="outline-faint size-[7px] shrink-0 outline-1 -outline-offset-[0.5px]" title="No Delta thread"></span>
        }
        @if (i.assigneeId) {
          <app-actor-avatar [actor]="{ type: 'user', id: i.assigneeId }" [size]="20" />
        } @else {
          <span class="size-5 shrink-0"></span>
        }
      </a>
    </ng-template>

  `,
})
export class ProjectMilestoneCards {
  private readonly store = inject(TramaStore);
  private readonly info = inject(MilestoneInfo);

  readonly project = input.required<Project>();

  protected readonly square = SQUARE;
  protected readonly openVisible = OPEN_VISIBLE;

  protected readonly slug = computed(() => this.store.slug() ?? '');
  protected readonly projectLink = computed(() => ['/', this.slug(), 'projects', this.project().id]);

  /** Cards the reader opened (true) or closed (false); the rest follows the default. */
  private readonly toggled = signal<Readonly<Record<string, boolean>>>({});

  private readonly nextId = computed(() => this.info.nextByProject().get(this.project().id)?.ms.id);

  protected readonly cards = computed<readonly Card[]>(() => {
    const p = this.project();
    const list = this.store.milestonesByProject().get(p.id) ?? [];
    const stats = this.info.stats();
    const states = this.info.states();
    const points = this.info.pointsByProject().get(p.id) ?? false;
    const entries = this.store.settings().statuses.issue;
    const byMs = this.store.issuesByMilestone();
    const today = todayDay();
    return list.map((ms) => {
      const s = stats.get(ms.id)!;
      const state = states.get(ms.id) ?? 'idle';
      const issues = byMs.get(ms.id) ?? [];
      const seg = new Map<Bucket, Segment>();
      const open: { issue: Issue; bucket: Bucket }[] = [];
      for (const i of issues) {
        const type = statusTypeOf(entries, i.status);
        const bucket = type ? BUCKET[type] : undefined;
        if (!bucket) continue;
        const meta = SEGMENT_META.find((m) => m.key === bucket)!;
        const cur = seg.get(bucket) ?? { ...meta, count: 0, units: 0 };
        cur.count++;
        cur.units += unitsOf(i, points);
        seg.set(bucket, cur);
        if (bucket !== 'done') open.push({ issue: i, bucket });
      }
      open.sort((a, b) => OPEN_ORDER[a.bucket] - OPEN_ORDER[b.bucket]);
      const day = ms.targetDate ? dayOf(ms.targetDate) : null;
      const date = day === null ? null : format(dateOfDay(day), 'MMM d');
      const planned = state === 'idle' || state === 'empty';
      const when =
        day === null
          ? 'no target date'
          : planned
            ? `${date} · planned`
            : `${date} · ${dueText(day - today)}`;
      const summary = !s.issues
        ? 'No tasks'
        : s.points
          ? `${fmtNum(s.completed)} of ${fmtNum(s.scope)} pts · ${s.doneIssues}/${s.issues} tasks`
          : `${s.doneIssues}/${s.issues} tasks`;
      const finished = issues
        .map((i) => i.completedAt)
        .filter((d): d is string => !!d)
        .sort()
        .pop();
      const shippedOn = finished ? format(dateOfDay(dayOf(finished)), 'MMM d') : date;
      const threads = issues.filter((i) => !!i.threadUrl).length;
      const shipped = [
        shippedOn ? `Shipped ${shippedOn}` : 'Shipped',
        `${s.issues} ${s.issues === 1 ? 'task' : 'tasks'}`,
        `${threads} ${threads === 1 ? 'thread' : 'threads'} recorded`,
      ].join(' · ');
      return {
        ms,
        state,
        stats: s,
        issues,
        open: open.map((o) => o.issue),
        segments: SEGMENT_META.map((m) => seg.get(m.key)).filter((x): x is Segment => !!x),
        when,
        summary,
        shipped,
      };
    });
  });

  protected readonly caption = computed(() => {
    const cards = this.cards();
    if (!cards.length) return '';
    const shipped = cards.filter((c) => c.state === 'done').length;
    return shipped ? `${cards.length} · ${shipped} shipped` : String(cards.length);
  });

  protected isOpen(c: Card): boolean {
    return this.toggled()[c.ms.id] ?? c.ms.id === this.nextId();
  }

  protected toggle(c: Card): void {
    this.toggled.update((t) => ({ ...t, [c.ms.id]: !this.isOpen(c) }));
  }

  protected statusColor(i: Issue): string {
    return resolveStatusEntry(this.store.settings().statuses.issue, i.status)?.color ?? '#8c9096';
  }

  /** The project's Tasks tab, filtered by this milestone (and by the status bucket when given). */
  protected query(c: Card, bucket?: Bucket): Params {
    return tasksQuery({ milestone: c.ms.id, status: bucket ? BUCKET_STATUS[bucket] : [] });
  }

}
