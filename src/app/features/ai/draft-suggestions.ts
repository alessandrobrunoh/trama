import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  LucideChevronDown,
  LucideCircleHelp,
  LucideDynamicIcon,
  LucidePlus,
  LucideSparkles,
  LucideX,
} from '@lucide/angular';
import { HlmSpinner } from '@spartan-ng/helm/spinner';
import { ISSUE_KIND_META, ISSUE_KINDS, PRIORITIES, PRIORITY_META } from '../../core/meta';
import { estimateOptions } from '../../core/estimates';
import {
  AiApi,
  type AiDraft,
  type AiIssueDraftOptions,
  type AiIssueDraftSuggestion,
  type AiSuggestion,
} from '../../core/ai/ai-api';
import { AssistantStore } from '../../core/ai/assistant.store';
import { TramaStore } from '../../core/stores/trama.store';
import { rankByOverlap } from '../ai-actions/similar';
import { localTriage } from './local-triage';

const minimumDraftLength = 10;
const suggestionDebounceMs = 900;

@Component({
  selector: 'app-draft-suggestions',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmSpinner, LucideDynamicIcon, RouterLink],
  template: `
    <div class="flex flex-col gap-1.5" aria-live="polite">
      <div class="flex min-h-7 flex-wrap items-center gap-1.5">
        <span class="text-muted-foreground flex shrink-0 items-center gap-1.5 pr-1 text-[13px]">
          @if (busy()) {
            <hlm-spinner class="size-3.5" /> Thinking…
          } @else {
            <svg [lucideIcon]="sparkles" [size]="14" aria-hidden="true"></svg>
            Quick suggestions
          }
        </span>
        @if (suggestion(); as proposed) {
          @if (!usedTitle() && proposed.title.trim() && proposed.title.trim() !== title().trim()) {
            <button
              type="button"
              class="pill"
              [disabled]="disabled()"
              [title]="proposed.title"
              (click)="applyTitle(proposed.title)"
            >
              <span class="text-muted-foreground">Title</span>
              <span class="max-w-48 truncate font-medium">{{ proposed.title }}</span>
            </button>
          }
          @if (
            !usedDescription() &&
            proposed.description.trim() &&
            proposed.description.trim() !== description().trim()
          ) {
            <button
              type="button"
              class="pill"
              [disabled]="disabled()"
              [title]="proposed.description"
              (click)="applyDescription(proposed.description)"
            >
              <span class="text-muted-foreground">Description</span>
              <span class="max-w-40 truncate font-medium">{{ proposed.description }}</span>
            </button>
          }
        }
        @for (item of visibleTriage(); track item.field + ':' + item.value) {
          <button
            type="button"
            class="pill"
            [disabled]="disabled()"
            [attr.aria-label]="
              'Use suggested ' + fieldLabel(item.field) + ': ' + displayValue(item)
            "
            [title]="item.why || fieldLabel(item.field)"
            (click)="applySuggestion(item)"
          >
            <span class="bg-primary size-1.5 shrink-0 rounded-full"></span>
            <span class="text-muted-foreground">{{ fieldLabel(item.field) }}</span>
            <span class="max-w-40 truncate font-medium">{{ displayValue(item) }}</span>
          </button>
        }
        @if (!busy() && !suggestion() && !visibleTriage().length) {
          @if (!ai.ready() && !ai.loadingStatus()) {
            <a
              [routerLink]="['/', ai.slug(), 'settings', 'ai']"
              class="text-muted-foreground text-xs underline underline-offset-2"
              (click)="settingsRequested.emit()"
              >Enable AI suggestions in Settings</a
            >
          } @else if (title().trim().length + description().trim().length < minimumDraftLength) {
            <span class="text-muted-foreground/80 text-xs">Appear as you add details</span>
          }
        }
      </div>
      @if (error()) {
        <p class="text-destructive text-xs" role="alert">{{ error() }}</p>
      }
      @if (openQuestions().length) {
        <div class="rounded-md border bg-muted/30">
          <button
            type="button"
            class="text-muted-foreground hover:text-foreground flex w-full items-center gap-1.5 px-2.5 py-1.5 text-xs"
            [attr.aria-expanded]="showQuestions()"
            (click)="showQuestions.set(!showQuestions())"
          >
            <svg [lucideIcon]="help" [size]="13" aria-hidden="true"></svg>
            <span class="font-medium">
              {{ openQuestions().length }}
              {{ openQuestions().length === 1 ? 'thing' : 'things' }} worth adding
            </span>
            <svg
              [lucideIcon]="chevron"
              [size]="13"
              class="ml-auto transition-transform"
              [class.rotate-180]="showQuestions()"
              aria-hidden="true"
            ></svg>
          </button>
          @if (showQuestions()) {
            <ul class="border-t">
              @for (question of openQuestions(); track question) {
                <li
                  class="group flex items-start gap-2 px-2.5 py-1.5 text-xs [&:not(:last-child)]:border-b"
                >
                  <span class="min-w-0 flex-1 leading-snug">{{ question }}</span>
                  <button
                    type="button"
                    class="text-muted-foreground hover:bg-accent hover:text-foreground flex h-6 shrink-0 items-center gap-1 rounded px-1.5"
                    title="Add this question to the description"
                    [disabled]="disabled()"
                    (click)="pickQuestion(question)"
                  >
                    <svg [lucideIcon]="plus" [size]="12" aria-hidden="true"></svg> Add
                  </button>
                  <button
                    type="button"
                    class="text-muted-foreground hover:bg-accent hover:text-foreground flex size-6 shrink-0 items-center justify-center rounded"
                    aria-label="Dismiss"
                    (click)="dismissQuestion(question)"
                  >
                    <svg [lucideIcon]="close" [size]="12" aria-hidden="true"></svg>
                  </button>
                </li>
              }
            </ul>
          }
        </div>
      }
    </div>
  `,
  styles: `
    .pill {
      display: inline-flex;
      height: 1.75rem;
      max-width: 100%;
      align-items: center;
      gap: 0.375rem;
      border: 1px dashed var(--border-strong);
      border-radius: var(--radius-md, 0.375rem);
      padding: 0 0.625rem;
      font-size: 0.75rem;
      white-space: nowrap;
      transition: background-color 120ms;
    }
    .pill:hover:not(:disabled) {
      background: var(--accent);
    }
    .pill:disabled {
      opacity: 0.5;
    }
    .pill:focus-visible {
      outline: 2px solid var(--ring);
    }
  `,
})
export class DraftSuggestions {
  protected readonly minimumDraftLength = minimumDraftLength;
  readonly kind = input.required<AiDraft['kind']>();
  readonly title = input.required<string>();
  readonly description = input.required<string>();
  readonly disabled = input(false);
  /** Values already set on the draft, so a suggestion that changes nothing is not offered. */
  readonly current = input<
    Partial<Record<AiIssueDraftSuggestion['field'], string | number | readonly string[]>>
  >({});
  readonly titleAccepted = output<string>();
  readonly descriptionAccepted = output<string>();
  readonly triageAccepted = output<AiIssueDraftSuggestion>();
  readonly settingsRequested = output<void>();
  /** A clarifying question the person wants in the description, to answer in place. */
  readonly questionPicked = output<string>();
  protected readonly ai = inject(AssistantStore);
  private readonly api = inject(AiApi);
  private readonly store = inject(TramaStore);
  private controller?: AbortController;
  private autoTimer?: ReturnType<typeof setTimeout>;
  private expectedTitle?: string;
  private expectedDescription?: string;
  private expectedKind?: AiDraft['kind'];
  private expectedSlug?: string;
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly suggestion = signal<AiSuggestion | null>(null);
  protected readonly usedTitle = signal(false);
  protected readonly usedDescription = signal(false);
  private readonly applied = signal<string[]>([]);
  /** Local hints the person already took: kept while they keep typing. */
  private readonly appliedLocal = signal<string[]>([]);
  /** Instant hints from the typed text, plus workstreams ranked locally. AI answers win per field. */
  private readonly localItems = computed<AiIssueDraftSuggestion[]>(() => {
    if (this.kind() !== 'issue') return [];
    const title = this.title();
    const description = this.description();
    if (title.trim().length + description.trim().length < 3) return [];
    const options = this.issueOptions();
    const items = localTriage(title, description, options);
    for (const ws of options.workstreams.slice(0, 2))
      items.push({
        field: 'workstreamId',
        value: ws.id,
        label: `${ws.key} · ${ws.title}`,
        why: 'Overlaps with this workstream.',
      });
    return items;
  });
  protected readonly visibleTriage = computed(() => {
    const ai = this.suggestion()?.triage?.suggestions ?? [];
    const aiFields = new Set(ai.filter((i) => i.field !== 'workstreamId').map((i) => i.field));
    const hasAiWorkstreams = ai.some((i) => i.field === 'workstreamId');
    const local = this.localItems().filter((i) =>
      i.field === 'workstreamId' ? !hasAiWorkstreams : !aiFields.has(i.field),
    );
    const key = (item: AiIssueDraftSuggestion) => `${item.field}:${item.value}`;
    const current = this.current();
    const already = (item: AiIssueDraftSuggestion) => {
      const have = current[item.field];
      return Array.isArray(have) ? have.includes(item.value as string) : have === item.value;
    };
    return [
      ...ai.filter((item) => !this.applied().includes(key(item))),
      ...local.filter((item) => !this.appliedLocal().includes(key(item))),
    ].filter((item) => !already(item));
  });
  protected readonly sparkles = LucideSparkles;
  protected readonly help = LucideCircleHelp;
  protected readonly chevron = LucideChevronDown;
  protected readonly plus = LucidePlus;
  protected readonly close = LucideX;
  protected readonly showQuestions = signal(false);
  private readonly dismissed = signal<string[]>([]);
  protected readonly openQuestions = computed(() =>
    (this.suggestion()?.questions ?? []).filter((q) => !this.dismissed().includes(q)),
  );

