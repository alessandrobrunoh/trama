import { ChangeDetectionStrategy, Component, ElementRef, afterNextRender, booleanAttribute, computed, inject, input, output, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideDynamicIcon, LucideRefreshCw, LucideSparkles, LucideX } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmSkeleton } from '@spartan-ng/helm/skeleton';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import { AiActions, SETUP_MESSAGE, type AiFailure, type JobState } from './ai-actions.service';

/**
 * The shared look of an AI result: calm loading state (shimmer + "Thinking…" + Cancel), error state
 * (friendly message + Retry, or a link to Settings), the result slot, and the footer
 * "AI-generated · review before applying" with Regenerate. Esc cancels while loading, else closes.
 *
 *   <app-ai-result title="Summary" [state]="job.state()" [error]="job.error()"
 *     (cancel)="job.cancel()" (retry)="run()" (regenerate)="run()" (closed)="hide()"> … </app-ai-result>
 *
 * `bare` drops the frame and header (for dialogs and cards that bring their own).
 */
@Component({
  selector: 'app-ai-result',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButtonImports, HlmSkeleton, HlmTooltip, LucideDynamicIcon, RouterLink],
  host: { class: 'block' },
  template: `
    <section
      #panel
      tabindex="-1"
      role="region"
      [attr.aria-label]="title()"
      [attr.aria-busy]="state() === 'loading'"
      class="focus-visible:ring-ring outline-none focus-visible:ring-2"
      [class]="bare() ? '' : 'bg-card border-border rounded-lg border'"
      (keydown.escape)="escape($event)"
    >
      @if (!bare()) {
        <header class="flex items-center gap-1.5 py-1.5 pr-1.5 pl-3">
          <svg [lucideIcon]="sparkles" [size]="13" [strokeWidth]="1.75" class="text-entity-workstream"></svg>
          <h3 class="text-muted-foreground min-w-0 flex-1 truncate text-xs font-medium">{{ title() }}</h3>
          <button hlmBtn variant="ghost" size="icon-xs" class="text-muted-foreground" type="button" aria-label="Close" hlmTooltip="Close · Esc" (click)="closed.emit()">
            <svg [lucideIcon]="xIcon" [size]="13"></svg>
          </button>
        </header>
      }

      <div [class]="bare() ? '' : 'px-3 pb-2.5'">
        @switch (state()) {
          @case ('loading') {
            <div class="flex flex-col gap-2 py-1" aria-hidden="true">
              <span hlmSkeleton class="h-3 w-11/12"></span>
              <span hlmSkeleton class="h-3 w-full"></span>
              <span hlmSkeleton class="h-3 w-7/12"></span>
            </div>
            <div class="mt-1 flex items-center gap-2">
              <span class="text-muted-foreground text-xs">Thinking…</span>
              <button hlmBtn variant="ghost" size="xs" type="button" class="text-muted-foreground ml-auto" (click)="cancel.emit()">Cancel</button>
            </div>
          }
          @case ('error') {
            <p class="text-destructive text-[13px] leading-snug" role="alert">{{ error()?.message || 'Something went wrong' }}</p>
            <div class="mt-2 flex items-center gap-1.5">
              @if (error()?.kind === 'setup') {
                <a hlmBtn variant="outline" size="xs" [routerLink]="ai.settingsLink()">Open AI settings</a>
              } @else {
                <button hlmBtn variant="outline" size="xs" type="button" (click)="retry.emit()">Try again</button>
              }
              <button hlmBtn variant="ghost" size="xs" type="button" class="text-muted-foreground" (click)="closed.emit()">Dismiss</button>
            </div>
          }
          @case ('done') {
            <ng-content />
          }
        }
      </div>

      @if (state() === 'done' && showFooter()) {
        <footer class="text-muted-foreground flex items-center gap-2 px-3 pb-2 text-[11px]" [class.px-0]="bare()">
          <span class="min-w-0 flex-1 truncate">AI-generated · review before applying</span>
          @if (canRegenerate()) {
            <button hlmBtn variant="ghost" size="xs" type="button" class="text-muted-foreground -mr-1" (click)="regenerate.emit()">
              <svg [lucideIcon]="refresh" [size]="12"></svg>Regenerate
            </button>
          }
        </footer>
      }
      <p class="sr-only" aria-live="polite">{{ live() }}</p>
    </section>
  `,
})
export class AiResult {
  protected readonly ai = inject(AiActions);
  protected readonly sparkles = LucideSparkles;
  protected readonly xIcon = LucideX;
  protected readonly refresh = LucideRefreshCw;

  readonly title = input('AI result');
  readonly state = input.required<JobState>();
  readonly error = input<AiFailure | null>(null);
  readonly bare = input(false, { transform: booleanAttribute });
  readonly showFooter = input(true, { transform: booleanAttribute });
  readonly canRegenerate = input(true, { transform: booleanAttribute });
  /** Move focus to the panel when it appears (keyboard users land on it). */
  readonly autofocus = input(true, { transform: booleanAttribute });
  /** Esc closes the panel when nothing is loading. Dialogs turn this off to keep their own Esc. */
  readonly closeOnEscape = input(true, { transform: booleanAttribute });

  readonly cancel = output<void>();
  readonly retry = output<void>();
  readonly regenerate = output<void>();
  readonly closed = output<void>();

  private readonly panel = viewChild.required<ElementRef<HTMLElement>>('panel');

  protected readonly live = computed(() => {
    switch (this.state()) {
      case 'loading':
        return 'Thinking…';
      case 'done':
        return 'AI result ready. Review it before applying.';
      case 'error':
        return this.error()?.message ?? SETUP_MESSAGE;
      default:
        return '';
    }
  });

  constructor() {
    afterNextRender(() => {
      if (this.autofocus()) this.panel().nativeElement.focus({ preventScroll: false });
    });
  }

  protected escape(e: Event): void {
    if (this.state() === 'loading') {
      e.stopPropagation();
      this.cancel.emit();
    } else if (this.closeOnEscape()) {
      e.stopPropagation();
      this.closed.emit();
    }
  }
}
