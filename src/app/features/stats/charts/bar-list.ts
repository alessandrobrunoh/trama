import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

export interface BarRow {
  key?: string;
  label: string;
  /** Small mono suffix, e.g. a team key. */
  hint?: string;
  value: number;
  /** Text shown at the bar tip; defaults to the value. */
  valueLabel?: string;
  /** Tooltip detail on hover/focus. */
  detail?: string;
  color?: string;
}

/** Horizontal bars, label left, value at the tip. Thin bars with a 4px rounded data-end on a shared baseline. */
@Component({
  selector: 'app-bar-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    @if (rows().length) {
      <ul class="flex flex-col" [attr.aria-label]="ariaLabel()">
        @for (row of rows(); track row.key ?? row.label) {
          <li
            class="hover:bg-hover focus-within:bg-hover -mx-2 grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)_3rem] items-center gap-3 rounded-md px-2 py-1.5 text-xs transition-colors"
            [attr.title]="row.detail ?? row.label + ': ' + (row.valueLabel ?? row.value)"
            tabindex="0"
            [class.cursor-pointer]="interactive()"
            [attr.role]="interactive() ? 'link' : null"
            (click)="interactive() && rowClick.emit(row)"
            (keydown.enter)="interactive() && rowClick.emit(row)"
          >
            <span class="flex min-w-0 items-baseline gap-1.5">
              <span class="truncate">{{ row.label }}</span>
              @if (row.hint) {
                <span class="text-meta shrink-0 font-mono text-[10px]">{{ row.hint }}</span>
              }
            </span>
            <span class="border-border-strong relative h-4 border-s">
              <span
                class="absolute inset-y-[5px] start-0 rounded-e-[4px] motion-safe:transition-[width]"
                [style.width.%]="width(row.value)"
                [style.min-width.px]="row.value > 0 ? 3 : 0"
                [style.background]="row.color ?? defaultColor()"
              ></span>
            </span>
            <span class="text-end font-medium tabular-nums">{{ row.valueLabel ?? row.value }}</span>
          </li>
        }
      </ul>
    } @else {
      <p class="text-meta py-6 text-center">{{ empty() }}</p>
    }
  `,
})
export class BarList {
  readonly rows = input.required<readonly BarRow[]>();
  readonly defaultColor = input('var(--chart-1)');
  readonly ariaLabel = input<string | undefined>(undefined);
  readonly empty = input('No data in this period');
  /** Rows act as links: click or Enter emits `rowClick`. */
  readonly interactive = input(false);
  readonly rowClick = output<BarRow>();
  /** Fixed scale end (e.g. 100 for percentages). Defaults to the largest row. */
  readonly scaleMax = input<number | undefined>(undefined, { alias: 'max' });
  private readonly max = computed(() => this.scaleMax() ?? Math.max(1, ...this.rows().map((r) => r.value)));

  protected width(value: number): number {
    return (value / this.max()) * 100;
  }
}
