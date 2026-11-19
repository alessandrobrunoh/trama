// The "Time" tab of the task inspector: a clear timer (big elapsed time, start / stop, and which task it is
// running on when that is another one), today's and total tracked time against what is typical for the
// estimate, the recent entries (edit, delete with the global confirm dialog) and a manual entry form.
import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  LucideCalendar,
  LucideDynamicIcon,
  LucidePencil,
  LucidePlay,
  LucidePlus,
  LucideSquare,
  LucideTrash2,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import {
  TimeEntriesStore,
  TramaStore,
  formatEstimate,
  formatSpan,
  fullDateTime,
  relativeTime,
  shortDate,
  type Issue,
} from '../../core';
import type { TimeEntry } from '../../core/api/api.types';
import { UiStore } from '../../core/stores/ui.store';
import { DatePicker } from '../../shared/date-picker';
import { REF_MIN, trackedByIssue } from '../stats/flow-stats';
import { issueCost, type CostVerdict } from './issue-cost';
import {
  atTime,
  clock,
  entriesOf,
  entryProblem,
  timeOf,
  trackedOn,
} from './task-time-model';

const VERDICT: Record<CostVerdict, { tone: string; label: (open: boolean, ratio: number) => string }> = {
  faster: { tone: 'bg-status-ready-to-land/10 text-status-ready-to-land', label: () => 'Faster than typical' },
  on_track: { tone: 'bg-status-shipped/10 text-status-shipped', label: () => 'On track' },
  longer: {
    tone: 'bg-status-blocked/10 text-status-blocked',
    label: (open, ratio) => `${open ? 'Already' : 'Took'} ${ratio.toFixed(1)}× the typical time`,
  },
};

const RECENT = 5;

