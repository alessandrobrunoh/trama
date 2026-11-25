import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';

/** Five steps of one hue, from "none" to "most": the lightest step recedes toward the surface. */
const LEVEL_MIX = [0, 24, 46, 70, 94] as const;

/**
 * Rows x columns grid of one-hue cells (weekday x hour of the day). The darker the cell, the larger the value;
 * the scale is the largest cell, in five steps shown in the legend. Hover or arrow keys read one cell out in words;
 * a hidden table gives assistive technology the same numbers.
 */
@Component({
  selector: 'app-heatmap',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block min-w-0' },
  template: `
    <div
      class="outline-none focus-visible:ring-ring/50 focus-visible:ring-2"
      tabindex="0"
      role="group"
      [attr.aria-label]="ariaLabel()"
      (keydown)="onKey($event)"
      (blur)="active.set(null)"
    >
      <div class="grid items-center gap-[2px]" [style.grid-template-columns]="'2.25rem repeat(' + columns().length + ', minmax(0, 1fr))'" aria-hidden="true">
        <span></span>
        @for (c of columns(); track $index) {
          <span class="text-faint text-center font-mono text-[10px] leading-4 whitespace-nowrap tabular-nums">{{ $index % colStep() === 0 ? c : '' }}</span>
        }
        @for (r of rows(); track r; let ri = $index) {
          <span class="text-faint pe-1 font-mono text-[10.5px]">{{ r }}</span>
          @for (c of columns(); track $index; let ci = $index) {
            <span
              class="h-5 transition-[outline-color]"
              [style.background]="color(cell(ri, ci))"
              [class.outline-2]="isActive(ri, ci)"
              [class.outline-foreground]="isActive(ri, ci)"
              [class.outline]="isActive(ri, ci)"
              (pointerenter)="active.set([ri, ci])"
              (pointerleave)="active.set(null)"
            ></span>
          }
        }
      </div>
      <div class="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs">
        <p class="text-foreground min-h-4 font-mono text-[11px]" aria-live="polite">{{ readout() }}</p>
        <div class="text-faint flex items-center gap-1.5 font-mono text-[10.5px]" aria-hidden="true">
          <span>Less</span>
          @for (l of levels; track l) {
            <span class="size-3" [style.background]="levelColor(l)"></span>
          }
          <span>More</span>
        </div>
      </div>
    </div>
    <table class="sr-only">
      <caption>{{ ariaLabel() }}</caption>
      <thead>
        <tr>
          <th scope="col"></th>
          @for (c of columns(); track $index) {
            <th scope="col">{{ c }}</th>
          }
        </tr>
      </thead>
      <tbody>
        @for (r of rows(); track r; let ri = $index) {
          <tr>
            <th scope="row">{{ r }}</th>
            @for (c of columns(); track $index; let ci = $index) {
              <td>{{ format()(cell(ri, ci)) }}</td>
            }
          </tr>
        }
      </tbody>
    </table>
  `,
})
export class Heatmap {
  readonly rows = input.required<readonly string[]>();
  /** Column header labels; one is printed every `colStep`. */
  readonly columns = input.required<readonly string[]>();
  readonly values = input.required<readonly (readonly number[])[]>();
  readonly format = input<(value: number) => string>((v) => String(v));
  /** What the readout says for a cell: row label, column label, formatted value. */
  readonly describe = input<(row: string, col: string, value: string) => string>((r, c, v) => `${r}, ${c}: ${v}`);
  readonly colStep = input(3);
  readonly ariaLabel = input('Heatmap');

  protected readonly levels = [0, 1, 2, 3, 4];
  protected readonly active = signal<[number, number] | null>(null);
  private readonly max = computed(() => Math.max(0, ...this.values().map((r) => Math.max(0, ...r))));

  protected cell(r: number, c: number): number {
    return this.values()[r]?.[c] ?? 0;
  }

  private level(value: number): number {
    const max = this.max();
    if (value <= 0 || max <= 0) return 0;
    return Math.max(1, Math.ceil((value / max) * 4));
  }

  protected color(value: number): string {
    return this.levelColor(this.level(value));
  }

  protected levelColor(level: number): string {
    return level === 0 ? 'var(--secondary)' : `color-mix(in srgb, var(--chart-1) ${LEVEL_MIX[level]}%, transparent)`;
  }

  protected isActive(r: number, c: number): boolean {
    const a = this.active();
    return !!a && a[0] === r && a[1] === c;
  }

  protected readonly readout = computed(() => {
    const a = this.active();
    if (!a) return 'Hover a cell, or focus the grid and use the arrow keys.';
    const [r, c] = a;
    return this.describe()(this.rows()[r], this.columns()[c], this.format()(this.cell(r, c)));
  });

  protected onKey(event: KeyboardEvent): void {
    const rows = this.rows().length;
    const cols = this.columns().length;
    const [r, c] = this.active() ?? [0, 0];
    const move: Record<string, [number, number]> = {
      ArrowRight: [r, Math.min(cols - 1, c + 1)],
      ArrowLeft: [r, Math.max(0, c - 1)],
      ArrowDown: [Math.min(rows - 1, r + 1), c],
      ArrowUp: [Math.max(0, r - 1), c],
    };
    if (event.key === 'Escape') this.active.set(null);
    else if (move[event.key]) this.active.set(this.active() ? move[event.key] : [0, 0]);
    else return;
    event.preventDefault();
  }
}
