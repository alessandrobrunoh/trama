import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import type { Priority, Project } from '../../../core';
import { PriorityIcon } from '../../../shared/priority-icon';
import { StatusIcon } from '../../../shared/status';
import { ProjectGlyph } from '../../projects/project-glyph';

export interface BarRow {
  key?: string;
  label: string;
  /** Task status glyph shown before the label. */
  status?: string;
  /** Priority glyph shown before the label. */
  priority?: Priority;
  /** Project glyph shown before the label. */
  project?: Project;
  /** Small mono suffix, e.g. a task key. */
  hint?: string;
  value: number;
  /** Text shown at the bar tip; defaults to the value. */
  valueLabel?: string;
  /** Tooltip detail on hover/focus. */
  detail?: string;
  color?: string;
}

/** Horizontal bars, label left, value at the end: hairline rows with a square bar on a `bg-secondary` track. */
@Component({
  selector: 'app-bar-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmTooltip, StatusIcon, PriorityIcon, ProjectGlyph],
  host: { class: 'block' },
  template: `
    @if (rows().length) {
      <ul class="border-border flex flex-col border-t" [attr.aria-label]="ariaLabel()">
        @for (row of rows(); track row.key ?? row.label) {
          <li
            class="border-border hover:bg-secondary focus-within:bg-secondary grid min-h-[34px] grid-cols-[minmax(0,9rem)_minmax(0,1fr)_3rem] items-center gap-3 border-b px-1 py-1.5 text-[12.5px] transition-colors"
            [hlmTooltip]="row.detail ?? row.label + ': ' + (row.valueLabel ?? row.value)"
            position="top"
            tabindex="0"
            [class.cursor-pointer]="interactive()"
            [attr.role]="interactive() ? 'link' : null"
            (click)="interactive() && rowClick.emit(row)"
            (keydown.enter)="interactive() && rowClick.emit(row)"
          >
            <span class="flex min-w-0 items-center gap-1.5">
              @if (row.status) {
                <app-status-icon [status]="row.status" entity="issue" [size]="13" />
              } @else if (row.priority) {
                <app-priority-icon [priority]="row.priority" />
              } @else if (row.project) {
                <app-project-glyph [project]="row.project" [size]="13" />
              }
              <span class="truncate">{{ row.label }}</span>
              @if (row.hint) {
                <span class="text-faint shrink-0 font-mono text-[10px]">{{ row.hint }}</span>
              }
            </span>
            <span class="bg-secondary relative h-1.5">
              <span
                class="absolute inset-y-0 start-0 motion-safe:transition-[width]"
                [style.width.%]="width(row.value)"
                [style.min-width.px]="row.value > 0 ? 3 : 0"
                [style.background]="row.color ?? defaultColor()"
              ></span>
            </span>
            <span class="text-foreground text-end font-mono text-[11px] tabular-nums">{{ row.valueLabel ?? row.value }}</span>
          </li>
        }
      </ul>
    } @else {
      <p class="text-muted-foreground border-border border border-dashed px-5 py-6 text-center text-[13px]">{{ empty() }}</p>
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
