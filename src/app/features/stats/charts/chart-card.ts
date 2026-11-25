import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * One chart under a section head (v3: Newsreader 20 title over a hairline, no card): title, one-line caption in
 * mono, the chart, and an optional caveat underneath.
 */
@Component({
  selector: 'app-chart-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex min-w-0 flex-col' },
  template: `
    <header class="border-border mb-3.5 border-b pb-2">
      <h3 class="font-title text-foreground text-[20px] leading-[26px]">{{ title() }}</h3>
      @if (subtitle()) {
        <p class="text-faint mt-0.5 font-mono text-[10.5px] leading-[14px]">{{ subtitle() }}</p>
      }
    </header>
    <div class="min-w-0 flex-1">
      @if (empty()) {
        <p class="text-muted-foreground border-border flex min-h-24 items-center justify-center border border-dashed px-5 py-6 text-center text-[13px]">{{ empty() }}</p>
      } @else {
        <ng-content />
      }
    </div>
    @if (note() && !empty()) {
      <p class="text-faint mt-3 font-mono text-[10px] leading-[14px]">{{ note() }}</p>
    }
  `,
})
export class ChartCard {
  readonly title = input.required<string>();
  readonly subtitle = input<string | undefined>(undefined);
  readonly note = input<string | undefined>(undefined);
  /** When set, replaces the chart with this message (no data is not a flat line). */
  readonly empty = input<string | undefined>(undefined);
}
