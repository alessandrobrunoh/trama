import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import type { ActivityStep } from '../../core/ai/ai-api';

/** What the assistant did, one line per step; the tool still running shows a pulsing dot. */
@Component({
  selector: 'app-activity-steps',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <ul class="space-y-1.5 text-[13px] leading-snug">
      @for (step of steps(); track $index) {
        @if (step.kind === 'note') {
          <li class="text-muted-foreground border-l-2 pl-3 whitespace-pre-wrap">
            {{ step.label }}
          </li>
        } @else {
          <li [class]="step.ok === false ? 'text-destructive' : 'text-muted-foreground'">
            {{ step.label }}
            @if (step.count) {
              ×{{ step.count }}
            }
            @if (step.ok === false) {
              · failed
              @if (step.detail) {
                <span class="text-muted-foreground block text-xs">{{ step.detail }}</span>
              }
            }
          </li>
        }
      }
      @if (working()) {
        <li class="text-foreground flex items-center gap-1.5">
          <span
            class="bg-primary size-1.5 shrink-0 animate-pulse rounded-full"
            aria-hidden="true"
          ></span>
          {{ working() }}…
        </li>
      }
    </ul>
  `,
})
export class ActivitySteps {
  readonly steps = input.required<readonly ActivityStep[]>();
  /** Label of the tool that is running right now. */
  readonly working = input<string | null>(null);
}
