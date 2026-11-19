// The filter / sort / group bar of saved views, as one reusable control. It edits nothing itself: it
// shows the current filters as Linear-style chips (field · operator · value · ×), a "Filter" button
// that lists every filterable field, and Group and Sort menus on the right, and reports every change
// through outputs. The Tasks table, project task tabs and saved views all use it.
//
//   <app-filter-bar
//     entity="issue"
//     [filters]="filters()" (filtersChange)="filters.set($event)"
//     [sort]="sort()" (sortChange)="setSort($event)"
//     [groupBy]="group()" (groupByChange)="setGroup($event)">
//     <app-search-input leading ... />          <!-- optional, before the chips -->
//     <button trailing>…</button>               <!-- optional, after Sort -->
//   </app-filter-bar>
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import {
  LucideArrowDownWideNarrow,
  LucideArrowUpNarrowWide,
  LucideDynamicIcon,
  LucideListFilter,
  LucidePlus,
  LucideRows3,
  LucideX,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import {
  FIELD_DEFS,
  TramaStore,
  filterValues,
  setFilter,
  type ViewEntity,
  type ViewFilter,
} from '../../core';
import { OptionMenu } from '../../features/views/option-controls';
import {
  describeFilter,
  fieldLabel,
  fieldOptions,
  filterableFields,
  isEditableFilter,
  isNumberField,
} from '../../features/views/view-model';

export interface FilterBarSort {
  field: string;
  direction: 'asc' | 'desc';
}

@Component({
  selector: 'app-filter-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButtonImports, HlmDropdownMenuImports, LucideDynamicIcon, OptionMenu],
  host: { class: 'flex min-w-0 items-center gap-1.5 max-md:flex-nowrap md:flex-wrap' },
  template: `
    <ng-content select="[leading]" />

    @for (f of activeFilters(); track f.field) {
      @if (f.numeric) {
        <span class="bg-secondary inline-flex h-7 shrink-0 items-stretch gap-0.5 overflow-hidden rounded-md text-xs">
          <span class="text-muted-foreground flex items-center px-2">{{ f.label }}</span>
          <span class="text-muted-foreground flex items-center px-2">at least</span>
          <input
            type="number"
            min="0"
            step="1"
            class="w-20 bg-transparent px-2 text-xs tabular-nums outline-none"
            [attr.aria-label]="f.label + ' minimum'"
            [value]="f.min"
            [disabled]="!canEdit()"
            (change)="setMin(f.field, $any($event.target).value)"
          />
          @if (canEdit()) {
            <button
              type="button"
              class="text-muted-foreground hover:text-foreground hover:bg-accent inline-flex w-7 items-center justify-center"
              [attr.aria-label]="'Remove ' + f.label + ' filter'"
              (click)="removeFilter(f.field)"
            >
              <svg [lucideIcon]="xIcon" [size]="12"></svg>
            </button>
          }
        </span>
      } @else if (f.editable) {
        <span class="bg-secondary inline-flex h-7 shrink-0 items-stretch gap-0.5 overflow-hidden rounded-md text-xs">
          <span class="text-muted-foreground flex items-center px-2">{{ f.label }}</span>
          <span class="text-muted-foreground flex items-center px-2">{{
            f.values.length > 1 ? 'is any of' : 'is'
          }}</span>
          <app-option-menu
            variant="segment"
            [label]="f.label"
            [options]="f.options"
            [selected]="f.values"
            (selectedChange)="setValues(f.field, $event)"
            [multi]="true"
            [class.pointer-events-none]="!canEdit()"
          />
          @if (canEdit()) {
            <button
              type="button"
              class="text-muted-foreground hover:text-foreground hover:bg-accent inline-flex w-7 items-center justify-center"
              [attr.aria-label]="'Remove ' + f.label + ' filter'"
              (click)="removeFilter(f.field)"
            >
              <svg [lucideIcon]="xIcon" [size]="12"></svg>
            </button>
          }
        </span>
      } @else {
        <span class="bg-secondary inline-flex h-7 shrink-0 items-center gap-1 rounded-md ps-2 pe-1 text-xs">
          {{ f.text }}
          @if (canEdit()) {
            <button
              type="button"
              class="text-muted-foreground hover:text-foreground hover:bg-accent inline-flex size-5 items-center justify-center rounded"
              [attr.aria-label]="'Remove ' + f.label + ' filter'"
              (click)="removeFilter(f.field)"
            >
              <svg [lucideIcon]="xIcon" [size]="11"></svg>
            </button>
          }
        </span>
      }
    }

    @if (canEdit() && addableFields().length) {
      <button
        hlmBtn
        variant="ghost"
        size="sm"
        class="text-muted-foreground h-7 shrink-0 gap-1.5 px-2 text-xs"
        [hlmDropdownMenuTrigger]="addFilter"
      >
        <svg [lucideIcon]="activeFilters().length ? plusIcon : filterIcon" [size]="13"></svg>
        {{ activeFilters().length ? 'Filter' : 'Add filter' }}
      </button>
      <ng-template #addFilter>
        <hlm-dropdown-menu class="max-h-80 w-56 overflow-y-auto">
          <hlm-dropdown-menu-label>Filter by</hlm-dropdown-menu-label>
          @for (fd of addableFields(); track fd.field) {
            <button hlmDropdownMenuItem (triggered)="addPending(fd.field)">
              {{ fd.label }}
            </button>
          }
        </hlm-dropdown-menu>
      </ng-template>
    }
    @if (!activeFilters().length && !canEdit()) {
      <span class="text-meta">No filters</span>
    }

    <span class="flex-1 max-md:hidden"></span>

    <div class="flex shrink-0 items-center gap-1 max-md:ml-auto">
      @if (showGroup()) {
        <button
          hlmBtn
          variant="ghost"
          size="sm"
          class="text-muted-foreground h-7 gap-1.5 px-2 text-xs"
          [disabled]="!canEdit()"
          [hlmDropdownMenuTrigger]="groupMenu"
        >
          <svg [lucideIcon]="groupIcon" [size]="13"></svg>
          <span class="max-sm:hidden">{{ columns() ? 'Columns' : 'Group' }}:</span>
          <span class="text-foreground">{{ groupText() }}</span>
        </button>
        <ng-template #groupMenu>
          <hlm-dropdown-menu class="w-52">
            <hlm-dropdown-menu-label>{{ columns() ? 'Columns by' : 'Group by' }}</hlm-dropdown-menu-label>
            @if (!columns()) {
              <button
                hlmDropdownMenuRadio
                [checked]="!groupBy()"
                [keepOpen]="false"
                (triggered)="groupByChange.emit(null)"
              >
                No grouping
                <hlm-dropdown-menu-radio-indicator />
              </button>
            }
            @for (fd of groupableFields(); track fd.field) {
              <button
                hlmDropdownMenuRadio
                [checked]="groupBy() === fd.field"
                [keepOpen]="false"
                (triggered)="groupByChange.emit(fd.field)"
              >
                {{ fd.label }}
                <hlm-dropdown-menu-radio-indicator />
              </button>
            }
          </hlm-dropdown-menu>
        </ng-template>
      }

      @if (showSort()) {
        <button
          hlmBtn
          variant="ghost"
          size="sm"
          class="text-muted-foreground h-7 gap-1.5 px-2 text-xs"
          [disabled]="!canEdit()"
          [hlmDropdownMenuTrigger]="sortMenu"
        >
          <svg [lucideIcon]="sort()?.direction === 'asc' ? sortAscIcon : sortDescIcon" [size]="13"></svg>
          <span class="max-sm:hidden">Sort:</span>
          <span class="text-foreground">{{ sortText() }}</span>
        </button>
        <ng-template #sortMenu>
          <hlm-dropdown-menu class="w-52">
            <hlm-dropdown-menu-label>Order by</hlm-dropdown-menu-label>
            @if (defaultSort()) {
              <button
                hlmDropdownMenuRadio
                [checked]="!sort()"
                [keepOpen]="false"
                (triggered)="sortChange.emit(null)"
              >
                Default
                <hlm-dropdown-menu-radio-indicator />
              </button>
            }
            @for (fd of sortableFields(); track fd.field) {
              <button
                hlmDropdownMenuRadio
                [checked]="sort()?.field === fd.field"
                [keepOpen]="false"
                (triggered)="pickSort(fd.field)"
              >
                {{ fd.label }}
                <hlm-dropdown-menu-radio-indicator />
              </button>
            }
            @if (sort(); as s) {
              <hlm-dropdown-menu-separator />
              <button hlmDropdownMenuItem (triggered)="flipDirection()">
                <svg [lucideIcon]="s.direction === 'asc' ? sortDescIcon : sortAscIcon" [size]="14"></svg>
                {{ s.direction === 'asc' ? 'Descending' : 'Ascending' }}
              </button>
            }
          </hlm-dropdown-menu>
        </ng-template>
      }

      <ng-content select="[trailing]" />
    </div>
  `,
})
export class FilterBar {
  private readonly store = inject(TramaStore);

  readonly entity = input<ViewEntity>('issue');
  readonly filters = input<readonly ViewFilter[]>([]);
  /** Current ordering; `null` is the default order. */
  readonly sort = input<FilterBarSort | null>(null);
  /** Grouping field; `null` is no grouping. */
  readonly groupBy = input<string | null>(null);
  /** False shows everything read-only (a view someone else owns). */
  readonly canEdit = input(true);
  /** A board: the grouping is the columns and cannot be turned off. */
  readonly columns = input(false);
  readonly showGroup = input(true);
  readonly showSort = input(true);
  /** Offer "Default" in the Sort menu (otherwise a field is always chosen). */
  readonly defaultSort = input(true);

  readonly filtersChange = output<ViewFilter[]>();
  readonly sortChange = output<FilterBarSort | null>();
  readonly groupByChange = output<string | null>();

  protected readonly xIcon = LucideX;
  protected readonly plusIcon = LucidePlus;
  protected readonly filterIcon = LucideListFilter;
  protected readonly groupIcon = LucideRows3;
  protected readonly sortAscIcon = LucideArrowUpNarrowWide;
  protected readonly sortDescIcon = LucideArrowDownWideNarrow;

  /** Fields added with "Filter" that have no values yet (not part of the filters). */
  private readonly pending = signal<string[]>([]);

  protected readonly activeFilters = computed(() => {
    const entity = this.entity();
    const filters = this.filters();
    const fromFilters = filters.map((f) => this.chip(entity, filters, f.field, f));
    const pending = this.pending()
      .filter((field) => !filters.some((f) => f.field === field))
      .map((field) => this.chip(entity, filters, field, undefined));
    return [...fromFilters, ...pending];
  });
  protected readonly addableFields = computed(() => {
    const used = new Set(this.activeFilters().map((f) => f.field));
    return filterableFields(this.entity()).filter((f) => !used.has(f.field));
  });
  protected readonly groupableFields = computed(() => FIELD_DEFS[this.entity()].filter((f) => f.groupable));
  protected readonly sortableFields = computed(() => FIELD_DEFS[this.entity()].filter((f) => f.sortable));
  protected readonly groupText = computed(() => {
    const g = this.groupBy();
    return g ? fieldLabel(this.entity(), g) : 'None';
  });
  protected readonly sortText = computed(() => {
    const s = this.sort();
    return s ? fieldLabel(this.entity(), s.field) : 'Default';
  });

  constructor() {
    // Half-added chips belong to one entity: forget them when the owner switches.
    effect(() => {
      this.entity();
      untracked(() => this.pending.set([]));
    });
  }

  private chip(entity: ViewEntity, filters: readonly ViewFilter[], field: string, f: ViewFilter | undefined) {
    const numeric = isNumberField(entity, field);
    const editable = !numeric && (!f || isEditableFilter(f));
    return {
      field,
      label: fieldLabel(entity, field),
      numeric,
      min: numeric && f?.op === 'gte' ? String(f.value) : '',
      editable,
      options: editable ? fieldOptions(this.store, entity, field) : [],
      values: f ? filterValues(filters, field) : [],
      text: f ? describeFilter(this.store, entity, f) : '',
    };
  }

  protected addPending(field: string): void {
    this.pending.update((p) => (p.includes(field) ? p : [...p, field]));
  }

  protected setValues(field: string, values: string[]): void {
    this.filtersChange.emit(setFilter(this.filters(), field, 'in', values));
    if (!values.length) this.pending.update((p) => p.filter((x) => x !== field));
  }

  /** "At least N" on a numeric field; empty or invalid removes the filter. */
  protected setMin(field: string, raw: string): void {
    const n = Number(raw);
    if (!raw.trim() || !Number.isFinite(n) || n < 0) return this.removeFilter(field);
    this.filtersChange.emit(setFilter(this.filters(), field, 'gte', String(Math.floor(n))));
  }

  protected removeFilter(field: string): void {
    this.pending.update((p) => p.filter((x) => x !== field));
    if (this.filters().some((f) => f.field === field)) {
      this.filtersChange.emit(this.filters().filter((f) => f.field !== field));
    }
  }

  protected pickSort(field: string): void {
    const current = this.sort();
    const def = FIELD_DEFS[this.entity()].find((f) => f.field === field);
    const direction =
      current?.field === field
        ? current.direction
        : def?.kind === 'date' || def?.kind === 'number'
          ? 'desc'
          : 'asc';
    this.sortChange.emit({ field, direction });
  }

  protected flipDirection(): void {
    const s = this.sort();
    if (s) this.sortChange.emit({ field: s.field, direction: s.direction === 'asc' ? 'desc' : 'asc' });
  }
}
