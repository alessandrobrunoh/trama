import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/** Surface for one chart: title + one-line subtitle, the chart, and an optional caveat underneath. */
@Component({
  selector: 'app-chart-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'bg-card flex min-w-0 flex-col rounded-lg border p-4' },
  template: `
    <header class="mb-3">
      <h3 class="text-sm font-medium">{{ title() }}</h3>
      @if (subtitle()) {
        <p class="text-meta mt-0.5 text-[11px]">{{ subtitle() }}</p>
      }
    </header>
    <div class="min-w-0 flex-1">
      @if (empty()) {
        <p class="text-meta flex min-h-24 items-center justify-center py-6 text-center">{{ empty() }}</p>
      } @else {
        <ng-content />
      }
    </div>
    @if (note() && !empty()) {
      <p class="text-meta mt-3 text-[11px]">{{ note() }}</p>
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