@Component({
  selector: 'app-task-time',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, RouterLink, HlmButtonImports, HlmInputImports, HlmTooltip, LucideDynamicIcon, DatePicker],
  host: { class: 'flex min-w-0 flex-col gap-5' },
  template: `
    @let i = issue();
    @let t = tracked();

    <!-- Timer -->
    <section aria-label="Timer" class="border-border/70 rounded-lg border px-3.5 py-3">
      <div class="flex items-center justify-between gap-2">
        <p class="text-muted-foreground flex items-center gap-1.5 text-xs">
          @if (runningHere()) {
            <span class="relative flex size-2" aria-hidden="true">
              <span class="bg-status-working absolute inline-flex size-full animate-ping rounded-full opacity-60 motion-reduce:animate-none"></span>
              <span class="bg-status-working relative inline-flex size-2 rounded-full"></span>
            </span>
            Running
          } @else {
            Timer
          }
        </p>
        @if (canTrack()) {
          @if (runningHere()) {
            <button hlmBtn type="button" size="sm" variant="outline" [disabled]="time.busy()" (click)="time.stop()">
              <svg [lucideIcon]="stopIcon" [size]="13" aria-hidden="true"></svg> Stop
            </button>
          } @else {
            <button hlmBtn type="button" size="sm" [disabled]="time.busy()" (click)="start()">
              <svg [lucideIcon]="playIcon" [size]="13" aria-hidden="true"></svg>
              {{ elsewhere() ? 'Start here' : 'Start' }}
            </button>
          }
        }
      </div>
      <p
        class="mt-1 font-mono text-3xl leading-none tracking-tight tabular-nums"
        [class.text-muted-foreground]="!runningHere()"
        role="timer"
        [attr.aria-label]="runningHere() ? 'Elapsed ' + elapsed() : 'Timer stopped'"
      >
        {{ runningHere() ? elapsed() : '00:00:00' }}
      </p>
      @if (runningHere()) {
        <p class="text-muted-foreground mt-1.5 text-xs">Started {{ startedLabel() }}</p>
      }
      @if (elsewhere(); as other) {
        <div class="bg-muted mt-2.5 flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs">
          <span class="bg-status-working size-1.5 shrink-0 rounded-full" aria-hidden="true"></span>
          <span class="text-muted-foreground min-w-0 flex-1 truncate">
            Running on
            @if (other.issue; as o) {
              <a class="text-foreground font-mono hover:underline" [routerLink]="['/', slug(), 'tasks', o.key]">{{ o.key }}</a>
              {{ o.title }}
            } @else {
              another task
            }
          </span>
          <span class="font-mono tabular-nums">{{ other.elapsed }}</span>
        </div>
        <p class="text-muted-foreground mt-1.5 text-[11px]">Starting here stops it.</p>
      }
      @if (time.error(); as e) {
        <p class="text-destructive mt-2 text-xs" role="alert">{{ e }}</p>
      }
    </section>

    <!-- Tracked -->
    <section aria-label="Tracked time">
      <div class="grid grid-cols-2 gap-3 px-0.5">
        <div>
          <p class="text-muted-foreground text-xs">Today</p>
          <p class="text-base tabular-nums" [class.text-muted-foreground]="!t.todayMs">{{ t.todayMs ? span(t.todayMs) : '0m' }}</p>
        </div>
        <div>
          <p class="text-muted-foreground text-xs">Total</p>
          <p class="text-base tabular-nums" [class.text-muted-foreground]="!t.totalMs">{{ t.totalMs ? span(t.totalMs) : 'None yet' }}</p>
        </div>
      </div>

      @if (bar(); as b) {
        <div class="mt-2.5 px-0.5">
          <div
            class="bg-muted relative h-1.5 overflow-hidden rounded-full"
            role="img"
            [attr.aria-label]="barLabel()"
          >
            <span class="bg-foreground/25 absolute inset-y-0 left-0 rounded-full" [style.width.%]="b.total"></span>
            <span class="bg-primary absolute inset-y-0 left-0 rounded-full" [style.width.%]="b.today"></span>
            @if (b.mark !== null) {
              <span class="bg-foreground/60 absolute inset-y-0 w-px" [style.left.%]="b.mark"></span>
            }
          </div>
          <div class="text-muted-foreground mt-1.5 flex items-center justify-between gap-2 text-[11px]">
            <span>
              Typical for <span class="text-foreground">{{ points(i.estimate!) }}</span>: {{ span(b.typicalMs) }}
            </span>
            @if (verdict(); as v) {
              <span class="rounded-full px-2 py-0.5 font-medium" [class]="v.tone">{{ v.text }}</span>
            }
          </div>
        </div>
      } @else {
        <p class="text-muted-foreground mt-2 px-0.5 text-[11px]">{{ noBarHint() }}</p>
      }
    </section>

    <!-- Entries -->
    <section aria-labelledby="task-time-entries">
      <div class="mb-1 flex items-center justify-between gap-2 px-0.5">
        <h3 id="task-time-entries" class="text-muted-foreground text-xs font-medium">
          Entries
          @if (entries().length) {
            <span class="font-normal tabular-nums">{{ entries().length }}</span>
          }
        </h3>
        @if (canTrack() && !form()) {
          <button
            type="button"
            class="text-muted-foreground hover:bg-hover hover:text-foreground focus-visible:ring-ring inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-xs outline-none focus-visible:ring-2"
            (click)="openForm('new')"
          >
            <svg [lucideIcon]="plusIcon" [size]="12" aria-hidden="true"></svg> Add time
          </button>
        }
      </div>

      @if (form(); as f) {
        <form class="border-border/70 mb-2 flex flex-col gap-2.5 rounded-lg border p-3" (submit)="save($event)">
          <p class="text-xs font-medium">{{ f === 'new' ? 'Add time' : 'Edit entry' }}</p>
          <div class="grid grid-cols-2 items-end gap-2">
            <div class="col-span-2 grid gap-1">
              <span class="text-muted-foreground text-[11px]">Day</span>
              <app-date-picker
                label="Day of the session"
                triggerClass="border-input h-8 gap-2 border px-2.5 text-[13px]"
                [value]="day().toISOString()"
                (dateChange)="day.set($event ?? today())"
              >
                <svg [lucideIcon]="calendarIcon" [size]="13" class="text-muted-foreground" aria-hidden="true"></svg>
                <span>{{ day() | date: 'EEE, MMM d' }}</span>
              </app-date-picker>
            </div>
            <div class="grid gap-1">
              <label for="task-time-from" class="text-muted-foreground text-[11px]">From</label>
              <input id="task-time-from" hlmInput class="h-8 w-full text-[13px]" type="time" required
                [value]="from()" (input)="from.set($any($event.target).value)" />
            </div>
            <div class="grid gap-1">
              <label for="task-time-to" class="text-muted-foreground text-[11px]">To</label>
              <input id="task-time-to" hlmInput class="h-8 w-full text-[13px]" type="time" required
                [value]="to()" (input)="to.set($any($event.target).value)" />
            </div>
          </div>
          <div class="grid gap-1">
            <label for="task-time-note" class="text-muted-foreground text-[11px]">Note (optional)</label>
            <input id="task-time-note" hlmInput class="h-8 text-[13px]" placeholder="What did you work on?"
              [value]="note()" (input)="note.set($any($event.target).value)" />
          </div>
          @if (formError(); as e) {
            <p class="text-destructive text-xs" role="alert">{{ e }}</p>
          }
          <div class="flex items-center justify-end gap-1.5">
            <button hlmBtn type="button" size="sm" variant="ghost" (click)="closeForm()">Cancel</button>
            <button hlmBtn type="submit" size="sm" [disabled]="time.busy()">{{ f === 'new' ? 'Add entry' : 'Save' }}</button>
          </div>
        </form>
      }

      @if (!entries().length && !form()) {
        <p class="text-muted-foreground px-0.5 py-1 text-[13px]">
          Nothing tracked on this task yet.{{ canTrack() ? ' Start the timer or add a past session.' : '' }}
        </p>
      } @else {
        <ul class="-mx-1 flex flex-col" role="list">
          @for (e of shown(); track e.id) {
            <li class="group hover:bg-hover flex min-h-9 items-center gap-2 rounded-md px-1 py-1 text-[13px]">
              <div class="min-w-0 flex-1">
                <p class="truncate">
                  {{ dayLabel(e) }}
                  <span class="text-muted-foreground tabular-nums">
                    {{ e.startedAt | date: 'HH:mm' }}{{ e.endedAt ? ' – ' + (e.endedAt | date: 'HH:mm') : '' }}
                  </span>
                </p>
                @if (e.description) {
                  <p class="text-muted-foreground truncate text-xs">{{ e.description }}</p>
                }
              </div>
              @if (!e.endedAt) {
                <span class="bg-status-working/15 text-status-working rounded-full px-1.5 py-0.5 text-[11px]">Running</span>
              } @else {
                <span class="font-mono text-xs tabular-nums" [hlmTooltip]="exact(e.startedAt)">{{ entrySpan(e) }}</span>
              }
              @if (canTrack() && e.endedAt) {
                <span class="flex shrink-0 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 max-md:opacity-100">
                  <button
                    type="button"
                    class="text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex size-6 items-center justify-center rounded-md outline-none focus-visible:ring-2"
                    aria-label="Edit entry"
                    hlmTooltip="Edit"
                    (click)="openForm(e)"
                  >
                    <svg [lucideIcon]="pencilIcon" [size]="13" aria-hidden="true"></svg>
                  </button>
                  <button
                    type="button"
                    class="text-muted-foreground hover:text-destructive focus-visible:ring-ring inline-flex size-6 items-center justify-center rounded-md outline-none focus-visible:ring-2"
                    aria-label="Delete entry"
                    hlmTooltip="Delete"
                    [disabled]="time.busy()"
                    (click)="confirmRemove(e)"
                  >
                    <svg [lucideIcon]="trashIcon" [size]="13" aria-hidden="true"></svg>
                  </button>
                </span>
              }
            </li>
          }
        </ul>
        @if (entries().length > recent) {
          <button
            type="button"
            class="text-muted-foreground hover:text-foreground mt-1 px-0.5 text-xs"
            [attr.aria-expanded]="showAll()"
            (click)="showAll.set(!showAll())"
          >
            {{ showAll() ? 'Show fewer' : 'Show all ' + entries().length }}
          </button>
        }
      }
    </section>

    <!-- Dates -->
    <dl class="text-muted-foreground flex flex-col gap-0.5 px-0.5 text-xs">
      <div class="flex min-h-6 items-baseline justify-between gap-3">
        <dt>Created</dt>
        <dd class="text-foreground" [hlmTooltip]="exact(i.createdAt)">{{ ago(i.createdAt) }}</dd>
      </div>
      <div class="flex min-h-6 items-baseline justify-between gap-3">
        <dt>Started</dt>
        @if (i.startedAt) {
          <dd class="text-foreground" [hlmTooltip]="exact(i.startedAt)">{{ ago(i.startedAt) }}</dd>
        } @else {
          <dd>Not started</dd>
        }
      </div>
      @if (i.completedAt) {
        <div class="flex min-h-6 items-baseline justify-between gap-3">
          <dt>{{ i.status === 'canceled' ? 'Canceled' : 'Completed' }}</dt>
          <dd class="text-foreground" [hlmTooltip]="exact(i.completedAt)">{{ ago(i.completedAt) }}</dd>
        </div>
      }
    </dl>
  `,
})
export class TaskTime {
  protected readonly store = inject(TramaStore);
  protected readonly time = inject(TimeEntriesStore);
  private readonly ui = inject(UiStore);