  protected pickQuestion(question: string): void {
    this.dismissQuestion(question);
    this.questionPicked.emit(question);
  }

  protected dismissQuestion(question: string): void {
    this.dismissed.update((items) => [...items, question]);
  }

  constructor() {
    inject(DestroyRef).onDestroy(() => this.cancel());
    effect(() => {
      const title = this.title();
      const description = this.description();
      const kind = this.kind();
      const slug = this.ai.slug();
      const ready = this.ai.ready();
      const disabled = this.disabled();
      untracked(() => {
        if (!ready || disabled) {
          this.cancel();
          return;
        }
        if (
          this.expectedTitle === title &&
          this.expectedDescription === description &&
          this.expectedKind === kind &&
          this.expectedSlug === slug
        )
          return;
        this.cancel();
        this.suggestion.set(null);
        this.error.set('');
        this.applied.set([]);
        if (slug && title.trim().length + description.trim().length >= minimumDraftLength) {
          this.autoTimer = setTimeout(() => {
            this.autoTimer = undefined;
            void this.suggest();
          }, suggestionDebounceMs);
        }
      });
    });
  }

  protected fieldLabel(field: AiIssueDraftSuggestion['field']): string {
    return {
      priority: 'Priority',
      kind: 'Type',
      estimate: 'Estimate',
      teamId: 'Team',
      assigneeId: 'Assignee',
      workstreamId: 'Related workstream',
    }[field];
  }

