import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import {
  LucideCalendar,
  LucideChevronLeft,
  LucideChevronRight,
  LucideCornerDownRight,
  LucideDynamicIcon,
  LucidePlus,
  LucideTrash2,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import { addDays, format } from 'date-fns';
import { usePageShortcuts } from '../../core/keyboard';
import { TimeEntriesStore } from '../../core/stores/time-entries.store';
import { TramaStore } from '../../core/stores/trama.store';
import { UiStore } from '../../core/stores/ui.store';
import { TopBarActions } from '../../layout/page-chrome';
import { AppSelect, type Option } from '../../shared/app-select';
import { DatePicker } from '../../shared/date-picker';
import { Kbd } from '../../shared/kbd';
import { PageHeader } from '../../shared/page-header';
import { atTime, entryProblem } from '../issues/task-time-model';
import {
  HOUR,
  WEEK_START_DAY,
  buildGrid,
  clock,
  downloadText,
  entriesOnDay,
  hm,
  hoursMinutes,
  mondayOf,
  segments,
  toCsv,
  weekDays,
  weekTitle,
  type DayEntry,
  type WeekDay,
} from './time-model';
import { TimeTabs } from './time-nav';

type Composer = 'closed' | 'start' | 'log';

/**
 * `/:workspace/timer` (v3 "23 · Time · Timesheet"): the week as a grid of tasks by day, with the timer on top and
 * the entries of one day beside it.
 *
 *   timer     what is running (or a start button), Switch task and Stop
 *   week      ‹ › through the weeks; the tracked total against the week before
 *   grid      one row per task worked on (subtasks under their parent), one column per day, day and week totals
 *   rail      the entries of the selected day (today by default), each one deletable
 *
 * Time is your own; the API returns only the signed-in person's entries. Keyboard: T starts or stops, ⇧T switches
 * task, L logs a past session, E exports the week as CSV.
 */
@Component({
  selector: 'app-timer-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    RouterLink,
    LucideDynamicIcon,
    HlmButtonImports,
    HlmInputImports,
    HlmTooltip,
    PageHeader,
    TopBarActions,
    TimeTabs,
    Kbd,
    AppSelect,
    DatePicker,
  ],
  host: { class: 'flex h-full min-h-0 flex-col' },
  template: `
    <app-page-header title="Time" />

    <ng-template appTopBarActions>
      <app-time-tabs />
      <button hlmBtn variant="outline" type="button" (click)="exportWeek()">Export <app-kbd keys="e" /></button>
      <button hlmBtn type="button" (click)="open('log')">Log time <app-kbd keys="l" /></button>
    </ng-template>

    <div class="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
      <div class="flex min-w-0 flex-1 flex-col gap-5 px-4 py-6 sm:px-8 lg:overflow-y-auto">
        @if (failure(); as message) {
          <p class="border-red/40 bg-red/10 text-red border px-4 py-2.5 text-[13px]" role="alert">{{ message }}</p>
        }

        <!-- timer -->
        <section class="bg-card border-border flex flex-wrap items-center gap-x-5 gap-y-3 border px-5 py-4" aria-label="Timer">
          @if (running(); as run) {
            <span class="bg-red size-2.5 shrink-0" aria-hidden="true"></span>
            <div class="flex flex-col gap-0.5">
              <span class="text-red font-mono text-[10px] leading-[13px]">RUNNING · SINCE {{ run.start | date: 'HH:mm' }}</span>
              <span class="text-foreground font-mono text-[30px] leading-[normal] tabular-nums" role="timer">{{ elapsed() }}</span>
            </div>
            <div class="flex min-w-0 flex-1 basis-60 flex-col gap-[3px]">
              <span class="text-faint truncate font-mono text-[10.5px] leading-[13px]">{{ runningMeta() }}</span>
              <span class="font-title text-foreground truncate text-[19px] leading-6">{{ runningTitle() }}</span>
            </div>
            <button hlmBtn variant="outline" type="button" [disabled]="timers.busy()" (click)="open('start')">
              Switch task <app-kbd keys="shift+t" />
            </button>
            <button hlmBtn type="button" [disabled]="timers.busy()" (click)="timers.stop()">Stop <app-kbd keys="t" /></button>
          } @else {
            <span class="border-faint size-2.5 shrink-0 border" aria-hidden="true"></span>
            <div class="flex flex-col gap-0.5">
              <span class="text-faint font-mono text-[10px] leading-[13px]">NOT TRACKING</span>
              <span class="text-muted-foreground font-mono text-[30px] leading-[normal] tabular-nums" role="timer">00:00:00</span>
            </div>
            <div class="flex min-w-0 flex-1 basis-60 flex-col gap-[3px]">
              <span class="text-faint truncate font-mono text-[10.5px] leading-[13px]">no timer running</span>
              <span class="font-title text-muted-foreground truncate text-[19px] leading-6">Pick a task, then start the timer</span>
            </div>
            <button hlmBtn type="button" [disabled]="timers.busy()" (click)="startOrOpen()">Start timer <app-kbd keys="t" /></button>
          }
        </section>

        <!-- composer -->
        @if (composer() !== 'closed') {
          <form
            class="bg-card border-border grid gap-3 border p-4 sm:grid-cols-2"
            [attr.aria-label]="composer() === 'log' ? 'Log time' : 'Start a timer'"
            (submit)="submit($event)"
            (keydown.escape)="composer.set('closed')"
          >
            <div class="flex items-center gap-3 sm:col-span-2">
              <span class="text-foreground font-mono text-[10px] leading-[13px]">
                {{ composer() === 'log' ? 'LOG A PAST SESSION' : running() ? 'SWITCH TASK' : 'START A TIMER' }}
              </span>
              <span class="flex-1"></span>
              <app-kbd keys="esc" />
            </div>
            <div class="grid gap-1.5 sm:col-span-2">
              <label for="timer-description" class="text-faint font-mono text-[10.5px] uppercase">Description</label>
              <input
                id="timer-description"
                hlmInput
                class="w-full"
                placeholder="What are you working on?"
                [value]="description()"
                (input)="description.set($any($event.target).value)"
              />
            </div>
            <div class="grid min-w-0 gap-1.5">
              <label for="timer-project" class="text-faint font-mono text-[10.5px] uppercase">Project</label>
              <app-select controlId="timer-project" [options]="projectChoices()" [value]="projectId()" (valueChange)="selectProject($event)" />
            </div>
            <div class="grid min-w-0 gap-1.5">
              <label for="timer-issue" class="text-faint font-mono text-[10.5px] uppercase">Task</label>
              <app-select controlId="timer-issue" [options]="issueChoices()" [(value)]="issueId" />
            </div>
            @if (composer() === 'log') {
              <div class="flex flex-wrap items-end gap-3 sm:col-span-2">
                <div class="grid gap-1.5">
                  <span class="text-faint font-mono text-[10.5px] uppercase">Day</span>
                  <app-date-picker
                    label="Day of the session"
                    triggerClass="border-input h-8 gap-2 border px-2.5 text-sm"
                    [value]="manualDate().toISOString()"
                    (dateChange)="manualDate.set($event ? $event : today())"
                  >
                    <svg [lucideIcon]="calendarIcon" [size]="13" class="text-muted-foreground"></svg>
                    <span>{{ manualDate() | date: 'EEE, MMM d' }}</span>
                  </app-date-picker>
                </div>
                <div class="grid gap-1.5">
                  <label for="manual-start" class="text-faint font-mono text-[10.5px] uppercase">From</label>
                  <input id="manual-start" hlmInput class="h-8 w-28" type="time" required [value]="manualStart()" (input)="manualStart.set($any($event.target).value)" />
                </div>
                <div class="grid gap-1.5">
                  <label for="manual-end" class="text-faint font-mono text-[10.5px] uppercase">To</label>
                  <input id="manual-end" hlmInput class="h-8 w-28" type="time" required [value]="manualEnd()" (input)="manualEnd.set($any($event.target).value)" />
                </div>
              </div>
            }
            <div class="flex items-center gap-2 sm:col-span-2">
              <button hlmBtn type="submit" [disabled]="timers.busy()">
                {{ composer() === 'log' ? 'Add entry' : running() ? 'Switch' : 'Start timer' }} <app-kbd keys="enter" />
              </button>
              <button hlmBtn variant="outline" type="button" (click)="composer.set('closed')">Cancel</button>
            </div>
          </form>
        }

        <!-- week -->
        <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
          <div class="outline-border flex outline-1 -outline-offset-1">
            <button
              type="button"
              class="text-muted-foreground hover:text-foreground flex h-[26px] w-7 items-center justify-center"
              aria-label="Previous week"
              (click)="shift(-1)"
            >
              <svg [lucideIcon]="prevIcon" [size]="14"></svg>
            </button>
            <button
              type="button"
              class="border-border text-muted-foreground hover:text-foreground flex h-[26px] w-7 items-center justify-center border-l"
              aria-label="Next week"
              (click)="shift(1)"
            >
              <svg [lucideIcon]="nextIcon" [size]="14"></svg>
            </button>
          </div>
          <h2 class="font-title text-foreground text-[19px] leading-6">{{ title() }}</h2>
          @if (offset() !== 0) {
            <button type="button" class="text-muted-foreground hover:text-foreground font-mono text-[11px]" (click)="offset.set(0)">
              This week
            </button>
          }
          <span class="flex-1"></span>
          <div class="flex items-center gap-2">
            <span class="text-foreground text-[14px] leading-[18px] font-semibold">{{ totalText() }}</span>
            <span class="text-faint font-mono text-[10.5px]">{{ lastWeekText() }} the week before</span>
            <span class="bg-secondary h-1 w-[120px]" aria-hidden="true">
              <span class="bg-foreground block h-1" [style.width.%]="weekShare()"></span>
            </span>
          </div>
        </div>

        <!-- grid -->
        <div class="border-border overflow-x-auto border">
          <div class="min-w-[640px]" role="table" aria-label="Time tracked this week, by task and day">
            <div class="bg-card border-border grid h-[34px] border-b" [class]="cols" role="row">
              <span class="text-faint flex items-center px-3.5 font-mono text-[10px]" role="columnheader">TASK</span>
              @for (d of days(); track d.from) {
                <button
                  type="button"
                  class="border-border flex items-center justify-center border-l font-mono text-[9.5px]"
                  [class]="d.today ? 'text-red bg-red/8' : d.weekend ? 'text-faint' : 'text-muted-foreground'"
                  [class.underline]="railDay().from === d.from && !d.today"
                  [class.underline-offset-4]="railDay().from === d.from && !d.today"
                  role="columnheader"
                  [attr.aria-pressed]="railDay().from === d.from"
                  (click)="selected.set(d.from)"
                >
                  {{ d.label }}
                </button>
              }
              <span class="text-foreground border-border flex items-center justify-center border-l font-mono text-[9.5px]" role="columnheader">TOTAL</span>
            </div>

            @for (row of grid().rows; track row.id) {
              <div class="border-border grid h-[42px] border-b" [class]="cols" role="row">
                <div class="flex min-w-0 items-center gap-2 pe-3.5" [class]="row.depth ? 'ps-8' : 'ps-3.5'" role="cell">
                  @if (row.depth) {
                    <svg [lucideIcon]="subIcon" [size]="12" class="text-faint -ms-5 shrink-0"></svg>
                  }
                  @if (row.issue; as issue) {
                    <span class="text-faint shrink-0 font-mono text-[10.5px]" [class]="row.depth ? 'w-[66px]' : 'w-[58px]'">{{ issue.key }}</span>
                    <a
                      class="text-foreground min-w-0 truncate text-[12.5px] hover:underline hover:underline-offset-4"
                      [routerLink]="['/', slug(), 'tasks', issue.key]"
                      >{{ issue.title }}</a
                    >
                    <span class="flex-1"></span>
                    @if (issue.threadUrl) {
                      <span class="bg-delta-line size-1.5 shrink-0" title="Delta thread linked" aria-hidden="true"></span>
                    }
                  } @else {
                    <span class="text-faint w-[58px] shrink-0 font-mono text-[10.5px]">—</span>
                    <span class="text-muted-foreground min-w-0 truncate text-[12.5px]">Other · no task</span>
                  }
                </div>
                @for (d of days(); track d.from; let i = $index) {
                  <div
                    class="border-border flex items-center justify-center gap-1 border-l font-mono"
                    [class]="d.today ? 'bg-red/4' : ''"
                    role="cell"
                  >
                    @if (row.cells[i]) {
                      <span class="text-foreground text-[11.5px]">{{ hm(row.cells[i]) }}</span>
                      @if (row.running && d.today) {
                        <span class="bg-red size-[5px]" title="Timer running" aria-hidden="true"></span>
                      }
                    } @else if (!d.future) {
                      <span class="text-line text-[11px]" aria-label="none">—</span>
                    }
                  </div>
                }
                <div class="border-border text-foreground flex items-center justify-center border-l font-mono text-[11.5px]" role="cell">
                  {{ hm(row.total) }}
                </div>
              </div>
            } @empty {
              <div class="border-border text-muted-foreground border-b px-3.5 py-6 text-center text-[13px]" role="row">
                @if (timers.state() === 'loading') {
                  Loading time entries…
                } @else {
                  Nothing tracked this week. Start the timer or log a past session.
                }
              </div>
            }

            <button
              type="button"
              class="text-faint hover:text-muted-foreground border-border flex h-[38px] w-full items-center gap-2 border-b px-3.5 text-[12.5px]"
              (click)="open('log')"
            >
              <svg [lucideIcon]="plusIcon" [size]="12"></svg> Add a task to this week
            </button>

            <div class="bg-card grid h-[38px]" [class]="cols" role="row">
              <span class="text-foreground flex items-center px-3.5 font-mono text-[10px]" role="rowheader">DAY TOTAL</span>
              @for (d of days(); track d.from; let i = $index) {
                <span class="border-border text-foreground flex items-center justify-center border-l font-mono text-[11.5px] font-semibold" role="cell">
                  {{ grid().dayTotals[i] ? hm(grid().dayTotals[i]) : '' }}
                </span>
              }
              <span class="border-border text-foreground flex items-center justify-center border-l font-mono text-[12px] font-semibold" role="cell">
                {{ hm(grid().total) }}
              </span>
            </div>
          </div>
        </div>
      </div>

      <!-- the entries of one day -->
      <aside
        class="bg-card border-border w-full shrink-0 border-t px-5 py-[18px] lg:w-[340px] lg:overflow-y-auto lg:border-t-0 lg:border-l"
        aria-label="Entries of the day"
      >
        <div class="flex items-center pb-2.5 font-mono">
          <h2 class="text-foreground text-[10px] leading-[13px]">{{ railTitle() }}</h2>
          <span class="flex-1"></span>
          <span class="text-foreground text-[10.5px]">{{ railTotal() }}</span>
        </div>
        @for (e of railEntries(); track e.seg.id) {
          <div class="group border-border flex min-h-[34px] items-center gap-2.5 border-t py-2">
            <span class="text-faint w-[92px] shrink-0 font-mono text-[10.5px]">{{ range(e) }}</span>
            <span class="h-[18px] w-[3px] shrink-0" [class]="e.seg.running ? 'bg-red' : 'bg-faint'" aria-hidden="true"></span>
            @if (issueKey(e.seg.issueId); as key) {
              <a
                class="text-foreground min-w-0 truncate text-[12.5px] hover:underline hover:underline-offset-4"
                [routerLink]="['/', slug(), 'tasks', key]"
                [title]="e.seg.description"
                >{{ key }}</a
              >
            } @else {
              <span class="text-foreground min-w-0 truncate text-[12.5px]">{{ e.seg.description || 'No task' }}</span>
            }
            <span class="flex-1"></span>
            @if (e.seg.running) {
              <span class="text-red font-mono text-[9.5px]">running</span>
            } @else {
              <button
                hlmBtn
                type="button"
                variant="ghost"
                size="icon-sm"
                class="text-muted-foreground size-5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 max-lg:opacity-100"
                hlmTooltip="Delete entry"
                aria-label="Delete entry"
                [disabled]="timers.busy()"
                (click)="confirmRemove(e)"
              >
                <svg [lucideIcon]="trashIcon" [size]="12"></svg>
              </button>
            }
            <span class="text-foreground w-9 shrink-0 text-end font-mono text-[11px]">{{ hm(e.ms) }}</span>
          </div>
        } @empty {
          <p class="border-border text-muted-foreground border-t pt-3 text-[13px]">
            @if (timers.state() === 'loading') {
              Loading…
            } @else {
              No time on this day.
            }
          </p>
        }
      </aside>
    </div>
  `,
})
export class TimerPage {
  protected readonly store = inject(TramaStore);
  protected readonly timers = inject(TimeEntriesStore);
  private readonly ui = inject(UiStore);