  readonly issue = input.required<Issue>();

  protected readonly playIcon = LucidePlay;
  protected readonly stopIcon = LucideSquare;
  protected readonly plusIcon = LucidePlus;
  protected readonly pencilIcon = LucidePencil;
  protected readonly trashIcon = LucideTrash2;
  protected readonly calendarIcon = LucideCalendar;
  protected readonly recent = RECENT;

  private readonly now = signal(Date.now());

  // The form: `new`, or the entry being edited.
  protected readonly form = signal<'new' | TimeEntry | null>(null);
  protected readonly day = signal(new Date());
  protected readonly from = signal('');
  protected readonly to = signal('');
  protected readonly note = signal('');
  protected readonly formError = signal('');
  protected readonly showAll = signal(false);

  constructor() {
    void this.time.load();
    // Tick once a second, but only while a timer runs.
    effect((onCleanup) => {
      if (!this.time.running()) return;
      this.now.set(Date.now());
      const timer = setInterval(() => this.now.set(Date.now()), 1000);
      onCleanup(() => clearInterval(timer));
    });
    // Another task opened in the same pane: start over.
    let last: string | undefined;
    effect(() => {
      const id = this.issue().id;
      if (last !== undefined && last !== id) {
        this.form.set(null);
        this.showAll.set(false);
      }
      last = id;
    });
  }

