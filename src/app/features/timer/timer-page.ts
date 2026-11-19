import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { LucideCalendar, LucideDynamicIcon, LucidePlay, LucideSquare, LucideTrash2 } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import { ApiClient } from '../../core/api/api-client';
import { ApiError } from '../../core/api/api-error';
import type { TimeEntry } from '../../core/api/api.types';
import { TramaStore } from '../../core/stores/trama.store';
import { AppSelect, type Option } from '../../shared/app-select';
import { DatePicker } from '../../shared/date-picker';
import { PageHeader } from '../../shared/page-header';

function formatSpan(startedAt: string, endedAt: string | null, now: number): string {
  const end = endedAt ? new Date(endedAt).getTime() : now;
  const total = Math.max(0, Math.floor((end - new Date(startedAt).getTime()) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return [hours, minutes, seconds].map((unit) => String(unit).padStart(2, '0')).join(':');
}

/** `date` (any time of day) at `HH:MM`, in the local time zone. */
function at(date: Date, time: string): Date {
  const [h, m] = time.split(':').map(Number);
  const out = new Date(date);
  out.setHours(h, m, 0, 0);
  return out;
}

/** Start, stop, or add your own time. */
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
    AppSelect,
    DatePicker,
  ],
  host: { class: 'flex h-full min-h-0 flex-col' },
  template: `
    <app-page-header
      title="Timer"
      description="Track your own time on tasks. Statistics use it to compare your estimates with the time you spent."
    />
    <div class="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6 sm:py-6">
      <div class="mx-auto grid max-w-3xl gap-6">
        @if (error(); as message) {
          <p class="bg-destructive/10 text-destructive rounded-lg px-4 py-3 text-sm" role="alert">{{ message }}</p>
        }

        <section class="bg-card rounded-lg p-4 sm:p-5" aria-labelledby="live-timer">
          <div class="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
            <div class="min-w-0">
              <h2 id="live-timer" class="text-meta">{{ running() ? 'Running' : 'Ready' }}</h2>
              <p class="mt-1 font-mono text-4xl font-semibold tracking-tight tabular-nums sm:text-5xl" role="timer">
                {{ running() ? span(running()!) : '00:00:00' }}
              </p>
              <p class="text-muted-foreground mt-1.5 text-sm break-words">
                {{ running() ? (running()?.description || 'Tracking time') : 'Pick a task, then start the timer.' }}
              </p>
            </div>
            @if (running()) {
              <button hlmBtn type="button" variant="outline" [disabled]="busy()" (click)="stop()">
                <svg [lucideIcon]="stopIcon" [size]="14"></svg> Stop
              </button>
            } @else {
              <button hlmBtn type="button" [disabled]="busy() || loading()" (click)="start()">
                <svg [lucideIcon]="playIcon" [size]="14"></svg> Start timer
              </button>
            }
          </div>
          <div class="mt-4 grid gap-3 sm:grid-cols-2">
            <div class="grid gap-1.5 sm:col-span-2">
              <label for="timer-description" class="text-meta">Description</label>
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
              <label for="timer-project" class="text-meta">Project</label>
              <app-select controlId="timer-project" [options]="projectChoices()"
                [value]="projectId()" (valueChange)="selectProject($event)" />
            </div>
            <div class="grid min-w-0 gap-1.5">
              <label for="timer-issue" class="text-meta">Task</label>
              <app-select controlId="timer-issue" [options]="issueChoices()" [(value)]="issueId" />
            </div>
          </div>
        </section>

        <section aria-labelledby="manual-entry">
          <h2 id="manual-entry" class="text-sm font-medium">Log time manually</h2>
          <p class="text-meta mt-0.5">Add a past session. It uses the description, project and task above.</p>
          <form class="mt-3 flex flex-wrap items-end gap-3" (submit)="addManual($event)">
            <div class="grid gap-1.5">
              <span class="text-meta" id="manual-date-label">Day</span>
              <app-date-picker
                label="Day of the session"
                triggerClass="border-input h-8 gap-2 border px-2.5 text-sm"
                [value]="manualDate().toISOString()"
                (dateChange)="manualDate.set($event ?? today())"
              >
                <svg [lucideIcon]="calendarIcon" [size]="13" class="text-muted-foreground"></svg>
                <span>{{ manualDate() | date: 'EEE, MMM d' }}</span>
              </app-date-picker>
            </div>
            <div class="grid gap-1.5">
              <label for="manual-start" class="text-meta">From</label>
              <input id="manual-start" hlmInput class="h-8 w-28" type="time" required
                [value]="manualStart()" (input)="manualStart.set($any($event.target).value)" />
            </div>
            <div class="grid gap-1.5">
              <label for="manual-end" class="text-meta">To</label>
              <input id="manual-end" hlmInput class="h-8 w-28" type="time" required
                [value]="manualEnd()" (input)="manualEnd.set($any($event.target).value)" />
            </div>
            <button hlmBtn type="submit" variant="outline" [disabled]="busy() || !manualStart() || !manualEnd()">Add entry</button>
          </form>
        </section>

        <section aria-labelledby="time-history">
          <div class="flex items-center justify-between gap-3">
            <h2 id="time-history" class="text-sm font-medium">Time history</h2>
            <span class="text-meta tabular-nums">{{ entries().length }} {{ entries().length === 1 ? 'entry' : 'entries' }}</span>
          </div>
          @if (loading()) {
            <p class="text-muted-foreground py-6 text-sm" role="status">Loading time entries…</p>
          } @else if (!entries().length) {
            <div class="bg-muted mt-3 rounded-lg px-5 py-8 text-center">
              <p class="text-sm font-medium">No time logged yet</p>
              <p class="text-muted-foreground mt-1 text-xs">Start the timer or add a past session to build your history.</p>
            </div>
          } @else {
            <ul class="mt-2 flex flex-col">
              @for (entry of entries(); track entry.id) {
                <li class="hover:bg-hover -mx-2 flex min-h-10 flex-wrap items-center gap-x-4 gap-y-1 rounded-md px-2 py-1.5 text-sm">
                  <div class="min-w-0 flex-1 basis-40">
                    <p class="truncate">{{ entry.description || 'Untitled session' }}</p>
                    <p class="text-meta">{{ entry.startedAt | date: 'MMM d, h:mm a' }}</p>
                  </div>
                  @if (entry.issueId) {
                    <a
                      class="text-muted-foreground hover:text-foreground font-mono text-xs"
                      [routerLink]="['/', slug(), 'tasks', issueKey(entry.issueId)]"
                      >{{ issueKey(entry.issueId) }}</a
                    >
                  }
                  @if (!entry.endedAt) {
                    <span class="bg-primary/10 text-primary rounded-full px-2 py-0.5 text-xs">Running</span>
                  }
                  <span class="font-mono text-xs tabular-nums">{{ span(entry) }}</span>
                  <button
                    hlmBtn
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    class="text-muted-foreground"
                    hlmTooltip="Delete entry"
                    aria-label="Delete entry"
                    [disabled]="busy()"
                    (click)="remove(entry.id)"
                  >
                    <svg [lucideIcon]="trashIcon" [size]="14"></svg>
                  </button>
                </li>
              }
            </ul>
          }
        </section>
      </div>
    </div>
  `,
})
export class TimerPage {
  private readonly api = inject(ApiClient);
  protected readonly store = inject(TramaStore);

