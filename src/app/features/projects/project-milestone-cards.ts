// The milestones of a project as v3 "08 · Project" draws them: the next one open as a card (progress bar by
// status, legend, its open tasks), the others as a line with a thin bar, shipped ones as a single line.
// Everything the old milestone rows did stays: add, rename, target date, description, add tasks,
// move up / down and delete. The counts and "view all" open the Tasks tab filtered by the milestone.
import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, input, signal, viewChild } from '@angular/core';
import { RouterLink, type Params } from '@angular/router';
import { format } from 'date-fns';
import {
  LucideCalendar,
  LucideDynamicIcon,
  LucideEllipsis,
  LucideMoveDown,
  LucideMoveUp,
  LucidePencil,
  LucidePlus,
  LucideText,
  LucideTrash2,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { TramaStore, resolveStatusEntry, statusTypeOf, type Issue, type Milestone, type Project } from '../../core';
import { ActorAvatar } from '../../shared/actor-avatar';
import { DATE_PRESETS, DatePicker } from '../../shared/date-picker';
import { EditableMarkdown } from '../../shared/inline-edit';
import { Picker } from '../../shared/picker';
import { issueOptions } from '../../shared/picker-options';
import { V3SectionTitle } from '../../shared/v3';
import { MilestoneActions, isoFromDate } from '../milestones/milestone-actions';
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
  index: number;
  state: MilestoneState;
  stats: MilestoneStats;
  issues: readonly Issue[];
  open: readonly Issue[];
  segments: readonly Segment[];
  when: string;
  summary: string;
  shipped: string;
  late: boolean;
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
  imports: [
    NgTemplateOutlet,
    RouterLink,
    HlmButtonImports,
    HlmDropdownMenuImports,
    HlmInputImports,
    LucideDynamicIcon,
    ActorAvatar,
    DatePicker,
    EditableMarkdown,
    Picker,
    V3SectionTitle,
  ],
  host: { class: 'flex flex-col' },
  template: `
    <v3-section-title title="Milestones" [caption]="caption()" class="pb-2.5">
      @if (canEdit()) {
        <button
          hlmBtn
          variant="ghost"
          size="icon-xs"
          class="text-muted-foreground hover:text-foreground"
          aria-label="Add milestone"
          (click)="startAdd()"
        >
          <svg [lucideIcon]="plus" [size]="14"></svg>
        </button>
      }
    </v3-section-title>

    @for (c of cards(); track c.ms.id) {
      @let open = isOpen(c);
      @let shipped = c.state === 'done';
      <article
        class="border-border group/ms relative border [&:not(:first-child)]:-mt-px"
        [class.bg-card]="open"
        [attr.aria-label]="c.ms.name"
      >
        <div class="flex min-w-0 flex-col" [class]="open ? 'gap-2.5 px-4 py-3.5' : shipped ? 'px-4 py-3' : 'gap-2 px-4 py-3'">
          <div class="flex min-w-0 items-center gap-2.5">
            @if (!shipped) {
              <span class="size-2.5 shrink-0" [class]="square[c.state]" aria-hidden="true"></span>
            }
            @if (renaming() === c.ms.id) {
              <input
                #nameInput
                hlmInput
                class="h-7 min-w-0 flex-1 text-[15px] font-semibold"
                aria-label="Milestone name"
                [value]="draft()"
                (input)="draft.set($any($event.target).value)"
                (keydown.enter)="commitRename(c.ms)"
                (keydown.escape)="cancelRename($event)"
                (blur)="commitRename(c.ms)"
              />
            } @else {
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
            }
            @if (canEdit()) {
              <button
                hlmBtn
                variant="ghost"
                size="icon-xs"
                class="text-muted-foreground -my-1 shrink-0 opacity-0 group-hover/ms:opacity-100 focus-visible:opacity-100 max-md:opacity-100"
                [attr.aria-label]="'Actions for ' + c.ms.name"
                [hlmDropdownMenuTrigger]="menu"
                [hlmDropdownMenuTriggerData]="{ c: c }"
              >
                <svg [lucideIcon]="more" [size]="14"></svg>
              </button>
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
            @if (canEdit() || c.ms.description) {
              <div class="border-border flex flex-col gap-2 border-t px-4 py-3">
                <app-editable-markdown
                  class="text-[13px]"
                  label="milestone description"
                  placeholder="Add a description for this milestone…"
                  [value]="c.ms.description ?? ''"
                  [canEdit]="canEdit()"
                  (save)="actions.setDescription(c.ms, $event)"
                />
                @if (canEdit()) {
                  <div class="flex items-center gap-1.5">
                    <app-date-picker
                      label="Milestone target date"
                      triggerClass="text-muted-foreground h-6 gap-1.5 px-1.5 font-mono text-[11px]"
                      [value]="c.ms.targetDate"
                      (dateChange)="actions.setDate(c.ms, $event)"
                    >
                      <svg [lucideIcon]="cal" [size]="12"></svg>
                      <span [class.text-red]="c.late">{{ c.ms.targetDate ? dayLabel(c.ms) : 'Target date' }}</span>
                    </app-date-picker>
                    @if (addable(c).length) {
                      <app-picker
                        variant="bare"
                        label="Add tasks to milestone"
                        searchPlaceholder="Search project tasks…"
                        triggerClass="text-muted-foreground hover:text-foreground h-6 gap-1 px-1.5 font-mono text-[11px]"
                        [options]="addOptions(c)"
                        [value]="[]"
                        (valueChange)="addIssue(c.ms, $event[0])"
                      >
                        <svg [lucideIcon]="plus" [size]="12"></svg>Add task
                      </app-picker>
                    }
                  </div>
                }
              </div>
            }
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
                  No tasks in this milestone. Add some, or set a milestone on a task row.
                }
              </p>
            }
          </div>
        }
      </article>
    }

    @if (adding()) {
      <div class="border-border flex min-h-11 items-center gap-2 border [&:not(:first-child)]:-mt-px px-3">
        <span class="bg-faint size-2.5 shrink-0" aria-hidden="true"></span>
        <input
          #addInput
          hlmInput
          class="h-7 min-w-0 flex-1 border-transparent bg-transparent text-[13px] shadow-none focus-visible:border-input"
          placeholder="Milestone name, Enter to add"
          aria-label="New milestone name"
          [value]="newName()"
          (input)="newName.set($any($event.target).value)"
          (keydown.enter)="add()"
          (keydown.escape)="cancelAdd($event)"
        />
        <app-date-picker label="New milestone target date" align="end" triggerClass="h-7 gap-1.5 px-2 font-mono text-[11px]" [value]="newDateIso()" (dateChange)="newDate.set($event)">
          <svg [lucideIcon]="cal" [size]="12" class="text-muted-foreground"></svg>
          <span [class.text-muted-foreground]="!newDate()">{{ newDate() ? newDateLabel() : 'Target date' }}</span>
        </app-date-picker>
        <button hlmBtn size="xs" [disabled]="!newName().trim()" (click)="add()">Add</button>
        <button hlmBtn variant="ghost" size="xs" (click)="adding.set(false)">Cancel</button>
      </div>
    } @else if (!cards().length) {
      <p class="text-muted-foreground border-border border px-4 py-3 text-[13px]">
        Break this project into milestones. Each groups some of its tasks and has its own target date.
        @if (canEdit()) {
          <button type="button" class="text-foreground underline-offset-2 hover:underline" (click)="startAdd()">Add the first milestone</button>
        }
      </p>
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

    <ng-template #menu let-c="c">
      <hlm-dropdown-menu class="w-56">
        <hlm-dropdown-menu-group>
          <button hlmDropdownMenuItem (triggered)="startRename(c.ms)">
            <svg [lucideIcon]="pencil" [size]="14" class="text-muted-foreground"></svg>Rename
          </button>
          <button hlmDropdownMenuItem (triggered)="editDescription(c)">
            <svg [lucideIcon]="textIcon" [size]="14" class="text-muted-foreground"></svg>Edit description
          </button>
          <button hlmDropdownMenuItem [hlmDropdownMenuSubTrigger]="dateSub" [hlmDropdownMenuTriggerData]="{ c: c }">
            <svg [lucideIcon]="cal" [size]="14" class="text-muted-foreground"></svg>Target date
            <hlm-dropdown-menu-item-sub-indicator />
          </button>
        </hlm-dropdown-menu-group>
        <hlm-dropdown-menu-separator />
        <hlm-dropdown-menu-group>
          <button hlmDropdownMenuItem [disabled]="c.index === 0" (triggered)="actions.move(c.ms, -1)">
            <svg [lucideIcon]="up" [size]="14" class="text-muted-foreground"></svg>Move up
          </button>
          <button hlmDropdownMenuItem [disabled]="c.index === cards().length - 1" (triggered)="actions.move(c.ms, 1)">
            <svg [lucideIcon]="down" [size]="14" class="text-muted-foreground"></svg>Move down
          </button>
        </hlm-dropdown-menu-group>
        <hlm-dropdown-menu-separator />
        <button hlmDropdownMenuItem variant="destructive" (triggered)="actions.remove(c.ms)">
          <svg [lucideIcon]="trash" [size]="14"></svg>Delete milestone
        </button>
      </hlm-dropdown-menu>
    </ng-template>
    <ng-template #dateSub let-c="c">
      <hlm-dropdown-menu-sub class="w-48">
        @for (d of presets; track d.label) {
          <button hlmDropdownMenuItem (triggered)="actions.setDate(c.ms, d.at())">{{ d.label }}</button>
        }
        @if (c.ms.targetDate) {
          <hlm-dropdown-menu-separator />
          <button hlmDropdownMenuItem (triggered)="actions.setDate(c.ms, null)"><span class="text-muted-foreground">Clear date</span></button>
        }
      </hlm-dropdown-menu-sub>
    </ng-template>
  `,
})
export class ProjectMilestoneCards {
  private readonly store = inject(TramaStore);
  private readonly info = inject(MilestoneInfo);
  protected readonly actions = inject(MilestoneActions);

