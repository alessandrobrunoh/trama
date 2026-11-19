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
import { AppSelect, type Option } from '../create/form-kit';
import { IssueSection } from './issue-section';

/**
 * Collapsed inspector group for an issue on a LunaGest-linked project.
 * Push creates or updates the remote task. A failure stays on this issue.
 */
@Component({
  selector: 'app-issue-lunagest',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButtonImports, AppSelect, IssueSection],
  host: { class: 'block' },
  template: `
    @if (link(); as current) {
      <app-issue-section label="LunaGest" [summary]="stateLabel()" [open]="!!current.lastError">
        <div class="flex flex-col gap-2 px-1 py-1">
          @if (current.state === 'linked') {
            <p class="text-muted-foreground text-xs">Remote task {{ current.remoteTaskId }}</p>
          }
          @if (current.lastError) {
            <p class="text-destructive text-xs" role="alert">{{ current.lastError }}</p>
          }
          @if (current.state !== 'linked') {
            <button hlmBtn type="button" size="sm" class="w-full" [disabled]="busy()" (click)="push()">
              {{ current.remoteTaskId ? 'Retry push' : 'Create on LunaGest' }}
            </button>
            @if (tasksLoading()) {
              <p class="text-muted-foreground text-xs">Loading tasks…</p>
            } @else if (!tasksError()) {
              <div class="flex items-center gap-1.5">
                <app-select
                  class="min-w-0 flex-1"
                  size="sm"
                  label="LunaGest task"
                  placeholder="Link an existing task"
                  [options]="taskOptions()"
                  [(value)]="remoteTaskId"
                />
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
            <p class="text-destructive text-xs" role="alert">{{ message }}</p>
          }
          @if (actionError(); as message) {
            <p class="text-destructive text-xs" role="alert">{{ message }}</p>
          }
        </div>
      </app-issue-section>
    }
  `,
})
export class IssueLunagest {
  private readonly store = inject(TramaStore);
  private readonly api = inject(ApiClient);

  readonly issueId = input.required<string>();

  protected readonly busy = signal(false);
  protected readonly tasksLoading = signal(false);
  protected readonly tasksError = signal('');
  protected readonly actionError = signal('');
  protected readonly link = signal<LunaGestIssueApplicable | null>(null);
  protected readonly tasks = signal<LunaGestRemoteTask[]>([]);
  protected readonly remoteTaskId = signal('');
  private readonly slug = computed(() => this.store.slug() ?? '');
  protected readonly taskOptions = computed<Option[]>(() =>
    this.tasks().map((task) => ({ value: task.id, label: task.title })),
  );
  /** One word for the collapsed header. */
  protected readonly stateLabel = computed(() => {
    switch (this.link()?.state) {
      case 'linked':
        return 'Linked';
      case 'push_failed':
        return 'Not pushed';
      default:
        return 'Not linked';
    }
  });

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
