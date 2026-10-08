import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { AiApi, type AiDraft, type AiSuggestion } from '../../core/ai/ai-api';
import { AssistantStore } from '../../core/ai/assistant.store';

@Component({
  selector: 'app-draft-suggestions',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButtonImports, RouterLink],
  template: `
    <div class="my-2 space-y-2">
      <div class="flex items-center gap-2">
        <button
          hlmBtn
          variant="ghost"
          size="sm"
          type="button"
          class="text-muted-foreground h-7 text-xs"
          [disabled]="
            busy() || disabled() || !ai.ready() || !(title().trim() || description().trim())
          "
          (click)="suggest()"
        >
          {{ busy() ? 'Finding improvements…' : 'Suggest improvements' }}
        </button>
        @if (busy()) {
          <button
            hlmBtn
            variant="ghost"
            size="sm"
            type="button"
            class="h-7 text-xs"
            (click)="cancel()"
          >
            Cancel
          </button>
        }
        @if (!ai.ready() && !ai.loadingStatus()) {
          <a
            [routerLink]="['/', ai.slug(), 'settings', 'ai']"
            class="text-muted-foreground text-xs underline"
            (click)="settingsRequested.emit()"
            >AI settings</a
          >
        }
      </div>
      @if (error()) {
        <p class="text-destructive text-xs" role="alert">{{ error() }}</p>
      }
      @if (suggestion(); as proposed) {
        <section
          aria-label="Suggested improvements"
          class="bg-muted/40 space-y-3 rounded-lg border p-3"
        >
          <div class="flex items-center justify-between">
            <h3 class="text-xs font-medium">Suggested improvements</h3>
            <button
              hlmBtn
              variant="ghost"
              size="sm"
              class="h-6 text-xs"
              type="button"
              (click)="suggestion.set(null)"
            >
              Dismiss
            </button>
          </div>
          @if (!usedTitle()) {
            <div class="space-y-1">
              <p class="text-muted-foreground text-[11px]">Title</p>
              <p class="text-sm">{{ proposed.title }}</p>
              <button
                hlmBtn
                variant="outline"
                size="sm"
                type="button"
                class="h-6 text-xs"
                [disabled]="disabled()"
                (click)="applyTitle(proposed.title)"
              >
                Use title
              </button>
            </div>
          }
          @if (!usedDescription()) {
            <div class="space-y-1">
              <p class="text-muted-foreground text-[11px]">Description</p>
              <p class="max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-sm">
                {{ proposed.description }}
              </p>
              <button
                hlmBtn
                variant="outline"
                size="sm"
                type="button"
                class="h-6 text-xs"
                [disabled]="disabled()"
                (click)="applyDescription(proposed.description)"
              >
                Use description
              </button>
            </div>
          }
          @if (proposed.questions.length) {
            <div>
              <p class="text-muted-foreground mb-1 text-[11px]">Details you may want to add</p>
              <ul class="list-disc space-y-1 pl-4 text-xs">
                @for (question of proposed.questions; track $index) {
                  <li>{{ question }}</li>
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
  readonly settingsRequested = output<void>();
  protected readonly ai = inject(AssistantStore);
  private readonly api = inject(AiApi);
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

  constructor() {
    inject(DestroyRef).onDestroy(() => this.cancel());
    effect(() => {
      const title = this.title();
      const description = this.description();
      const kind = this.kind();
      const slug = this.ai.slug();
      untracked(() => {
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
      });
    });
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
    this.expectedTitle = this.title();
    this.expectedDescription = this.description();
    this.expectedKind = this.kind();
    this.expectedSlug = slug;
    const controller = new AbortController();
    this.controller = controller;
    this.busy.set(true);
    try {
      const result = await this.api.suggest(
        slug,
        { kind: this.kind(), title: this.title(), description: this.description() },
        controller.signal,
      );
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

  protected cancel(): void {
    this.controller?.abort();
    this.controller = undefined;
    this.busy.set(false);
  }
}
