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
  LucideCheck,
  LucideDynamicIcon,
  LucideLightbulb,
  LucideSparkles,
  LucideX,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
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
import { NablaStore } from '../../core/stores/nabla.store';
import { rankByOverlap } from '../ai-actions/similar';

@Component({
  selector: 'app-draft-suggestions',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButtonImports, LucideDynamicIcon, RouterLink],
  template: `
    <div class="my-3 space-y-3">
      <div class="flex flex-wrap items-center gap-2">
        <button
          hlmBtn
          variant="outline"
          size="sm"
          type="button"
          class="h-9 gap-2 rounded-lg border-primary/20 bg-primary/5 px-3 text-sm font-medium hover:bg-primary/10"
          [disabled]="busy() || disabled() || !ai.ready() || !(title().trim() || description().trim())"
          (click)="suggest()"
        >
          <svg [lucideIcon]="sparkles" [size]="15" class="text-primary" aria-hidden="true"></svg>
          {{ busy() ? 'Finding suggestions…' : 'Improve draft with AI' }}
        </button>
        @if (busy()) {
          <button hlmBtn variant="ghost" size="sm" type="button" class="h-9 rounded-lg px-3 text-sm" (click)="cancel()">Cancel</button>
        }
        @if (!ai.ready() && !ai.loadingStatus()) {
          <a
            [routerLink]="['/', ai.slug(), 'settings', 'ai']"
            class="text-muted-foreground rounded-md px-2 py-1 text-xs underline underline-offset-2"
            (click)="settingsRequested.emit()"
            >AI settings</a
          >
        }
      </div>
      @if (error()) {
        <p class="border-destructive/20 bg-destructive/5 text-destructive rounded-lg border px-3 py-2 text-sm" role="alert">{{ error() }}</p>
      }
      @if (suggestion(); as proposed) {
        <section aria-label="AI suggestions" class="bg-card space-y-4 rounded-xl border p-3 shadow-sm sm:p-4">
          <div class="flex items-start justify-between gap-3">
            <div class="flex min-w-0 items-start gap-2.5">
              <span class="bg-primary/10 text-primary grid size-8 shrink-0 place-items-center rounded-lg">
                <svg [lucideIcon]="sparkles" [size]="16" aria-hidden="true"></svg>
              </span>
              <div class="min-w-0">
                <h3 class="text-sm font-semibold">Suggestions for this draft</h3>
                <p class="text-muted-foreground mt-0.5 text-xs">Based on the description and your workspace options. Nothing changes until you apply it.</p>
              </div>
            </div>
            <button
              hlmBtn
              variant="ghost"
              size="icon-xs"
              class="text-muted-foreground shrink-0"
              type="button"
              (click)="suggestion.set(null)"
              aria-label="Dismiss suggestions"
            >
              <svg [lucideIcon]="closeIcon" [size]="15" aria-hidden="true"></svg>
            </button>
          </div>

          @if (visibleTriage().length) {
            <div class="space-y-2 border-t pt-3">
              <h4 class="flex items-center gap-1.5 text-xs font-semibold tracking-wide uppercase">
                <svg [lucideIcon]="ideaIcon" [size]="14" class="text-primary" aria-hidden="true"></svg>
                Suggested properties
              </h4>
              <div class="grid gap-2 sm:grid-cols-2">
                @for (item of visibleTriage(); track item.field + ':' + item.value) {
                  <article class="bg-muted/40 flex min-w-0 items-start justify-between gap-2 rounded-lg border px-3 py-2.5">
                    <div class="min-w-0">
                      <p class="text-muted-foreground text-xs">{{ fieldLabel(item.field) }}</p>
                      <p class="mt-0.5 truncate text-sm font-medium">{{ displayValue(item) }}</p>
                      @if (item.why) {
                        <p class="text-muted-foreground mt-1 text-xs leading-snug">{{ item.why }}</p>
                      }
                    </div>
                    <button
                      hlmBtn
                      size="sm"
                      variant="outline"
                      type="button"
                      class="h-8 shrink-0 rounded-md px-2.5 text-xs"
                      [disabled]="disabled()"
                      (click)="applySuggestion(item)"
                    >
                      <svg [lucideIcon]="checkIcon" [size]="13" aria-hidden="true"></svg> Use
                    </button>
                  </article>
                }
              </div>
            </div>
          }

          @if (!usedTitle()) {
            <div class="space-y-1.5 border-t pt-3">
              <p class="text-muted-foreground text-xs font-medium">Title</p>
              <p class="text-sm leading-relaxed">{{ proposed.title }}</p>
              <button hlmBtn variant="outline" size="sm" type="button" class="h-8 rounded-md px-2.5 text-xs" [disabled]="disabled()" (click)="applyTitle(proposed.title)">Use title</button>
            </div>
          }
          @if (!usedDescription()) {
            <div class="space-y-1.5 border-t pt-3">
              <p class="text-muted-foreground text-xs font-medium">Description</p>
              <p class="max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-relaxed">{{ proposed.description }}</p>
              <button hlmBtn variant="outline" size="sm" type="button" class="h-8 rounded-md px-2.5 text-xs" [disabled]="disabled()" (click)="applyDescription(proposed.description)">Use description</button>
            </div>
          }
          @if (proposed.questions.length) {
            <div class="border-t pt-3">
              <p class="text-muted-foreground mb-1.5 text-xs font-medium">Details you may want to add</p>
              <ul class="space-y-1.5 text-sm">
                @for (question of proposed.questions; track $index) {
                  <li class="flex items-start gap-2"><span class="mt-2 size-1 shrink-0 rounded-full bg-primary/70"></span><span>{{ question }}</span></li>
                }
              </ul>
            </div>
          }
        </section>
      }
    </div>
  `,
})
export class DraftSuggestions {
  readonly kind = input.required<AiDraft['kind']>();
  readonly title = input.required<string>();
  readonly description = input.required<string>();
  readonly disabled = input(false);
  readonly titleAccepted = output<string>();
  readonly descriptionAccepted = output<string>();
  readonly triageAccepted = output<AiIssueDraftSuggestion>();
  readonly settingsRequested = output<void>();
  protected readonly ai = inject(AssistantStore);
  private readonly api = inject(AiApi);
  private readonly store = inject(NablaStore);
  private controller?: AbortController;
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
  protected readonly visibleTriage = computed(() =>
    (this.suggestion()?.triage?.suggestions ?? []).filter((item) => !this.applied().includes(`${item.field}:${item.value}`)),
  );
  protected readonly sparkles = LucideSparkles;
  protected readonly ideaIcon = LucideLightbulb;
  protected readonly checkIcon = LucideCheck;
  protected readonly closeIcon = LucideX;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.cancel());
    effect(() => {
      const title = this.title();
      const description = this.description();
      const kind = this.kind();
      const slug = this.ai.slug();
      untracked(() => {
        if (this.expectedTitle === title && this.expectedDescription === description && this.expectedKind === kind && this.expectedSlug === slug) return;
        this.cancel();
        this.suggestion.set(null);
        this.error.set('');
        this.applied.set([]);
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
    if (item.field === 'priority') return PRIORITY_META[item.value as keyof typeof PRIORITY_META]?.label ?? item.value;
    if (item.field === 'kind') return ISSUE_KIND_META[item.value as keyof typeof ISSUE_KIND_META]?.label ?? item.value;
    if (item.field === 'estimate') return estimateOptions(this.store.estimateScale()).find((option) => option.value === item.value)?.label ?? String(item.value);
    return '';
  }

  protected applySuggestion(item: AiIssueDraftSuggestion): void {
    this.applied.update((items) => [...items, `${item.field}:${item.value}`]);
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
    if (!slug || this.busy() || this.disabled()) return;
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
    const teams = this.store.teams().slice(0, 50).map((team) => ({ id: team.id, label: `${team.name} (${team.key})` }));
    const assignees = this.store.users().slice(0, 100).map((user) => ({ id: user.id, label: user.name }));
    const activeWorkstreams = this.store.workstreams().filter((workstream) => workstream.status !== 'shipped' && workstream.status !== 'canceled');
    const workstreams = rankByOverlap(query, activeWorkstreams, (workstream) => `${workstream.title} ${workstream.objective} ${workstream.description ?? ''}`, 8, 0.04)
      .map(({ item }) => ({ id: item.id, key: item.key, title: item.title, objective: item.objective.slice(0, 500) }));
    const finishedIssues = this.store.issues().filter((issue) => issue.status === 'done' && !issue.duplicateOfId);
    const similar = rankByOverlap(query, finishedIssues, (issue) => `${issue.title} ${issue.body ?? ''}`, 4, 0.04)
      .map(({ item }) => ({
        key: item.key,
        title: item.title,
        kind: item.kind,
        priority: item.priority,
        estimate: item.estimate ?? null,
        cycleDays: item.startedAt && item.completedAt
          ? Math.max(0, Math.round((new Date(item.completedAt).getTime() - new Date(item.startedAt).getTime()) / 86_400_000 * 10) / 10)
          : null,
      }));
    return {
      kinds: [...ISSUE_KINDS],
      priorities: [...PRIORITIES],
      estimates: this.store.estimateScale() === 'none' ? [] : estimateOptions(this.store.estimateScale()).map((option) => option.value),
      teams,
      assignees,
      workstreams,
      similar,
    };
  }

  protected cancel(): void {
    this.controller?.abort();
    this.controller = undefined;
    this.busy.set(false);
  }
}