  protected displayValue(item: AiIssueDraftSuggestion): string {
    if ('label' in item) return item.label;
    if (item.field === 'priority')
      return PRIORITY_META[item.value as keyof typeof PRIORITY_META]?.label ?? item.value;
    if (item.field === 'kind')
      return ISSUE_KIND_META[item.value as keyof typeof ISSUE_KIND_META]?.label ?? item.value;
    if (item.field === 'estimate')
      return (
        estimateOptions(this.store.estimateScale()).find((option) => option.value === item.value)
          ?.label ?? String(item.value)
      );
    return '';
  }

  protected applySuggestion(item: AiIssueDraftSuggestion): void {
    const key = `${item.field}:${item.value}`;
    this.applied.update((items) => [...items, key]);
    this.appliedLocal.update((items) => [...items, key]);
    this.triageAccepted.emit(item);
  }

  protected applyTitle(value: string): void {
    this.expectedTitle = value;
    this.usedTitle.set(true);
    this.titleAccepted.emit(value);
  }

  protected applyDescription(value: string): void {
    this.expectedDescription = value;
    this.usedDescription.set(true);
    this.descriptionAccepted.emit(value);
  }

  protected async suggest(): Promise<void> {
    const slug = this.ai.slug();
    if (!slug || !this.ai.ready() || this.busy() || this.disabled()) return;
    this.cancel();
    this.suggestion.set(null);
    this.error.set('');
    this.usedTitle.set(false);
    this.usedDescription.set(false);
    this.applied.set([]);
    this.expectedTitle = this.title();
    this.expectedDescription = this.description();
    this.expectedKind = this.kind();
    this.expectedSlug = slug;
    const controller = new AbortController();
    this.controller = controller;
    this.busy.set(true);
    const draft: AiDraft = {
      kind: this.kind(),
      title: this.title(),
      description: this.description(),
      ...(this.kind() === 'issue' ? { issueOptions: this.issueOptions() } : {}),
    };
    try {
      const result = await this.api.suggest(slug, draft, controller.signal);
      if (this.controller === controller) this.suggestion.set(result);
    } catch (error) {
      if (this.controller === controller && !controller.signal.aborted)
        this.error.set(error instanceof Error ? error.message : 'Could not suggest improvements.');
    } finally {
      if (this.controller === controller) {
        this.controller = undefined;
        this.busy.set(false);
      }
    }
  }