  readonly project = input.required<Project>();
  /** List only: no adding or editing. */
  readonly readonly = input(false);

  protected readonly square = SQUARE;
  protected readonly openVisible = OPEN_VISIBLE;
  protected readonly presets = DATE_PRESETS;
  protected readonly plus = LucidePlus;
  protected readonly cal = LucideCalendar;
  protected readonly more = LucideEllipsis;
  protected readonly pencil = LucidePencil;
  protected readonly textIcon = LucideText;
  protected readonly up = LucideMoveUp;
  protected readonly down = LucideMoveDown;
  protected readonly trash = LucideTrash2;

  protected readonly slug = computed(() => this.store.slug() ?? '');
  protected readonly projectLink = computed(() => ['/', this.slug(), 'projects', this.project().id]);
  protected readonly canEdit = computed(() => !this.readonly() && this.store.allowed('manageProjects'));

  /** Cards the reader opened (true) or closed (false); the rest follows the default. */
  private readonly toggled = signal<Readonly<Record<string, boolean>>>({});
  protected readonly renaming = signal<string | null>(null);
  protected readonly draft = signal('');
  protected readonly adding = signal(false);
  protected readonly newName = signal('');
  protected readonly newDate = signal<Date | null>(null);
  protected readonly newDateIso = computed(() => this.newDate()?.toISOString());
  protected readonly newDateLabel = computed(() => (this.newDate() ? format(this.newDate()!, 'MMM d') : ''));
  private readonly nameInput = viewChild<ElementRef<HTMLInputElement>>('nameInput');
  private readonly addInput = viewChild<ElementRef<HTMLInputElement>>('addInput');

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
    return list.map((ms, index) => {
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
        index,
        state,
        stats: s,
        issues,
        open: open.map((o) => o.issue),
        segments: SEGMENT_META.map((m) => seg.get(m.key)).filter((x): x is Segment => !!x),
        when,
        summary,
        shipped,
        late: state === 'overdue',
      };
    });
  });

  protected readonly caption = computed(() => {
    const cards = this.cards();
    if (!cards.length) return '';
    const shipped = cards.filter((c) => c.state === 'done').length;
    return shipped ? `${cards.length} · ${shipped} shipped` : String(cards.length);
  });

  constructor() {
    effect(() => {
      const el = this.nameInput()?.nativeElement;
      if (el) {
        el.focus();
        el.select();
      }
    });
    effect(() => this.addInput()?.nativeElement.focus());
  }

  protected isOpen(c: Card): boolean {
    return this.toggled()[c.ms.id] ?? c.ms.id === this.nextId();
  }

  protected toggle(c: Card): void {
    this.toggled.update((t) => ({ ...t, [c.ms.id]: !this.isOpen(c) }));
  }

  protected statusColor(i: Issue): string {
    return resolveStatusEntry(this.store.settings().statuses.issue, i.status)?.color ?? '#8c9096';
  }

  protected dayLabel(ms: Milestone): string {
    return format(dateOfDay(dayOf(ms.targetDate!)), 'MMM d');
  }

  /** The project's Tasks tab, filtered by this milestone (and by the status bucket when given). */
  protected query(c: Card, bucket?: Bucket): Params {
    return tasksQuery({ milestone: c.ms.id, status: bucket ? BUCKET_STATUS[bucket] : [] });
  }

  protected addable(c: Card): readonly Issue[] {
    return (this.store.issuesByProject().get(this.project().id) ?? []).filter(
      (i) => i.status !== 'canceled' && !i.milestoneIds?.includes(c.ms.id),
    );
  }

  protected addOptions(c: Card): ReturnType<typeof issueOptions> {
    return issueOptions(this.addable(c));
  }

  protected addIssue(ms: Milestone, id: string | undefined): void {
    const issue = id ? this.store.getIssue(id) : undefined;
    if (issue) this.actions.assign(issue, this.project().id, ms.id);
  }

  protected editDescription(c: Card): void {
    this.toggled.update((t) => ({ ...t, [c.ms.id]: true }));
  }

  protected startRename(ms: Milestone): void {
    this.draft.set(ms.name);
    this.renaming.set(ms.id);
  }

  protected commitRename(ms: Milestone): void {
    if (this.renaming() !== ms.id) return;
    this.renaming.set(null);
    this.actions.rename(ms, this.draft());
  }

  protected cancelRename(e: Event): void {
    e.stopPropagation();
    this.renaming.set(null);
  }

  protected startAdd(): void {
    this.newName.set('');
    this.newDate.set(null);
    this.adding.set(true);
  }

  protected cancelAdd(e: Event): void {
    e.stopPropagation();
    this.adding.set(false);
  }

  protected async add(): Promise<void> {
    const name = this.newName().trim();
    if (!name) return;
    const d = this.newDate();
    this.newName.set('');
    this.newDate.set(null);
    await this.actions.create(this.project().id, name, d ? isoFromDate(d) : undefined);
    this.addInput()?.nativeElement.focus();
  }
}