  protected readonly cols = 'grid-cols-[minmax(240px,1fr)_repeat(7,54px)_76px]';
  protected readonly calendarIcon = LucideCalendar;
  protected readonly prevIcon = LucideChevronLeft;
  protected readonly nextIcon = LucideChevronRight;
  protected readonly subIcon = LucideCornerDownRight;
  protected readonly plusIcon = LucidePlus;
  protected readonly trashIcon = LucideTrash2;
  protected readonly hm = hm;

  protected readonly slug = computed(() => this.store.slug() ?? '');
  protected readonly composer = signal<Composer>('closed');
  protected readonly localError = signal('');
  protected readonly failure = computed(() => this.localError() || this.timers.error());
  protected readonly description = signal('');
  protected readonly projectId = signal('');
  protected readonly issueId = signal('');
  protected readonly manualDate = signal(new Date());
  protected readonly manualStart = signal('');
  protected readonly manualEnd = signal('');
  /** Weeks away from the current one (0 = this week, -1 = last week). */
  protected readonly offset = signal(0);
  /** Start of the day whose entries the rail lists; null follows today (or the week's first day). */
  protected readonly selected = signal<number | null>(null);
  protected readonly now = signal(Date.now());

  protected readonly running = computed(() => {
    const entry = this.timers.running();
    if (!entry) return null;
    return { entry, start: Date.parse(entry.startedAt) };
  });
  /** Whole days only change at midnight, so the grid is not rebuilt every second unless a timer runs. */
  private readonly dayStamp = computed(() => {
    const d = new Date(this.now());
    d.setHours(12, 0, 0, 0);
    return d.getTime();
  });
  private readonly startsOn = computed(() => WEEK_START_DAY[this.store.settings().weekStart] ?? 1);
  private readonly monday = computed(
    () => addDays(mondayOf(this.dayStamp(), this.startsOn()), 7 * this.offset()).getTime(),
  );
  protected readonly days = computed<WeekDay[]>(() => weekDays(this.monday(), this.dayStamp()));
  private readonly segs = computed(() =>
    segments(this.timers.entries(), this.running() ? this.now() : this.dayStamp()),
  );
  private readonly issuesById = computed(() => new Map(this.store.issues().map((i) => [i.id, i])));
  protected readonly grid = computed(() => buildGrid(this.segs(), this.days(), this.issuesById()));
  private readonly lastWeekTotal = computed(() => {
    const prev = weekDays(addDays(this.monday(), -7).getTime(), this.dayStamp());
    return buildGrid(this.segs(), prev, this.issuesById()).total;
  });
  protected readonly title = computed(() => weekTitle(this.monday()));
  protected readonly totalText = computed(() => hoursMinutes(this.grid().total));
  protected readonly lastWeekText = computed(() => hoursMinutes(this.lastWeekTotal()));
  protected readonly weekShare = computed(() => {
    const last = this.lastWeekTotal();
    return last ? Math.min(100, (this.grid().total / last) * 100) : this.grid().total ? 100 : 0;
  });

