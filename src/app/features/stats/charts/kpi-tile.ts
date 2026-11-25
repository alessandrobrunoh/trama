import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
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

/** Time Reports tile (v3): big Newsreader number, delta against the previous period, mono label, sparkline. */
@Component({
  selector: 'app-kpi-tile',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmTooltip, Sparkline],
  host: { class: 'border-border flex min-w-0 flex-col gap-1 border px-[18px] py-3.5' },
  template: `
    <div class="flex items-end gap-2">
      <span class="font-title text-foreground text-[28px] leading-8">{{ value() }}</span>
      @if (delta(); as d) {
        <span
          class="inline-flex items-center gap-0.5 pb-1 font-mono text-[10.5px] leading-[13px] tabular-nums"
          [class.text-green]="d.tone === 'good'"
          [class.text-red]="d.tone === 'bad'"
          [class.text-faint]="d.tone === 'neutral'"
          [hlmTooltip]="d.title ?? ''"
          position="bottom"
        >
          <span aria-hidden="true" class="text-[8px]">{{ d.direction === 'up' ? '▲' : d.direction === 'down' ? '▼' : '–' }}</span>
          {{ d.text }}
          <span class="sr-only">{{ d.direction === 'up' ? 'up' : d.direction === 'down' ? 'down' : 'unchanged' }}{{ d.title ? ', ' + d.title : '' }}</span>
        </span>
      }
    </div>
    <div class="text-faint truncate font-mono text-[10.5px] leading-[13px]">{{ label() }}</div>
    @if (hint()) {
      <div class="text-faint min-h-3.5 font-mono text-[10px] leading-3.5 opacity-80">{{ hint() }}</div>
    }
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
