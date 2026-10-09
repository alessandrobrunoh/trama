import { ChangeDetectionStrategy, Component, booleanAttribute, computed, inject, input } from '@angular/core';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import type { EstimateScale } from '../core/contracts/domain';
import { estimateFraction, estimateTooltip, formatEstimate, formatEstimateLong } from '../core/estimates';
import { TramaStore } from '../core/stores/trama.store';

/**
 * The estimate glyph on its own: a small ramp (triangle) filled from the left, proportionally to where the
 * value sits on its scale. `fraction` is 0..1 (see `estimateFraction`).
 */
@Component({
  selector: 'app-estimate-glyph',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'relative inline-block shrink-0 align-middle', '[style.width.px]': 'size()', '[style.height.px]': 'size()', 'aria-hidden': 'true' },
  template: `
    <span class="absolute inset-0 block" style="clip-path: polygon(0 100%, 100% 100%, 100% 0)">
      <span class="absolute inset-0 bg-current opacity-25"></span>
      <span class="absolute inset-y-0 left-0 bg-current opacity-90" [style.width.%]="fraction() * 100"></span>
    </span>
  `,
})
export class EstimateGlyph {
  readonly fraction = input(0);
  readonly size = input(13);
}

/**
 * An estimate: glyph + formatted value ("3", "M"), muted. Tooltip "3 points · Fibonacci scale".
 *   <app-estimate [value]="issue.estimate" />                (scale defaults to the workspace's)
 *   <app-estimate [value]="3" scale="tshirt" long />         → "M · 3 points"
 * Renders nothing when the value is empty (unless `placeholder` is set).
 */
@Component({
  selector: 'app-estimate',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [EstimateGlyph, HlmTooltip],
  host: { class: 'text-muted-foreground inline-flex shrink-0 items-center gap-1 whitespace-nowrap tabular-nums' },
  template: `
    @if (hasValue()) {
      <span class="inline-flex items-center gap-1" [hlmTooltip]="tip()" [tooltipDisabled]="!tooltip()">
        <app-estimate-glyph [fraction]="fraction()" [size]="size()" />
        <span [class.text-foreground]="long()">{{ text() }}</span>
      </span>
    } @else if (placeholder()) {
      <span class="inline-flex items-center gap-1 opacity-70">
        <app-estimate-glyph [fraction]="0" [size]="size()" />
        <span>{{ placeholder() }}</span>
      </span>
    }
  `,
})
export class Estimate {
  private readonly store = inject(TramaStore);
  readonly value = input<number | null | undefined>();
  /** Defaults to the workspace's estimate scale. */
  readonly scale = input<EstimateScale>();
  /** "3 points" / "M · 3 points" instead of "3" / "M". */
  readonly long = input(false, { transform: booleanAttribute });
  /** Hover tooltip (on by default). */
  readonly tooltip = input(true, { transform: booleanAttribute });
  /** Text shown (with an empty glyph) when there is no value. */
  readonly placeholder = input<string>();
  readonly size = input(13);

  private readonly sc = computed(() => this.scale() ?? this.store.estimateScale());
  protected readonly hasValue = computed(() => {
    const v = this.value();
    return v !== null && v !== undefined && Number.isFinite(v);
  });
  protected readonly text = computed(() => (this.long() ? formatEstimateLong(this.value(), this.sc()) : formatEstimate(this.value(), this.sc())));
  protected readonly tip = computed(() => estimateTooltip(this.value(), this.sc()));
  protected readonly fraction = computed(() => estimateFraction(this.value(), this.sc()));
}
