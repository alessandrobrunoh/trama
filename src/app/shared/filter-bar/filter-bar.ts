// The filter / sort / group bar of the task table and saved views, as one reusable control (v3: mono
// chips "Status  is not Done", then "Group: status · Sort: priority" at the right). It edits nothing
// itself: it shows the current filters as chips, a "+ Filter" button that lists every other filterable
// field, and Group and Sort menus, and reports every change through outputs.
//
//   <app-filter-bar
//     entity="issue"
//     [filters]="filters()" (filtersChange)="filters.set($event)"
//     [defaultFields]="['status', 'assigneeId', 'thread']"      <!-- chips that are always there ("any") -->
//     [sort]="sort()" (sortChange)="setSort($event)"
//     [groupBy]="group()" (groupByChange)="setGroup($event)">
//     <div leading>…</div>                      <!-- optional, before the chips (layout switch) -->
//     <span hint>…</span>                       <!-- optional, between the chips and Group / Sort -->
//     <button trailing>…</button>               <!-- optional, after Sort -->
//   </app-filter-bar>
//
// Two things beyond plain field filters, both for the Tasks page:
//  - `extras`: chips for a filter the query model has no field for (a task's thread link). The owner
//    applies them; the bar only draws the chip and reports the pick (`extraChange`).
//  - `presets`: named views shown at the top of a field chip's menu (the All / Active / Backlog / Done /
//    Drafts views of the Status chip); the owner applies them (`presetPick`).
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
import { LucideDynamicIcon, LucidePlus, LucideX } from '@lucide/angular';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import {
  FIELD_DEFS,
  TramaStore,
  filterValues,
  setFilter,
  type ViewEntity,
  type ViewFilter,
} from '../../core';
import { OptionLeading, type PickOption } from '../../features/views/option-controls';
import {
  describeFilter,
  fieldLabel,
  fieldOptions,
  filterableFields,
  isEditableFilter,
  isNumberField,
} from '../../features/views/view-model';
import { FilterChip } from './filter-chip';

export interface FilterBarSort {
  field: string;
  direction: 'asc' | 'desc';
}

/** A chip for a filter that is not a field of the entity (the owner applies it). `selected` '' = any. */
export interface FilterBarExtra {
  id: string;
  label: string;
  options: readonly { value: string; label: string }[];
  selected: string;
}

/** A named view offered at the top of a field chip's menu. The first preset is the "no preset" one. */
export interface FilterPreset {
  id: string;
  label: string;
  /** Right-aligned count ("12"). */
  count?: number;
}

interface FieldChip {
  kind: 'field';
  field: string;
  label: string;
  numeric: boolean;
  min: string;
  editable: boolean;
  options: PickOption[];
  values: string[];
  /** Text of a filter the bar cannot edit ("Created after …"). */
  text: string;
  presets: readonly FilterPreset[];
  presetId: string;
  active: boolean;
  value: string;
  /** Always shown, even without a value. */
  fixed: boolean;
}

interface ExtraChip {
  kind: 'extra';
  id: string;
  label: string;
  options: readonly { value: string; label: string }[];
  selected: string;
  active: boolean;
  value: string;
}

type Chip = FieldChip | ExtraChip;