  protected readonly slug = computed(() => this.store.slug() ?? '');
  protected readonly canTrack = computed(() => this.store.can('member'));
  protected readonly entries = computed(() => entriesOf(this.time.entries(), this.issue().id));
  protected readonly shown = computed(() => (this.showAll() ? this.entries() : this.entries().slice(0, RECENT)));
  protected readonly tracked = computed(() => trackedOn(this.time.entries(), this.issue().id, this.now()));

  protected readonly runningHere = computed(() => this.time.running()?.issueId === this.issue().id);
  /** A timer running on another task. */
  protected readonly elsewhere = computed(() => {
    const r = this.time.running();
    if (!r || r.issueId === this.issue().id) return null;
    return {
      issue: r.issueId ? this.store.issueById().get(r.issueId) : undefined,
      elapsed: clock(this.now() - Date.parse(r.startedAt)),
    };
  });
  protected readonly elapsed = computed(() => {
    const r = this.time.running();
    return r ? clock(this.now() - Date.parse(r.startedAt)) : '';
  });
  protected readonly startedLabel = computed(() => {
    const r = this.time.running();
    return r ? relativeTime(r.startedAt) : '';
  });

  private readonly cost = computed(() =>
    issueCost(this.issue(), this.store.issues(), trackedByIssue(this.time.entries())),
  );

