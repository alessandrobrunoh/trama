import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { ApiClient } from '../../core/api/api-client';
import { ApiError } from '../../core/api/api-error';
import type { TimeEntry } from '../../core/api/api.types';
import { TramaStore } from '../../core/stores/trama.store';
import { PageHeader } from '../../shared/page-header';

const SELECT =
  'border-border bg-background h-8 min-w-0 rounded-md border px-2 text-[13px]';

function formatSpan(startedAt: string, endedAt: string | null, now: number): string {
  const end = endedAt ? new Date(endedAt).getTime() : now;
  const total = Math.max(0, Math.floor((end - new Date(startedAt).getTime()) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

/** Start, stop, or add your own time. Hours are not sent to LunaGest. */
@Component({
  selector: 'app-timer-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, HlmButtonImports, HlmInputImports, PageHeader],
  host: { class: 'flex h-full min-h-0 flex-col' },
  template: `
    <app-page-header
      title="Timer"
      description="Your time stays in Trama. It is not sent to LunaGest."
    />
    <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4 sm:px-6">
      @if (error(); as message) {
        <p class="text-destructive text-[13px]" role="alert">{{ message }}</p>
      }
      <div class="flex flex-wrap items-center gap-2">
        <input
          hlmInput
          class="h-8 min-w-48 flex-1 text-[13px]"
          placeholder="What are you working on?"
          aria-label="Description"
          [value]="description()"
          (input)="description.set($any($event.target).value)"
        />
        <select
          [class]="select"
          aria-label="Project"
          [value]="projectId()"
          (change)="projectId.set($any($event.target).value)"
        >
          <option value="">No project</option>
          @for (project of store.projects(); track project.id) {
            <option [value]="project.id">{{ project.name }}</option>
          }
        </select>
        <select
          [class]="select"
          aria-label="Issue"
          [value]="issueId()"
          (change)="issueId.set($any($event.target).value)"
        >
          <option value="">No issue</option>
          @for (issue of issueChoices(); track issue.id) {
            <option [value]="issue.id">{{ issue.key }} {{ issue.title }}</option>
          }
        </select>
        @if (running(); as current) {
          <span class="text-[13px] tabular-nums">{{ span(current) }}</span>
          <button hlmBtn type="button" size="sm" [disabled]="busy()" (click)="stop()">Stop</button>
        } @else {
          <button hlmBtn type="button" size="sm" [disabled]="busy()" (click)="start()">Start</button>
        }
      </div>

      <form class="flex flex-wrap items-end gap-2" (submit)="addManual($event)">
        <label class="flex flex-col gap-1 text-[13px]">
          Start
          <input
            hlmInput
            class="h-8 text-[13px]"
            type="datetime-local"
            [value]="manualStart()"
            (input)="manualStart.set($any($event.target).value)"
          />
        </label>
        <label class="flex flex-col gap-1 text-[13px]">
          End
          <input
            hlmInput
            class="h-8 text-[13px]"
            type="datetime-local"
            [value]="manualEnd()"
            (input)="manualEnd.set($any($event.target).value)"
          />
        </label>
        <button hlmBtn type="submit" size="sm" variant="outline" [disabled]="busy()">Add</button>
      </form>

      @if (loading()) {
        <p class="text-muted-foreground text-[13px]">Loading…</p>
      } @else if (!entries().length) {
        <p class="text-muted-foreground text-[13px]">No time yet.</p>
      } @else {
        <ul class="flex flex-col divide-y">
          @for (entry of entries(); track entry.id) {
            <li class="flex flex-wrap items-center gap-2 py-2 text-[13px]">
              <span class="min-w-24 tabular-nums">{{ span(entry) }}</span>
              <span class="min-w-0 flex-1 truncate">{{ entry.description || 'No description' }}</span>
              @if (entry.issueId) {
                <a
                  class="text-primary hover:underline"
                  [routerLink]="['/', slug(), 'issues', issueKey(entry.issueId)]"
                  >{{ issueKey(entry.issueId) }}</a
                >
              }
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
    </div>
  `,
})
export class TimerPage {
  private readonly api = inject(ApiClient);
  protected readonly store = inject(TramaStore);

  protected readonly select = SELECT;
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
  protected readonly issueChoices = computed(() => {
    const projectId = this.projectId();
    const issues = this.store.issues();
    return projectId ? issues.filter((issue) => issue.projectId === projectId) : issues;
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