  private issueOptions(): AiIssueDraftOptions {
    const query = `${this.title()}\n${this.description()}`;
    const teams = this.store
      .teams()
      .slice(0, 50)
      .map((team) => ({ id: team.id, label: `${team.name} (${team.key})` }));
    const assignees = this.store
      .users()
      .slice(0, 100)
      .map((user) => ({ id: user.id, label: user.name }));
    const activeWorkstreams = this.store
      .workstreams()
      .filter((workstream) => workstream.status !== 'shipped' && workstream.status !== 'canceled');
    const workstreams = rankByOverlap(
      query,
      activeWorkstreams,
      (workstream) => `${workstream.title} ${workstream.objective} ${workstream.description ?? ''}`,
      8,
      0.04,
    ).map(({ item }) => ({
      id: item.id,
      key: item.key,
      title: item.title,
      objective: item.objective.slice(0, 500),
    }));
    const finishedIssues = this.store
      .issues()
      .filter((issue) => issue.status === 'done' && !issue.duplicateOfId);
    const similar = rankByOverlap(
      query,
      finishedIssues,
      (issue) => `${issue.title} ${issue.body ?? ''}`,
      4,
      0.04,
    ).map(({ item }) => ({
      key: item.key,
      title: item.title,
      kind: item.kind,
      priority: item.priority,
      estimate: item.estimate ?? null,
      cycleDays:
        item.startedAt && item.completedAt
          ? Math.max(
              0,
              Math.round(
                ((new Date(item.completedAt).getTime() - new Date(item.startedAt).getTime()) /
                  86_400_000) *
                  10,
              ) / 10,
            )
          : null,
    }));
    return {
      kinds: [...ISSUE_KINDS],
      priorities: [...PRIORITIES],
      estimates:
        this.store.estimateScale() === 'none'
          ? []
          : estimateOptions(this.store.estimateScale()).map((option) => option.value),
      teams,
      assignees,
      workstreams,
      similar,
    };
  }

  protected cancel(): void {
    if (this.autoTimer) {
      clearTimeout(this.autoTimer);
      this.autoTimer = undefined;
    }
    this.controller?.abort();
    this.controller = undefined;
    this.busy.set(false);
  }
}