  /** Tracked time against the typical time for this estimate; null until there is history to compare with. */
  protected readonly bar = computed(() => {
    const typical = this.cost().compare?.typicalMs;
    if (!typical) return null;
    const t = this.tracked();
    const max = Math.max(typical, t.totalMs, 1);
    return {
      typicalMs: typical,
      total: Math.min(100, (t.totalMs / max) * 100),
      today: Math.min(100, (t.todayMs / max) * 100),
      // Where "typical" falls once the tracked time has gone past it.
      mark: t.totalMs > typical ? (typical / max) * 100 : null,
    };
  });
  protected readonly barLabel = computed(() => {
    const b = this.bar();
    const t = this.tracked();
    return b ? `${formatSpan(t.totalMs)} tracked of ${formatSpan(b.typicalMs)} typical, ${formatSpan(t.todayMs)} today` : '';
  });
  protected readonly verdict = computed(() => {
    const c = this.cost();
    const v = c.compare?.verdict;
    if (!v || c.trackedMs === undefined) return null;
    return { tone: VERDICT[v].tone, text: VERDICT[v].label(c.open, c.compare?.ratio ?? 1) };
  });
  protected readonly noBarHint = computed(() => {
    const i = this.issue();
    const c = this.cost().compare;
    if (!c) {
      return this.store.estimateScale() === 'none'
        ? 'Estimates are off in this workspace.'
        : 'Add an estimate to compare with similar tasks.';
    }
    return `Estimate ${this.points(i.estimate!)}. Needs ${REF_MIN} finished tasks at this estimate with tracked time to compare (${c.n} so far).`;
  });

  // ───────────────────────── timer ─────────────────────────

  protected start(): void {
    const i = this.issue();
    void this.time.start({ issueId: i.id, projectId: i.projectId ?? null });
  }

  // ───────────────────────── entries ─────────────────────────

  protected today(): Date {
    return new Date();
  }

  protected openForm(target: 'new' | TimeEntry): void {
    this.formError.set('');
    if (target === 'new') {
      const end = new Date();
      const start = new Date(end.getTime() - 3_600_000);
      this.day.set(end);
      this.from.set(start.getDate() === end.getDate() ? timeOf(start.toISOString()) : '00:00');
      this.to.set(timeOf(end.toISOString()));
      this.note.set('');
    } else {
      this.day.set(new Date(target.startedAt));
      this.from.set(timeOf(target.startedAt));
      this.to.set(target.endedAt ? timeOf(target.endedAt) : '');
      this.note.set(target.description);
    }
    this.form.set(target);
  }

  protected closeForm(): void {
    this.form.set(null);
    this.formError.set('');
  }

  protected async save(event: Event): Promise<void> {
    event.preventDefault();
    const target = this.form();
    if (!target) return;
    const problem = entryProblem(this.day(), this.from(), this.to(), Date.now());
    if (problem) {
      this.formError.set(problem);
      return;
    }
    const i = this.issue();
    const input = {
      issueId: i.id,
      projectId: i.projectId ?? null,
      description: this.note().trim(),
      startedAt: atTime(this.day(), this.from()).toISOString(),
      endedAt: atTime(this.day(), this.to()).toISOString(),
    };
    const ok = target === 'new' ? await this.time.add(input) : await this.time.replace(target.id, input);
    if (ok) this.closeForm();
    else this.formError.set(this.time.error() || 'Could not save the entry.');
  }

  protected confirmRemove(entry: TimeEntry): void {
    this.ui.setConfirmDelete({
      title: 'Delete this time entry?',
      description: `${this.entrySpan(entry)} of tracked time is removed. This cannot be undone.`,
      onConfirm: async () => {
        await this.time.remove(entry.id);
      },
    });
  }

  // ───────────────────────── text ─────────────────────────

  protected dayLabel(e: TimeEntry): string {
    return shortDate(e.startedAt);
  }
  protected entrySpan(e: TimeEntry): string {
    return formatSpan(Date.parse(e.endedAt ?? new Date(this.now()).toISOString()) - Date.parse(e.startedAt));
  }
  /** "3 pts" or "M" (t-shirt). */
  protected points(n: number): string {
    const label = formatEstimate(n, this.store.estimateScale());
    return /^[\d.]+$/.test(label) ? `${label} pts` : label;
  }
  protected span(ms: number): string {
    return formatSpan(ms);
  }
  protected ago(iso: string): string {
    return relativeTime(iso);
  }
  protected exact(iso: string): string {
    return fullDateTime(iso);
  }
}
