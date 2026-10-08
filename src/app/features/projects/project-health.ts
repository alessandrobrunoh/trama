import { ChangeDetectionStrategy, Component, computed, input, model } from '@angular/core';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import type { ProjectHealth } from '../../core/contracts/domain';
import { HEALTH_ORDER, PROJECT_HEALTH_STYLE } from './project-model';

/** Tinted pill with a dot: On track / At risk / Off track. Without a value it shows "No updates" (or nothing). */
@Component({
  selector: 'app-project-health',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'inline-flex' },
  template: `
    @if (style(); as s) {
      <span
        class="inline-flex items-center gap-1.5 rounded-full border px-2 text-xs font-medium whitespace-nowrap"
        [class]="s.text + ' ' + s.bg + ' ' + s.border + (compact() ? ' h-5' : ' h-6')"
      >
        <span class="size-1.5 shrink-0 rounded-full" [class]="s.dot"></span>{{ s.label }}
      </span>
    } @else if (showEmpty()) {
      <span class="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
        <span class="border-border-strong size-1.5 shrink-0 rounded-full border"></span>No updates
      </span>
    }
  `,
})
export class ProjectHealthBadge {
  readonly health = input<ProjectHealth | undefined>();
  readonly compact = input(false);
  /** Show "No updates" when there is no health yet. */
  readonly showEmpty = input(false);
  protected readonly style = computed(() => {
    const h = this.health();
    return h ? PROJECT_HEALTH_STYLE[h] : undefined;
  });
}

/** The three coloured health choices of an update (a radio group). */
@Component({
  selector: 'app-project-health-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButtonImports],
  host: { class: 'block' },
  template: `
    <div role="radiogroup" [attr.aria-label]="label()" class="flex flex-wrap gap-1.5">
      @for (h of options; track h) {
        @let s = styles[h];
        @let on = value() === h;
        <button
          hlmBtn
          variant="outline"
          size="sm"
          type="button"
          role="radio"
          class="gap-1.5"
          [attr.aria-checked]="on"
          [disabled]="disabled()"
          [class]="
            on ? s.text + ' ' + s.bg + ' ' + s.border + ' font-medium' : 'text-muted-foreground'
          "
          (click)="value.set(h)"
        >
          <span class="size-2 shrink-0 rounded-full" [class]="s.dot"></span>{{ s.label }}
        </button>
      }
    </div>
  `,
})
export class ProjectHealthPicker {
  readonly value = model<ProjectHealth>('on_track');
  readonly label = input('Project health');
  readonly disabled = input(false);
  protected readonly options = HEALTH_ORDER;
  protected readonly styles = PROJECT_HEALTH_STYLE;
}