  protected readonly playIcon = LucidePlay;
  protected readonly stopIcon = LucideSquare;
  protected readonly trashIcon = LucideTrash2;
  protected readonly calendarIcon = LucideCalendar;

  protected readonly slug = computed(() => this.store.slug() ?? '');
  protected readonly loading = signal(true);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly entries = signal<TimeEntry[]>([]);
  protected readonly description = signal('');
  protected readonly projectId = signal('');
  protected readonly issueId = signal('');
  protected readonly manualDate = signal(new Date());
  protected readonly manualStart = signal('');
  protected readonly manualEnd = signal('');
  protected readonly now = signal(Date.now());
  protected readonly running = computed(() => this.entries().find((entry) => !entry.endedAt) ?? null);
  protected readonly projectChoices = computed<Option[]>(() => [
    { value: '', label: 'No project' },
    ...this.store.projects().map((project) => ({ value: project.id, label: project.name })),
  ]);
  protected readonly issueChoices = computed<Option[]>(() => {
    const projectId = this.projectId();
    return [
      { value: '', label: 'No task' },
      ...this.store.issues()
        .filter((issue) => !projectId || issue.projectId === projectId)
        .map((issue) => ({ value: issue.id, label: issue.title, hint: issue.key })),
    ];
  });

  constructor() {
    const timer = setInterval(() => this.now.set(Date.now()), 1000);
    effect((onCleanup) => onCleanup(() => clearInterval(timer)));
    effect(() => {
      const slug = this.slug();
      if (!slug || !this.store.ready()) return;
      untracked(() => void this.load(slug));
    });
  }

