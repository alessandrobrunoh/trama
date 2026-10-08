import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { Sparkline } from './sparkline';

export interface KpiDelta {
  /** "▲ 25%" style text without the arrow; the tile adds the arrow from `direction`. */
  text: string;
  direction: 'up' | 'down' | 'flat';
  /** Colour = direction × whether that direction is good. */
  tone: 'good' | 'bad' | 'neutral';
  /** Tooltip: what it is compared with. */
  title?: string;
}

/** Linear-Insights-style tile: label, big number, delta against the previous period, sparkline. */
@Component({
  selector: 'app-kpi-tile',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Sparkline],
  host: { class: 'bg-card flex min-w-0 flex-col gap-1 rounded-lg border px-4 py-3' },
  template: `
    <div class="text-muted-foreground truncate text-xs">{{ label() }}</div>
    <div class="flex items-baseline gap-2">
      <span class="text-[26px] leading-8 font-semibold tracking-tight">{{ value() }}</span>
      @if (delta(); as d) {
        <span
          class="inline-flex items-center gap-0.5 text-xs font-medium tabular-nums"
          [class.text-tone-green]="d.tone === 'good'"
          [class.text-tone-red]="d.tone === 'bad'"
          [class.text-muted-foreground]="d.tone === 'neutral'"
          [attr.title]="d.title ?? null"
        >
          <span aria-hidden="true" class="text-[9px]">{{ d.direction === 'up' ? '▲' : d.direction === 'down' ? '▼' : '–' }}</span>
          {{ d.text }}
          <span class="sr-only">{{ d.direction === 'up' ? 'up' : d.direction === 'down' ? 'down' : 'unchanged' }}{{ d.title ? ', ' + d.title : '' }}</span>
        </span>
      }
    </div>
    <div class="text-meta min-h-4 truncate text-[11px]">{{ hint() }}</div>
    @if (spark().length > 1) {
      <app-sparkline class="mt-1" [values]="spark()" [color]="sparkColor()" />
    }
  `,
})
export class KpiTile {
  readonly label = input.required<string>();
  readonly value = input.required<string>();
  readonly delta = input<KpiDelta | undefined>(undefined);
  readonly hint = input<string | undefined>(undefined);
  readonly spark = input<readonly number[]>([]);
  readonly sparkColor = input('var(--chart-1)');
}