@Component({
  selector: 'app-filter-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmDropdownMenuImports, LucideDynamicIcon, OptionLeading, FilterChip],
  host: { class: 'flex min-w-0 items-center gap-2.5 max-md:flex-nowrap md:flex-wrap' },
  template: `
    <ng-content select="[leading]" />

    @for (c of chips(); track c.kind === 'field' ? c.field : c.id) {
      @if (c.kind === 'extra') {
        <app-filter-chip
          [label]="c.label"
          [value]="c.value"
          [active]="c.active"
          [menu]="extraMenu"
          [disabled]="!canEdit()"
          (removed)="extraChange.emit({ id: c.id, value: '' })"
        />
        <ng-template #extraMenu>
          <hlm-dropdown-menu class="w-52">
            <hlm-dropdown-menu-label>{{ c.label }}</hlm-dropdown-menu-label>
            <button
              hlmDropdownMenuRadio
              [checked]="!c.selected"
              [keepOpen]="false"
              (triggered)="extraChange.emit({ id: c.id, value: '' })"
            >
              <span class="text-muted-foreground">Any</span>
              <hlm-dropdown-menu-radio-indicator />
            </button>
            @for (o of c.options; track o.value) {
              <button
                hlmDropdownMenuRadio
                [checked]="c.selected === o.value"
                [keepOpen]="false"
                (triggered)="extraChange.emit({ id: c.id, value: o.value })"
              >
                {{ o.label }}
                <hlm-dropdown-menu-radio-indicator />
              </button>
            }
          </hlm-dropdown-menu>
        </ng-template>
      } @else if (c.numeric) {
        <span
          class="border-delta-line/40 bg-delta-line/8 inline-flex h-[22px] shrink-0 items-stretch border font-mono text-[11px] leading-[13px]"
        >
          <span class="text-muted-foreground flex items-center pl-2">{{ c.label }}</span>
          <span class="text-muted-foreground flex items-center px-1.5">at least</span>
          <input
            type="number"
            min="0"
            step="1"
            class="w-16 bg-transparent px-1 tabular-nums outline-none"
            [attr.aria-label]="c.label + ' minimum'"
            [value]="c.min"
            [disabled]="!canEdit()"
            (change)="setMin(c.field, $any($event.target).value)"
          />
          @if (canEdit()) {
            <button
              type="button"
              class="text-muted-foreground hover:text-foreground hover:bg-hover inline-flex w-5 items-center justify-center"
              [attr.aria-label]="'Remove ' + c.label + ' filter'"
              (click)="removeFilter(c.field)"
            >
              <svg [lucideIcon]="xIcon" [size]="11"></svg>
            </button>
          }
        </span>
      } @else if (c.editable) {
        <app-filter-chip
          [label]="c.label"
          [value]="c.value"
          [active]="c.active"
          [menu]="fieldMenu"
          [disabled]="!canEdit()"
          (removed)="clearChip(c)"
        />
        <ng-template #fieldMenu>
          <hlm-dropdown-menu class="max-h-80 w-60 overflow-y-auto">
            @if (c.presets.length) {
              <hlm-dropdown-menu-label>View</hlm-dropdown-menu-label>
              @for (p of c.presets; track p.id) {
                <button
                  hlmDropdownMenuRadio
                  [checked]="c.presetId === p.id"
                  [keepOpen]="false"
                  (triggered)="presetPick.emit({ field: c.field, id: p.id })"
                >
                  {{ p.label }}
                  @if (p.count !== undefined) {
                    <span class="text-faint ml-auto pr-5 font-mono text-[10.5px] tabular-nums">{{ p.count }}</span>
                  }
                  <hlm-dropdown-menu-radio-indicator />
                </button>
              }
              <hlm-dropdown-menu-separator />
              <hlm-dropdown-menu-label>{{ c.label }}</hlm-dropdown-menu-label>
            }
            @for (o of c.options; track o.value) {
              <button hlmDropdownMenuCheckbox [checked]="c.values.includes(o.value)" (triggered)="toggleValue(c, o.value)">
                <app-option-leading [option]="o" />
                <span class="truncate" [class.font-mono]="o.mono">{{ o.label }}</span>
                <hlm-dropdown-menu-checkbox-indicator />
              </button>
            }
            @if (c.values.length) {
              <hlm-dropdown-menu-separator />
              <button hlmDropdownMenuItem (triggered)="setValues(c.field, [])">
                <svg [lucideIcon]="xIcon" [size]="13"></svg> Clear
              </button>
            }
          </hlm-dropdown-menu>
        </ng-template>
      } @else {
        <span
          class="border-delta-line/40 bg-delta-line/8 inline-flex h-[22px] shrink-0 items-center gap-1.5 border pl-2 font-mono text-[11px] leading-[13px]"
          [class.pr-2]="!canEdit()"
        >
          {{ c.text }}
          @if (canEdit()) {
            <button
              type="button"
              class="text-muted-foreground hover:text-foreground hover:bg-hover inline-flex h-full w-5 items-center justify-center"
              [attr.aria-label]="'Remove ' + c.label + ' filter'"
              (click)="removeFilter(c.field)"
            >
              <svg [lucideIcon]="xIcon" [size]="11"></svg>
            </button>
          }
        </span>
      }
    }

    @if (canEdit() && addableFields().length) {
      <button
        type="button"
        class="text-faint hover:text-foreground hover:bg-hover inline-flex h-[22px] shrink-0 items-center gap-1 px-1.5 font-mono text-[11px] outline-none focus-visible:underline"
        [hlmDropdownMenuTrigger]="addFilter"
        aria-label="Add filter"
      >
        <svg [lucideIcon]="plusIcon" [size]="11"></svg>
        <span class="max-sm:hidden">Filter</span>
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
    @if (!chips().length && !canEdit()) {
      <span class="text-faint font-mono text-[11px]">No filters</span>
    }

    <span class="flex-1 max-md:hidden"></span>

    <ng-content select="[hint]" />

    <div class="text-faint flex shrink-0 items-center gap-1 font-mono text-[11px] max-md:ml-auto">
      @if (showGroup()) {
        <button
          type="button"
          class="hover:text-foreground aria-expanded:text-foreground px-0.5 outline-none focus-visible:underline disabled:pointer-events-none"
          [disabled]="!canEdit()"
          [hlmDropdownMenuTrigger]="groupMenu"
        >
          <span class="max-sm:hidden">{{ columns() ? 'Columns' : 'Group' }}: </span>{{ groupText() }}
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
      @if (showGroup() && showSort()) {
        <span aria-hidden="true">·</span>
      }
      @if (showSort()) {
        <button
          type="button"
          class="hover:text-foreground aria-expanded:text-foreground px-0.5 outline-none focus-visible:underline disabled:pointer-events-none"
          [disabled]="!canEdit()"
          [hlmDropdownMenuTrigger]="sortMenu"
          [attr.aria-label]="'Sort: ' + sortText() + (sort()?.direction === 'asc' ? ', ascending' : sort() ? ', descending' : '')"
        >
          <span class="max-sm:hidden">Sort: </span>{{ sortText() }}
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
  /** Chips that are always shown, in this order: a field of the entity, or the id of one of `extras`. */
  readonly defaultFields = input<readonly string[]>([]);
  readonly extras = input<readonly FilterBarExtra[]>([]);
  /** Named views at the top of a field's chip menu, by field. */
  readonly presets = input<Readonly<Record<string, readonly FilterPreset[]>>>({});
  /** The preset in force, by field (an id of `presets[field]`). */
  readonly presetActive = input<Readonly<Record<string, string>>>({});

  readonly filtersChange = output<ViewFilter[]>();
  readonly sortChange = output<FilterBarSort | null>();
  readonly groupByChange = output<string | null>();
  readonly extraChange = output<{ id: string; value: string }>();
  readonly presetPick = output<{ field: string; id: string }>();

  protected readonly xIcon = LucideX;
  protected readonly plusIcon = LucidePlus;

  /** Fields added with "Filter" that have no values yet (not part of the filters). */
  private readonly pending = signal<string[]>([]);

  protected readonly chips = computed<Chip[]>(() => {
    const entity = this.entity();
    const filters = this.filters();
    const extras = this.extras();
    const fixed = this.defaultFields();
    const out: Chip[] = [];
    const seen = new Set<string>();
    for (const key of fixed) {
      const extra = extras.find((e) => e.id === key);
      if (extra) {
        const o = extra.options.find((x) => x.value === extra.selected);
        out.push({ kind: 'extra', ...extra, active: !!extra.selected, value: o ? `is ${o.label}` : 'any' });
      } else {
        out.push(this.chip(entity, filters, key, true));
        seen.add(key);
      }
    }
    for (const f of filters) {
      if (seen.has(f.field)) continue;
      seen.add(f.field);
      out.push(this.chip(entity, filters, f.field, false));
    }
    for (const field of this.pending()) {
      if (seen.has(field)) continue;
      seen.add(field);
      out.push(this.chip(entity, filters, field, false));
    }
    return out;
  });
  protected readonly addableFields = computed(() => {
    const used = new Set(this.chips().flatMap((c) => (c.kind === 'field' ? [c.field] : [])));
    return filterableFields(this.entity()).filter((f) => !used.has(f.field));
  });
  protected readonly groupableFields = computed(() => FIELD_DEFS[this.entity()].filter((f) => f.groupable));
  protected readonly sortableFields = computed(() => FIELD_DEFS[this.entity()].filter((f) => f.sortable));
  protected readonly groupText = computed(() => {
    const g = this.groupBy();
    return (g ? fieldLabel(this.entity(), g) : 'none').toLowerCase();
  });
  protected readonly sortText = computed(() => {
    const s = this.sort();
    return (s ? fieldLabel(this.entity(), s.field) : 'default').toLowerCase();
  });

  constructor() {
    // Half-added chips belong to one entity: forget them when the owner switches.
    effect(() => {
      this.entity();
      untracked(() => this.pending.set([]));
    });
  }

  private chip(entity: ViewEntity, filters: readonly ViewFilter[], field: string, fixed: boolean): FieldChip {
    const f = filters.find((x) => x.field === field);
    const numeric = isNumberField(entity, field);
    const editable = !numeric && (!f || isEditableFilter(f));
    const options = editable ? fieldOptions(this.store, entity, field) : [];
    const values = f ? filterValues(filters, field) : [];
    const presets = this.presets()[field] ?? [];
    const presetId = this.presetActive()[field] ?? presets[0]?.id ?? '';
    const preset = presets.find((p) => p.id === presetId);
    const presetOn = !!preset && presetId !== presets[0]?.id;
    const byValue = new Map(options.map((o) => [o.value, o.label]));
    const parts: string[] = [];
    if (presetOn && preset) parts.push(preset.label);
    if (values.length) {
      const first = byValue.get(values[0]) ?? values[0];
      parts.push(`is ${first}${values.length > 1 ? ` +${values.length - 1}` : ''}`);
    }
    return {
      kind: 'field',
      field,
      label: fieldLabel(entity, field),
      numeric,
      min: numeric && f?.op === 'gte' ? String(f.value) : '',
      editable,
      options,
      values,
      text: f ? describeFilter(this.store, entity, f) : '',
      presets,
      presetId,
      active: values.length > 0 || presetOn || (!!f && !editable),
      value: parts.join(' · ') || 'any',
      fixed,
    };
  }

  protected addPending(field: string): void {
    this.pending.update((p) => (p.includes(field) ? p : [...p, field]));
  }

  protected toggleValue(c: FieldChip, value: string): void {
    this.setValues(
      c.field,
      c.values.includes(value) ? c.values.filter((v) => v !== value) : [...c.values, value],
    );
  }

  protected setValues(field: string, values: string[]): void {
    this.filtersChange.emit(setFilter(this.filters(), field, 'in', values));
    if (!values.length) this.pending.update((p) => p.filter((x) => x !== field));
  }

  /** × on a chip: drop its values, and its preset back to the first one. */
  protected clearChip(c: FieldChip): void {
    if (c.presets.length && c.presetId !== c.presets[0].id) {
      this.presetPick.emit({ field: c.field, id: c.presets[0].id });
    }
    if (c.fixed) this.setValues(c.field, []);
    else this.removeFilter(c.field);
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