  protected readonly railDay = computed<WeekDay>(() => {
    const days = this.days();
    const picked = this.selected();
    return days.find((d) => d.from === picked) ?? days.find((d) => d.today) ?? days[0];
  });
  protected readonly railEntries = computed(() => entriesOnDay(this.segs(), this.railDay()));
  protected readonly railTitle = computed(() => {
    const d = this.railDay();
    return `${d.today ? 'TODAY · ' : ''}${d.label}`;
  });
  protected readonly railTotal = computed(() => hm(this.railEntries().reduce((n, e) => n + e.ms, 0)));

  protected readonly elapsed = computed(() => {
    const run = this.running();
    return run ? clock(this.now() - run.start) : '00:00:00';
  });
  protected readonly runningTitle = computed(() => {
    const entry = this.running()?.entry;
    if (!entry) return '';
    const issue = entry.issueId ? this.issuesById().get(entry.issueId) : undefined;
    return issue?.title ?? (entry.description || 'Tracking time');
  });
  protected readonly runningMeta = computed(() => {
    const entry = this.running()?.entry;
    if (!entry) return '';
    const issue = entry.issueId ? this.issuesById().get(entry.issueId) : undefined;
    const project = this.store.projects().find((p) => p.id === (entry.projectId ?? issue?.projectId));
    return [issue?.key ?? 'No task', project?.name].filter(Boolean).join(' · ');
  });

