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
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { ApiClient } from '../../core/api/api-client';
import { ApiError } from '../../core/api/api-error';
import type { TimeEntry } from '../../core/api/api.types';
import { TramaStore } from '../../core/stores/trama.store';
import { AppSelect, type Option } from '../../shared/app-select';
import { PageHeader } from '../../shared/page-header';

function formatSpan(startedAt: string, endedAt: string | null, now: number): string {
  const end = endedAt ? new Date(endedAt).getTime() : now;
  const total = Math.max(0, Math.floor((end - new Date(startedAt).getTime()) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return [hours, minutes, seconds].map((unit) => String(unit).padStart(2, '0')).join(':');
}

/** Start, stop, or add your own time. Hours are not sent to LunaGest. */
@Component({
  selector: 'app-timer-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, RouterLink, HlmButtonImports, HlmInputImports, PageHeader, AppSelect],
  host: { class: 'flex h-full min-h-0 flex-col' },
  template: `
    <app-page-header
      title="Timer"
      description="Your time stays in Trama. It is not sent to LunaGest."
    />
    <div class="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6 sm:py-8">
      <div class="mx-auto grid max-w-5xl gap-5">
      @if (error(); as message) {
        <p class="border-destructive/25 bg-destructive/5 text-destructive rounded-lg border px-4 py-3 text-sm" role="alert">{{ message }}</p>
      }
      <section class="bg-card overflow-hidden rounded-xl border" aria-labelledby="live-timer">
        <div class="from-primary/10 via-muted/40 to-card grid gap-5 bg-linear-to-br px-5 py-6 sm:grid-cols-[1fr_auto] sm:items-center sm:px-7">
          <div class="min-w-0">
            <h2 id="live-timer" class="text-muted-foreground text-xs font-semibold tracking-wider uppercase">Live timer</h2>
            <p class="mt-2 font-mono text-4xl font-semibold tracking-tight tabular-nums sm:text-5xl" role="timer">
              {{ running() ? span(running()!) : '00:00:00' }}
            </p>
            <p class="text-muted-foreground mt-2 break-words text-sm">
              {{ running() ? (running()?.description || 'Tracking time') : 'Ready to track your next session.' }}
            </p>
          </div>
          @if (running()) {
            <button hlmBtn type="button" [disabled]="busy()" (click)="stop()">Stop timer</button>
          } @else {
            <button hlmBtn type="button" [disabled]="busy() || loading()" (click)="start()">Start timer</button>
          }
        </div>
        <div class="grid gap-4 border-t p-5 sm:grid-cols-2 sm:p-7">
          <label class="grid gap-1.5 text-sm font-medium sm:col-span-2">
            Description
        <input
          hlmInput
          class="w-full"
          placeholder="What are you working on?"
          [value]="description()"
          (input)="description.set($any($event.target).value)"
        />
          </label>
          <div class="grid min-w-0 gap-1.5">
            <label for="timer-project" class="text-sm font-medium">Project</label>
            <app-select controlId="timer-project" [options]="projectChoices()"
              [value]="projectId()" (valueChange)="selectProject($event)" />
          </div>
          <div class="grid min-w-0 gap-1.5">
            <label for="timer-issue" class="text-sm font-medium">Task</label>
            <app-select controlId="timer-issue" [options]="issueChoices()" [(value)]="issueId" />
          </div>
        </div>
      </section>

      <section class="bg-card rounded-xl border p-5 sm:p-7" aria-labelledby="manual-entry">
        <h2 id="manual-entry" class="font-semibold">Log time manually</h2>
        <p class="text-muted-foreground mt-1 text-sm">Add a past session using the description, project, and task above.</p>
      <form class="mt-4 grid items-end gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]" (submit)="addManual($event)">
        <label class="flex flex-col gap-1 text-[13px]">
          Start
          <input
            hlmInput
            class="min-w-0 w-full"
            type="datetime-local"
            required
            [value]="manualStart()"
            (input)="manualStart.set($any($event.target).value)"
          />
        </label>
        <label class="flex flex-col gap-1 text-[13px]">
          End
          <input
            hlmInput
            class="min-w-0 w-full"
            type="datetime-local"
            required
            [value]="manualEnd()"
            (input)="manualEnd.set($any($event.target).value)"
          />
        </label>
        <button hlmBtn type="submit" variant="outline" [disabled]="busy()">Add entry</button>
      </form>
      </section>

      <section class="bg-card rounded-xl border" aria-labelledby="time-history">
      <div class="flex items-center justify-between gap-3 border-b px-5 py-4 sm:px-7">
        <h2 id="time-history" class="font-semibold">Time history</h2>
        <span class="bg-muted text-muted-foreground rounded-full px-2.5 py-1 text-xs">{{ entries().length }} entries</span>
      </div>
      @if (loading()) {
        <p class="text-muted-foreground p-6 text-sm" role="status">Loading time entries…</p>
      } @else if (!entries().length) {
        <div class="px-5 py-10 text-center">
          <p class="font-medium">No time logged yet</p>
          <p class="text-muted-foreground mt-1 text-sm">Start the timer or add a past session to build your history.</p>
        </div>
      } @else {
        <ul class="flex flex-col divide-y">
          @for (entry of entries(); track entry.id) {
            <li class="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3 text-sm sm:px-7">
              <div class="min-w-0 flex-1 basis-40">
                <p class="truncate font-medium">{{ entry.description || 'Untitled session' }}</p>
                <p class="text-muted-foreground mt-0.5 text-xs">{{ entry.startedAt | date:'medium' }}</p>
              </div>
              @if (entry.issueId) {
                <a
                  class="text-primary hover:underline"
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
                size="sm"
                variant="ghost"
                [disabled]="busy()"
                (click)="remove(entry.id)"
              >
                Delete
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

  protected readonly slug = computed(() => this.store.slug() ?? '');
  protected readonly loading = signal(true);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly entries = signal<TimeEntry[]>([]);
  protected readonly description = signal('');
  protected readonly projectId = signal('');
  protected readonly issueId = signal('');
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
    const startedAt = this.manualStart();
    const endedAt = this.manualEnd();
    if (!slug || !startedAt || !endedAt || this.busy()) return;
    if (new Date(endedAt) <= new Date(startedAt)) {
      this.error.set('End time must be after start time.');
      return;
    }
    this.busy.set(true);
    this.error.set('');
    try {
      await this.api.timeEntries.add(
        slug,
        {
          ...this.target(),
          startedAt: new Date(startedAt).toISOString(),
          endedAt: new Date(endedAt).toISOString(),
        },
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
