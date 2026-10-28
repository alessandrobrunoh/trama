import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { ApiClient } from '../../core/api/api-client';
import { ApiError } from '../../core/api/api-error';
import type { LunaGestIssueApplicable, LunaGestRemoteTask } from '../../core/api/api.types';
import { TramaStore } from '../../core/stores/trama.store';

const SELECT =
  'border-border bg-background h-8 min-w-0 flex-1 rounded-md border px-2 text-[13px]';

/**
 * Sidebar card for an issue on a LunaGest-linked project.
 * Push creates or updates the remote task. A failure stays on this issue.
 */
@Component({
  selector: 'app-issue-lunagest',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButtonImports],
  host: { class: 'bg-card border-border block rounded-lg border' },
  template: `
    @if (link(); as current) {
      <div class="flex items-center gap-1.5 px-3 pt-2.5 pb-1">
        <h3 class="text-muted-foreground text-xs font-medium">LunaGest</h3>
      </div>
      <div class="flex flex-col gap-2 px-3 py-2">
        <p class="text-[13px]">
          @switch (current.state) {
            @case ('linked') {
              Linked<span class="text-muted-foreground"> · {{ current.remoteTaskId }}</span>
            }
            @case ('push_failed') {
              Not on LunaGest
            }
            @default {
              Not linked
            }
          }
        </p>
        @if (current.lastError) {
          <p class="text-destructive text-[13px]" role="alert">{{ current.lastError }}</p>
        }
        @if (current.state !== 'linked') {
          <div class="flex flex-wrap items-center gap-2">
            <button hlmBtn type="button" size="sm" [disabled]="busy()" (click)="push()">
              {{ current.remoteTaskId ? 'Retry push' : 'Create on LunaGest' }}
            </button>
          </div>
          @if (tasksLoading()) {
            <p class="text-muted-foreground text-[13px]">Loading tasks…</p>
          } @else if (!tasksError()) {
            <div class="flex flex-wrap items-center gap-2">
              <select
                [class]="select"
                aria-label="LunaGest task"
                [value]="remoteTaskId()"
                (change)="remoteTaskId.set($any($event.target).value)"
              >
                <option value="">Link an existing task</option>
                @for (task of tasks(); track task.id) {
                  <option [value]="task.id">{{ task.title }}</option>
                }
              </select>
              <button
                hlmBtn
                type="button"
                size="sm"
                variant="outline"
                [disabled]="!remoteTaskId() || busy()"
                (click)="linkExisting()"
              >
                Link
              </button>
            </div>
          }
        }
        @if (tasksError(); as message) {
          <p class="text-destructive text-[13px]" role="alert">{{ message }}</p>
        }
        @if (actionError(); as message) {
          <p class="text-destructive text-[13px]" role="alert">{{ message }}</p>
        }
      </div>
    }
  `,
})
export class IssueLunagest {
  private readonly store = inject(TramaStore);
  private readonly api = inject(ApiClient);

  readonly issueId = input.required<string>();

  protected readonly select = SELECT;
  protected readonly busy = signal(false);
  protected readonly tasksLoading = signal(false);
  protected readonly tasksError = signal('');
  protected readonly actionError = signal('');
  protected readonly link = signal<LunaGestIssueApplicable | null>(null);
  protected readonly tasks = signal<LunaGestRemoteTask[]>([]);
  protected readonly remoteTaskId = signal('');
  private readonly slug = computed(() => this.store.slug() ?? '');

  constructor() {
    effect(() => {
      const slug = this.slug();
      const issueId = this.issueId();
      if (!slug || !issueId || !this.store.ready()) return;
      untracked(() => void this.load(slug, issueId));
    });
  }

  private async load(slug: string, issueId: string): Promise<void> {
    this.actionError.set('');
    this.tasksError.set('');
    try {
      const link = await this.api.lunagest.issue(slug, issueId, { quiet: true });
      if (!link.applicable) {
        this.link.set(null);
        this.tasks.set([]);
        return;
      }
      this.link.set(link);
      if (link.state !== 'linked') void this.loadTasks(slug, issueId);
    } catch (e) {
      this.link.set(null);
      this.actionError.set(ApiError.from(e).message);
    }
  }

  private async loadTasks(slug: string, issueId: string): Promise<void> {
    this.tasksLoading.set(true);
    this.tasksError.set('');
    try {
      this.tasks.set(await this.api.lunagest.remoteTasks(slug, issueId, { quiet: true }));
    } catch (e) {
      this.tasks.set([]);
      this.tasksError.set(ApiError.from(e).message);
    } finally {
      this.tasksLoading.set(false);
    }
  }

  protected async push(): Promise<void> {
    const slug = this.slug();
    if (!slug || this.busy()) return;
    this.busy.set(true);
    this.actionError.set('');
    try {
      const link = await this.api.lunagest.pushIssue(slug, this.issueId(), { quiet: true });
      this.link.set(link.applicable ? link : null);
    } catch (e) {
      this.actionError.set(ApiError.from(e).message);
    } finally {
      this.busy.set(false);
    }
  }

  protected async linkExisting(): Promise<void> {
    const slug = this.slug();
    const remoteTaskId = this.remoteTaskId();
    if (!slug || !remoteTaskId || this.busy()) return;
    this.busy.set(true);
    this.actionError.set('');
    try {
      const link = await this.api.lunagest.linkIssue(slug, this.issueId(), { remoteTaskId }, { quiet: true });
      this.link.set(link.applicable ? link : null);
      this.remoteTaskId.set('');
    } catch (e) {
      this.actionError.set(ApiError.from(e).message);
    } finally {
      this.busy.set(false);
    }
  }
}