  protected readonly projectChoices = computed<Option[]>(() => [
    { value: '', label: 'No project' },
    ...this.store.projects().map((project) => ({ value: project.id, label: project.name })),
  ]);
  protected readonly issueChoices = computed<Option[]>(() => {
    const projectId = this.projectId();
    return [
      { value: '', label: 'No task' },
      ...this.store
        .issues()
        .filter((issue) => !projectId || issue.projectId === projectId)
        .map((issue) => ({ value: issue.id, label: issue.title, hint: issue.key })),
    ];
  });

  constructor() {
    const tick = setInterval(() => this.now.set(Date.now()), 1000);
    inject(DestroyRef).onDestroy(() => clearInterval(tick));
    effect(() => {
      if (!this.slug() || !this.store.ready()) return;
      untracked(() => void this.timers.load());
    });
    usePageShortcuts([
      { keys: 't', label: 'Start or stop the timer', run: () => this.toggle() },
      { keys: 'shift+t', label: 'Switch task', run: () => this.open('start') },
      { keys: 'l', label: 'Log time', run: () => this.open('log') },
      { keys: 'e', label: 'Export the week as CSV', run: () => this.exportWeek() },
    ]);
  }

  protected today(): Date {
    return new Date();
  }

  protected shift(by: number): void {
    this.offset.update((n) => n + by);
    this.selected.set(null);
  }

