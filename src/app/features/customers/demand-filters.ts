import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { LucideDynamicIcon, LucideTrendingUp } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmPopoverImports } from '@spartan-ng/helm/popover';
import { NablaStore, filterValues, setFilter, type ViewFilter } from '../../core';
import { Picker, type PickOption } from '../workstreams/picker';

/** The customer fields this control owns inside a list's filters. */
export const DEMAND_FILTER_FIELDS = ['customerId', 'customerTierId', 'customerCount', 'requestCount', 'importantCount', 'customerRevenue', 'customerSize'] as const;

/** Numeric thresholds, "at least N". */
const THRESHOLDS: readonly { field: string; label: string; hint: string }[] = [
  { field: 'customerCount', label: 'Customers', hint: 'Different customers who asked' },
  { field: 'requestCount', label: 'Requests', hint: 'Requests, a customer can ask twice' },
  { field: 'importantCount', label: 'Important requests', hint: 'Requests flagged important' },
  { field: 'customerRevenue', label: 'Revenue', hint: 'Their annual revenue, added up' },
  { field: 'customerSize', label: 'Largest customer', hint: 'People at the biggest customer' },
];

/** True when any customer demand filter is set. */
export function hasDemandFilter(filters: readonly ViewFilter[]): boolean {
  return filters.some((f) => (DEMAND_FILTER_FIELDS as readonly string[]).includes(f.field));
}

/** The filters without any customer demand filter. */
export function withoutDemandFilters(filters: readonly ViewFilter[]): ViewFilter[] {
  return filters.filter((f) => !(DEMAND_FILTER_FIELDS as readonly string[]).includes(f.field));
}

/**
 * Filter chips for customer demand on issue and project lists: which customer or tier asked, and "at least N"
 * thresholds for customers, requests, important requests, revenue and size. Hidden until the workspace has customers.
 *   <app-demand-filters [filters]="filters()" (filtersChange)="filters.set($event)" />
 */
@Component({
  selector: 'app-demand-filters',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButtonImports, HlmPopoverImports, LucideDynamicIcon, Picker],
  host: { class: 'contents' },
  template: `
    @if (store.customers().length) {
      <app-picker variant="chip" label="Customer" [multiple]="true" [options]="customerOptions()" [value]="values('customerId')" (valueChange)="set('customerId', $event)" />
      @if (tierOptions().length) {
        <app-picker variant="chip" label="Tier" [multiple]="true" [searchable]="false" [options]="tierOptions()" [value]="values('customerTierId')" (valueChange)="set('customerTierId', $event)" />
      }
      <hlm-popover align="start" sideOffset="4">
        <button
          hlmBtn
          hlmPopoverTrigger
          variant="outline"
          size="sm"
          class="h-7 shrink-0 gap-1.5 border-dashed px-2 text-xs font-normal"
          [class.border-solid]="activeThresholds() > 0"
          aria-label="Customer demand filters"
        >
          <svg [lucideIcon]="demandIcon" [size]="13"></svg>
          Demand
          @if (activeThresholds() > 0) {
            <span class="bg-primary text-primary-foreground rounded-full px-1.5 text-[10px] leading-4 tabular-nums">{{ activeThresholds() }}</span>
          }
        </button>
        <hlm-popover-content *hlmPopoverPortal="let ctx" class="w-72 p-0 text-[13px]">
          <div class="flex flex-col gap-2.5 p-3">
            <p class="text-muted-foreground text-xs">Show only work that at least this many customers asked for.</p>
            @for (t of thresholds; track t.field) {
              <label class="flex items-center justify-between gap-3" [title]="t.hint">
                <span>{{ t.label }}</span>
                <input
                  type="number"
                  min="0"
                  step="1"
                  class="border-input bg-background h-7 w-24 rounded-md border px-2 text-right text-xs tabular-nums"
                  placeholder="any"
                  [attr.aria-label]="t.label + ' at least'"
                  [value]="min(t.field)"
                  (change)="setMin(t.field, $any($event.target).value)"
                />
              </label>
            }
          </div>
          <div class="flex justify-end border-t px-3 py-2">
            <button hlmBtn variant="ghost" size="sm" class="text-muted-foreground h-7 text-xs" [disabled]="activeThresholds() === 0" (click)="clearThresholds()">Reset</button>
          </div>
        </hlm-popover-content>
      </hlm-popover>
    }
  `,
})
export class DemandFilters {
  protected readonly store = inject(NablaStore);

  readonly filters = input.required<readonly ViewFilter[]>();
  readonly filtersChange = output<ViewFilter[]>();

  protected readonly thresholds = THRESHOLDS;
  protected readonly demandIcon = LucideTrendingUp;

  protected readonly customerOptions = computed<PickOption[]>(() =>
    this.store
      .customers()
      .filter((c) => !c.archivedAt)
      .map((c) => ({ value: c.id, label: c.name, hint: c.domain })),
  );
  protected readonly tierOptions = computed<PickOption[]>(() =>
    this.store.settings().customerTiers.map((t) => ({ value: t.id, label: t.name, kind: 'label', color: t.color })),
  );
  protected readonly activeThresholds = computed(() => THRESHOLDS.filter((t) => this.min(t.field) !== '').length);

  protected values(field: string): string[] {
    return filterValues(this.filters(), field);
  }

  protected set(field: string, values: string[]): void {
    this.filtersChange.emit(setFilter(this.filters(), field, 'in', values));
  }

  /** Current minimum of a threshold field, '' when unset. */
  protected min(field: string): string {
    const f = this.filters().find((x) => x.field === field && x.op === 'gte');
    return f ? String(f.value) : '';
  }

  protected setMin(field: string, raw: string): void {
    const n = Number(raw);
    const value = raw.trim() && Number.isFinite(n) && n > 0 ? String(Math.floor(n)) : null;
    this.filtersChange.emit(setFilter(this.filters(), field, 'gte', value));
  }

  protected clearThresholds(): void {
    this.filtersChange.emit(this.filters().filter((f) => !THRESHOLDS.some((t) => t.field === f.field)));
  }
}
