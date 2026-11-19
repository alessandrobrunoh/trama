import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import type { Percentiles } from '../stats-flow';
import { MIN_FOR_TAIL } from '../stats-flow';
import { formatDuration } from '../insights';

/** Median, 75th and 90th percentile of a duration side by side, with how many tasks they come from. */
@Component({
  selector: 'app-percentile-strip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmTooltip],
  host: { class: 'block' },
  template: `
    <dl class="grid grid-cols-3 gap-3">
      <div>
        <dt class="text-muted-foreground text-xs">Median</dt>
        <dd class="text-xl tracking-tight tabular-nums" hlmTooltip="Half of the tasks took less than this" position="bottom">{{ text(stats().median) }}</dd>
      </div>
      <div>
        <dt class="text-muted-foreground text-xs">75th percentile</dt>
        <dd class="text-xl tracking-tight tabular-nums" [hlmTooltip]="tail('Three quarters of the tasks took less than this')" position="bottom">{{ text(stats().p75) }}</dd>
      </div>
      <div>
        <dt class="text-muted-foreground text-xs">90th percentile</dt>
        <dd class="text-xl tracking-tight tabular-nums" [hlmTooltip]="tail('Nine in ten tasks took less than this')" position="bottom">{{ text(stats().p90) }}</dd>
      </div>
    </dl>
    <p class="text-meta mt-1 text-[11px]">From {{ stats().n }} completed {{ stats().n === 1 ? 'task' : 'tasks' }}</p>
  `,
})
export class PercentileStrip {
  readonly stats = input.required<Percentiles>();
  readonly format = input<(days: number) => string>(formatDuration);

  protected text(v: number | undefined): string {
    return v === undefined ? '—' : this.format()(v);
  }
  protected tail(text: string): string {
    return this.stats().p75 === undefined ? `Needs at least ${MIN_FOR_TAIL} completed tasks` : text;
  }
}