  protected issueKey(id: string | null): string {
    return (id && this.issuesById().get(id)?.key) || '';
  }

  protected range(e: DayEntry): string {
    return `${format(e.from, 'HH:mm')}–${e.seg.running ? 'now' : format(e.to, 'HH:mm')}`;
  }

  protected selectProject(id: string): void {
    this.projectId.set(id);
    if (!this.issueChoices().some((issue) => issue.value === this.issueId())) this.issueId.set('');
  }

  protected open(mode: Exclude<Composer, 'closed'>): void {
    this.localError.set('');
    if (mode === 'log') {
      const day = this.railDay();
      this.manualDate.set(day.future ? new Date() : new Date(day.from));
    }
    this.composer.set(mode);
  }

  /** T: stop what runs, or start (asking for the task first when the form is closed). */
  protected toggle(): void {
    if (this.running()) void this.timers.stop();
    else this.startOrOpen();
  }

  protected startOrOpen(): void {
    if (this.composer() === 'start') void this.start();
    else this.open('start');
  }

  private target() {
    return {
      description: this.description().trim(),
      projectId: this.projectId() || null,
      issueId: this.issueId() || null,
    };
  }

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    if (this.composer() === 'log') await this.addManual();
    else await this.start();
  }

  private async start(): Promise<void> {
    this.localError.set('');
    if (await this.timers.start(this.target())) {
      this.description.set('');
      this.composer.set('closed');
      this.offset.set(0);
      this.selected.set(null);
    }
  }

  private async addManual(): Promise<void> {
    const day = this.manualDate();
    const problem = entryProblem(day, this.manualStart(), this.manualEnd(), Date.now());
    if (problem) {
      this.localError.set(problem);
      return;
    }
    this.localError.set('');
    const ok = await this.timers.add({
      ...this.target(),
      startedAt: atTime(day, this.manualStart()).toISOString(),
      endedAt: atTime(day, this.manualEnd()).toISOString(),
    });
    if (ok) {
      this.manualStart.set('');
      this.manualEnd.set('');
      this.composer.set('closed');
      this.description.set('');
    }
  }

  protected confirmRemove(e: DayEntry): void {
    this.ui.setConfirmDelete({
      title: 'Delete this time entry?',
      description: `${hoursMinutes(e.ms)} of tracked time is removed. This cannot be undone.`,
      onConfirm: () => void this.timers.remove(e.seg.id),
    });
  }

  /** The week's entries as a CSV file: one line per entry (a running timer counts up to now). */
  protected exportWeek(): void {
    const days = this.days();
    const from = days[0].from;
    const to = days[days.length - 1].to;
    const rows: (string | number)[][] = [['Date', 'Start', 'End', 'Hours', 'Task', 'Title', 'Project', 'Description']];
    for (const seg of this.segs().filter((s) => s.end > from && s.start < to).sort((a, b) => a.start - b.start)) {
      const issue = seg.issueId ? this.issuesById().get(seg.issueId) : undefined;
      const project = this.store.projects().find((p) => p.id === (seg.projectId ?? issue?.projectId));
      rows.push([
        format(seg.start, 'yyyy-MM-dd'),
        format(seg.start, 'HH:mm'),
        seg.running ? '' : format(seg.end, 'HH:mm'),
        Number(((seg.end - seg.start) / HOUR).toFixed(2)),
        issue?.key ?? '',
        issue?.title ?? '',
        project?.name ?? '',
        seg.description,
      ]);
    }
    downloadText(`time-${format(from, 'yyyy-MM-dd')}.csv`, toCsv(rows));
  }
}
