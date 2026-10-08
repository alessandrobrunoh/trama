import { ChangeDetectionStrategy, Component, booleanAttribute, computed, inject, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideDynamicIcon, LucideSparkles } from '@lucide/angular';
import { HlmButtonImports, type ButtonVariants } from '@spartan-ng/helm/button';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import { AiActions, SETUP_MESSAGE } from './ai-actions.service';

/**
 * A quiet sparkles button that starts an AI action.
 *   <app-ai-button label="Summarize" tooltip="Summarize this issue" (pressed)="run()" />
 * When AI is not set up it becomes a link to Settings → AI & assistant (tooltip explains), unless
 * `hideWhenUnavailable` is set. `disabled` + `disabledReason` cover other reasons (permissions).
 */
@Component({
  selector: 'app-ai-button',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButtonImports, HlmTooltip, LucideDynamicIcon, RouterLink],
  host: { class: 'inline-flex' },
  template: `
    @if (ai.available()) {
      <button
        hlmBtn
        type="button"
        [variant]="variant()"
        [size]="iconOnly() ? 'icon-sm' : size()"
        [disabled]="disabled() || loading()"
        [attr.aria-label]="iconOnly() ? label() : null"
        [attr.aria-busy]="loading() || null"
        [hlmTooltip]="tip()"
        [tooltipDisabled]="!tip()"
        (click)="pressed.emit()"
      >
        <svg [lucideIcon]="sparkles" [size]="13" [strokeWidth]="1.75" class="text-entity-workstream" [class.motion-safe:animate-pulse]="loading()"></svg>
        @if (!iconOnly()) {
          <span>{{ label() }}</span>
        }
      </button>
    } @else if (!hideWhenUnavailable()) {
      @if (ai.checked()) {
        <a
          hlmBtn
          [variant]="variant()"
          [size]="iconOnly() ? 'icon-sm' : size()"
          class="text-muted-foreground"
          [routerLink]="ai.settingsLink()"
          [attr.aria-label]="label() + ' — ' + setup"
          [hlmTooltip]="setup"
        >
          <svg [lucideIcon]="sparkles" [size]="13" [strokeWidth]="1.75" class="opacity-60"></svg>
          @if (!iconOnly()) {
            <span>{{ label() }}</span>
          }
        </a>
      } @else {
        <button hlmBtn type="button" [variant]="variant()" [size]="iconOnly() ? 'icon-sm' : size()" disabled [attr.aria-label]="label()">
          <svg [lucideIcon]="sparkles" [size]="13" [strokeWidth]="1.75" class="opacity-60"></svg>
          @if (!iconOnly()) {
            <span>{{ label() }}</span>
          }
        </button>
      }
    }
  `,
})
export class AiButton {
  protected readonly ai = inject(AiActions);
  protected readonly sparkles = LucideSparkles;
  protected readonly setup = SETUP_MESSAGE;

  readonly label = input.required<string>();
  /** Tooltip when available. */
  readonly tooltip = input('');
  readonly variant = input<ButtonVariants['variant']>('ghost');
  readonly size = input<ButtonVariants['size']>('sm');
  readonly iconOnly = input(false, { transform: booleanAttribute });
  readonly loading = input(false, { transform: booleanAttribute });
  readonly disabled = input(false, { transform: booleanAttribute });
  /** Why it is disabled (shown as tooltip). */
  readonly disabledReason = input('');
  readonly hideWhenUnavailable = input(false, { transform: booleanAttribute });
  readonly pressed = output<void>();

  protected readonly tip = computed(() => (this.disabled() && this.disabledReason() ? this.disabledReason() : this.tooltip()));

  constructor() {
    this.ai.touch();
  }
}