  protected today(): Date {
    return new Date();
  }

  protected span(entry: TimeEntry): string {
    return formatSpan(entry.startedAt, entry.endedAt, this.now());
  }

  protected selectProject(id: string): void {
    this.projectId.set(id);
    if (!this.issueChoices().some((issue) => issue.value === this.issueId())) {
      this.issueId.set('');
    }
  }

  protected issueKey(id: string): string {
    return this.store.issues().find((issue) => issue.id === id)?.key ?? id;
  }

  private target() {
    return {
      description: this.description().trim(),
      projectId: this.projectId() || null,
      issueId: this.issueId() || null,
    };
  }

  private async load(slug: string): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    try {
      this.entries.set(await this.api.timeEntries.list(slug, { quiet: true }));
    } catch (e) {
      this.error.set(ApiError.from(e).message);
    } finally {
      this.loading.set(false);
    }
  }

  protected async start(): Promise<void> {
    const slug = this.slug();
    if (!slug || this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      await this.api.timeEntries.start(slug, this.target(), { quiet: true });
      await this.load(slug);
    } catch (e) {
      this.error.set(ApiError.from(e).message);
    } finally {
      this.busy.set(false);
    }
  }

  protected async stop(): Promise<void> {
    const slug = this.slug();
    if (!slug || this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      await this.api.timeEntries.stop(slug, { quiet: true });
      await this.load(slug);
    } catch (e) {
      this.error.set(ApiError.from(e).message);
    } finally {
      this.busy.set(false);
    }
  }

  protected async addManual(event: Event): Promise<void> {
    event.preventDefault();
    const slug = this.slug();
    if (!slug || !this.manualStart() || !this.manualEnd() || this.busy()) return;
    const startedAt = at(this.manualDate(), this.manualStart());
    const endedAt = at(this.manualDate(), this.manualEnd());
    if (endedAt <= startedAt) {
      this.error.set('The end time must be after the start time.');
      return;
    }
    this.busy.set(true);
    this.error.set('');
    try {
      await this.api.timeEntries.add(
        slug,
        { ...this.target(), startedAt: startedAt.toISOString(), endedAt: endedAt.toISOString() },
        { quiet: true },
      );
      this.manualStart.set('');
      this.manualEnd.set('');
      await this.load(slug);
    } catch (e) {
      this.error.set(ApiError.from(e).message);
    } finally {
      this.busy.set(false);
    }
  }

  protected async remove(id: string): Promise<void> {
    const slug = this.slug();
    if (!slug || this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      await this.api.timeEntries.remove(slug, id, { quiet: true });
      this.entries.update((entries) => entries.filter((entry) => entry.id !== id));
    } catch (e) {
      this.error.set(ApiError.from(e).message);
    } finally {
      this.busy.set(false);
    }
  }
}
