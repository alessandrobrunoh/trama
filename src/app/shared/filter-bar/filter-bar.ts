// The filter / sort / group bar of the task table and saved views, as one reusable control. Linear-style:
// a "+ Filter" button (F) opens a command-style menu (properties, then values), and every active filter is
// a segmented chip: [icon Property] [operator ▾] [value(s) ▾] [×]. Then "Group: status · Sort: priority".
// It edits nothing itself: every change goes out through outputs.
//
//   <app-filter-bar
//     entity="issue" [extended]="true"
//     [filters]="filters()" (filtersChange)="filters.set($event)"
//     [items]="items()" [ctx]="ctx()"                   <!-- what the value counts are taken from -->
//     [locked]="scope()"                                <!-- a scope the user cannot remove (My tasks) -->
//     [sort]="sort()" (sortChange)="setSort($event)"
//     [groupBy]="group()" (groupByChange)="setGroup($event)">
//     <div leading>…</div>                      <!-- optional, before the chips (layout switch) -->
//     <span hint>…</span>                       <!-- optional, between the chips and Group / Sort -->
//     <button trailing>…</button>               <!-- optional, after Sort -->
//   </app-filter-bar>
//
// `presets`: named views shown as a chip of their own (the All / Active / Backlog / Done / Drafts views of
// the Status chip); the owner applies them (`presetPick`). `extended` turns on what only the task list
// offers: dates, estimate, thread, sub-tasks, creator and the date / "includes all" operators; saved views
// keep to what the server's public evaluator understands.
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import { HlmPopoverImports } from '@spartan-ng/helm/popover';
import {
  FIELD_DEFS,
  TramaStore,
  buildFilter,
  datePresetOf,
  defaultOperator,
  describeDateToken,
  filterFields,
  operatorLabel,
  operatorMenuLabel,
  operatorOf,
  operatorsFor,
  replaceFilter,
  valuesOf,
  type FieldDef,
  type FilterOp,
  type Queryable,
  type QueryContext,
  type ViewEntity,
  type ViewFilter,
} from '../../core';
import { type PickOption } from '../../features/views/option-controls';
import { fieldLabel, valueColor, valueGlyph, valueLabel } from '../../features/views/view-model';
import { iconOfField, nounOfField } from './filter-fields';
import { CHIP_SEGMENT, CHIP_SEGMENT_BUTTON, FilterChip } from './filter-chip';
import { FilterMenu } from './filter-menu';

export interface FilterBarSort {
  field: string;
  direction: 'asc' | 'desc';
}

/** A named view offered as a chip of its own. The first preset is the "no preset" one. */
export interface FilterPreset {
  id: string;
  label: string;
  /** Right-aligned count ("12"). */
  count?: number;
}

export type FilterMatch = 'all' | 'any';

/** What the operator segment does to the values when it changes. */
type ValueGroup = 'list' | 'range' | 'day' | 'num' | 'none';
const VALUE_GROUP: Record<FilterOp, ValueGroup> = {
  in: 'list',
  not_in: 'list',
  all: 'list',
  between: 'range',
  before: 'day',
  after: 'day',
  last: 'num',
  next: 'num',
  eq: 'num',
  gte: 'num',
  lte: 'num',
  set: 'none',
  unset: 'none',
  overdue: 'none',
};

interface Chip {
  field: string;
  label: string;
  icon: ReturnType<typeof iconOfField>;
  filter: ViewFilter;
  /** A field offered up front with no filter on it yet: "Assignee any". */
  placeholder: boolean;
  op: FilterOp;
  opText: string;
  ops: readonly { id: FilterOp; label: string }[];
  /** Chips the bar cannot edit (a text filter from an old view) are plain text. */
  editable: boolean;
  hasValue: boolean;
  valueText: string;
  /** Glyph of the single value (status square, avatar, label colour). */
  lead?: PickOption;
  aria: string;
}

interface ViewChip {
  field: string;
  label: string;
  value: string;
  active: boolean;
  presets: readonly FilterPreset[];
  presetId: string;
}

@Component({
  selector: 'app-filter-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    HlmDropdownMenuImports,
    HlmPopoverImports,
    FilterChip,
    FilterMenu,
  ],
  host: { class: 'flex min-w-0 items-center gap-2.5 max-md:flex-nowrap md:flex-wrap' },
  template: `
    <ng-content select="[leading]" />

    @for (v of viewChips(); track v.field) {
      <app-filter-chip
        [label]="v.label + ' ' + v.value"
        [active]="v.active"
        [removable]="v.active && canEdit()"
        (removed)="presetPick.emit({ field: v.field, id: v.presets[0].id })"
      >
        <span [class]="segment + ' text-muted-foreground'">{{ v.label }}</span>
        <button
          type="button"
          [class]="segmentButton"
          [hlmDropdownMenuTrigger]="viewMenu"
          [disabled]="!canEdit()"
          [attr.aria-label]="v.label + ' view: ' + v.value"
        >
          <span class="text-foreground truncate">{{ v.value }}</span>
        </button>
        <ng-template #viewMenu>
          <hlm-dropdown-menu class="max-h-80 w-56 overflow-y-auto">
            <hlm-dropdown-menu-label>{{ v.label }}</hlm-dropdown-menu-label>
            @for (p of v.presets; track p.id) {
              <button
                hlmDropdownMenuRadio
                [checked]="v.presetId === p.id"
                [keepOpen]="false"
                (triggered)="presetPick.emit({ field: v.field, id: p.id })"
              >
                {{ p.label }}
                @if (p.count !== undefined) {
                  <span class="text-faint ml-auto pr-5 font-mono text-[10.5px] tabular-nums">{{ p.count }}</span>
                }
                <hlm-dropdown-menu-radio-indicator />
              </button>
            }
          </hlm-dropdown-menu>
        </ng-template>
      </app-filter-chip>
    }

    @for (l of lockedChips(); track l.field) {
      <app-filter-chip [label]="l.aria" [active]="false" [removable]="false">
        <span [class]="segment" [attr.title]="'Always applied on this page'">
          <span class="text-muted-foreground">{{ l.label }}</span>
        </span>
        <span [class]="segment + ' text-foreground'">{{ l.opText }}</span>
        @if (l.hasValue) {
          <span [class]="segment">
            <span class="text-foreground truncate">{{ l.valueText }}</span>
          </span>
        }
      </app-filter-chip>
    }

    @for (c of chips(); track c.field) {
      <app-filter-chip
        [class]="c.placeholder ? 'max-md:hidden' : ''"
        [label]="c.aria"
        [active]="!c.placeholder"
        [removable]="!c.placeholder && canEdit()"
        (removed)="removeFilter(c.field)"
      >
        <span [class]="segment + ' text-muted-foreground'">{{ c.label }}</span>

        @if (c.placeholder) {
          <!-- a field the bar offers up front: "Assignee any" -->
        } @else if (c.editable && canEdit() && c.ops.length > 1) {
          <button
            type="button"
            [class]="segmentButton + ' text-foreground'"
            [hlmDropdownMenuTrigger]="opMenu"
            [attr.aria-label]="c.label + ' operator: ' + c.opText"
          >
            <span>{{ c.opText }}</span>
          </button>
          <ng-template #opMenu>
            <hlm-dropdown-menu class="w-52">
              <hlm-dropdown-menu-label>{{ c.label }}</hlm-dropdown-menu-label>
              @for (o of c.ops; track o.id) {
                <button
                  hlmDropdownMenuRadio
                  [checked]="o.id === c.op"
                  [keepOpen]="false"
                  (triggered)="changeOp(c, o.id)"
                >
                  {{ o.label }}
                  <hlm-dropdown-menu-radio-indicator />
                </button>
              }
            </hlm-dropdown-menu>
          </ng-template>
        } @else {
          <span [class]="segment + ' text-foreground'">{{ c.opText }}</span>
        }

        @if (c.hasValue) {
          @if (c.editable && canEdit()) {
            <hlm-popover
              class="contents"
              align="start"
              [sideOffset]="6"
              [state]="valueOpen() === c.field ? 'open' : 'closed'"
              (stateChanged)="onValueState(c, $event)"
            >
              <button
                hlmPopoverTrigger
                type="button"
                [class]="segmentButton"
                [attr.aria-label]="c.label + ' value: ' + c.valueText"
              >
                <span class="text-foreground truncate">{{ c.valueText }}</span>
              </button>
              <hlm-popover-content *hlmPopoverPortal class="w-72 gap-0 p-0">
                <app-filter-menu
                  [entity]="entity()"
                  [filters]="filters()"
                  [extended]="extended()"
                  [items]="items()"
                  [ctx]="ctx()"
                  [field]="c.field"
                  (filtersChange)="filtersChange.emit($event)"
                  (done)="valueOpen.set(null)"
                />
              </hlm-popover-content>
            </hlm-popover>
          } @else {
            <span [class]="segment">
              <span class="text-foreground truncate">{{ c.valueText }}</span>
            </span>
          }
        }
      </app-filter-chip>
    }

    @if (canEdit() && fields().length) {
      <!-- No visible "+" (the v3 bar has none): Filter · F opens this menu, anchored where the chips end. -->
      <hlm-popover
        class="contents"
        align="start"
        [sideOffset]="6"
        [state]="addOpen() ? 'open' : 'closed'"
        (stateChanged)="addOpen.set($event === 'open')"
      >
        <button
          hlmPopoverTrigger
          type="button"
          class="sr-only"
          tabindex="-1"
          aria-label="Add filter"
          aria-keyshortcuts="f"
        ></button>
        <hlm-popover-content *hlmPopoverPortal class="w-72 gap-0 p-0">
          <app-filter-menu
            [entity]="entity()"
            [filters]="filters()"
            [extended]="extended()"
            [items]="items()"
            [ctx]="ctx()"
            (filtersChange)="filtersChange.emit($event)"
            (done)="addOpen.set(false)"
          />
        </hlm-popover-content>
      </hlm-popover>
    }
    @if (!activeCount() && !lockedChips().length && !viewChips().length && !canEdit()) {
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
  /** The task list: dates, estimate, thread, sub-tasks, creator, and the date / "includes all" operators. */
  readonly extended = input(false);
  /** The list the counts in the value menus are taken from (the page's tasks, before these filters). */
  readonly items = input<readonly Queryable[]>([]);
  /** Context of the filters (today, which tasks have sub-tasks). */
  readonly ctx = input<QueryContext>({});
  /** A scope the user cannot remove, shown as locked chips before the others ("Assignee is me"). */
  readonly locked = input<readonly ViewFilter[]>([]);
  /** Fields shown up front as "Assignee any" chips until a filter is set on them (the v3 chip row). */
  readonly suggested = input<readonly string[]>([]);
  /** Named views as chips of their own, by field. */
  readonly presets = input<Readonly<Record<string, readonly FilterPreset[]>>>({});
  /** The preset in force, by field (an id of `presets[field]`). */
  readonly presetActive = input<Readonly<Record<string, string>>>({});

  readonly filtersChange = output<ViewFilter[]>();
  readonly sortChange = output<FilterBarSort | null>();
  readonly groupByChange = output<string | null>();
  readonly presetPick = output<{ field: string; id: string }>();

  protected readonly segment = CHIP_SEGMENT;
  protected readonly segmentButton = CHIP_SEGMENT_BUTTON;

  protected readonly addOpen = signal(false);
  /** The field whose value popover is open. */
  protected readonly valueOpen = signal<string | null>(null);

  protected readonly fields = computed(() => filterFields(this.entity(), this.extended()));
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

  protected readonly viewChips = computed<ViewChip[]>(() => {
    const out: ViewChip[] = [];
    for (const [field, presets] of Object.entries(this.presets())) {
      if (!presets.length) continue;
      const presetId = this.presetActive()[field] ?? presets[0].id;
      const on = presets.find((p) => p.id === presetId) ?? presets[0];
      out.push({
        field,
        label: fieldLabel(this.entity(), field),
        value: on.label,
        active: on.id !== presets[0].id,
        presets,
        presetId: on.id,
      });
    }
    return out;
  });
  /** Filters that are on (`chips`) plus the suggested fields, which stay in the row as "Field any" until used. */
  protected readonly chips = computed<Chip[]>(() => {
    const on = this.filters();
    const lockedFields = new Set(this.locked().map((f) => f.field));
    const available = new Set(this.fields().map((d) => d.field));
    const out: Chip[] = [];
    if (this.canEdit()) {
      for (const field of this.suggested()) {
        if (lockedFields.has(field) || !available.has(field)) continue;
        const f = on.find((x) => x.field === field);
        out.push(f ? this.chipOf(f) : this.placeholderOf(field));
      }
    }
    const shown = new Set(out.map((c) => c.field));
    for (const f of on) if (!shown.has(f.field)) out.push(this.chipOf(f));
    return out;
  });
  /** How many of `chips` have a filter on them. */
  protected readonly activeCount = computed(() => this.chips().filter((c) => !c.placeholder).length);
  protected readonly lockedChips = computed<Chip[]>(() => this.locked().map((f) => this.chipOf(f)));

  /** Open the "add filter" menu (the F shortcut). */
  openAdd(): void {
    if (this.canEdit() && this.fields().length) this.addOpen.set(true);
  }

  // ───────────────────────── chips ─────────────────────────

  private defOf(field: string): FieldDef {
    return (
      FIELD_DEFS[this.entity()].find((d) => d.field === field) ?? {
        field,
        label: field,
        kind: 'text',
        sortable: false,
        groupable: false,
      }
    );
  }

  private placeholderOf(field: string): Chip {
    const def = this.defOf(field);
    const op = defaultOperator(def);
    return {
      field,
      label: def.label,
      icon: iconOfField(field),
      filter: buildFilter(field, op, []),
      placeholder: true,
      op,
      opText: 'any',
      ops: [],
      editable: true,
      hasValue: true,
      valueText: 'any',
      aria: `${def.label} any`,
    };
  }

  private chipOf(filter: ViewFilter): Chip {
    const def = this.defOf(filter.field);
    const available = operatorsFor(def, this.extended());
    const op = operatorOf(filter, def.kind);
    const values = valuesOf(filter);
    const opText =
      filter.op === 'contains' ? 'contains' : operatorLabel(op, def.kind, values.length);
    const editable = available.includes(op) && filter.op !== 'contains';
    const { text, lead } = this.valueSummary(def, op, values);
    const hasValue = !['set', 'unset', 'overdue'].includes(op);
    return {
      field: filter.field,
      label: def.label,
      icon: iconOfField(filter.field),
      filter,
      placeholder: false,
      op,
      opText,
      ops: available.map((id) => ({ id, label: operatorMenuLabel(id, def.kind) })),
      editable,
      hasValue,
      valueText: text,
      lead,
      aria: `${def.label} ${opText}${hasValue ? ' ' + text : ''}`,
    };
  }

  private valueSummary(def: FieldDef, op: FilterOp, values: readonly string[]): { text: string; lead?: PickOption } {
    switch (op) {
      case 'between': {
        const preset = datePresetOf(values);
        return { text: preset ? preset.label : `${describeDateToken(values[0] ?? '')} – ${describeDateToken(values[1] ?? '')}` };
      }
      case 'before':
      case 'after':
        return { text: describeDateToken(values[0] ?? '') };
      case 'last':
      case 'next':
        return { text: `${values[0] ?? 0} day${Number(values[0]) === 1 ? '' : 's'}` };
      case 'eq':
      case 'gte':
      case 'lte':
        return { text: values[0] ?? '' };
      case 'set':
      case 'unset':
      case 'overdue':
        return { text: '' };
      default: {
        if (def.kind === 'text') return { text: values.join(', ') };
        if (values.length === 0) return { text: 'select…' };
        if (values.length > 1) return { text: `${values.length} ${nounOfField(def.field)}` };
        return { text: this.nameOf(def.field, values[0]), lead: this.leadOf(def.field, values[0]) };
      }
    }
  }

  private nameOf(field: string, value: string): string {
    if (FIELD_DEFS[this.entity()].find((d) => d.field === field)?.refersTo === 'user' && value === this.store.me()?.id) {
      return 'Me';
    }
    return valueLabel(this.store, this.entity(), field, value);
  }

  private leadOf(field: string, value: string): PickOption {
    const entity = this.entity();
    const label = field === 'labels' ? this.store.settings().labels.find((l) => l.id === value) : undefined;
    return {
      value,
      label: valueLabel(this.store, entity, field, value),
      ...valueGlyph(entity, field, value, this.store),
      color: label?.color ?? valueColor(entity, field, value),
    };
  }

  // ───────────────────────── editing ─────────────────────────

  protected removeFilter(field: string): void {
    this.filtersChange.emit(replaceFilter(this.filters(), field, null));
  }

  /** The operator segment: keep the values when the new operator reads them the same way, else start over. */
  protected changeOp(chip: Chip, op: FilterOp): void {
    if (op === chip.op) return;
    const from = VALUE_GROUP[chip.op];
    const to = VALUE_GROUP[op];
    let values: string[];
    if (from === to && to !== 'none') values = valuesOf(chip.filter);
    else if (to === 'range') values = ['week_start', 'week_end'];
    else if (to === 'day') values = ['today'];
    else if (to === 'num') values = [op === 'last' || op === 'next' ? '7' : '1'];
    else values = [];
    this.filtersChange.emit(replaceFilter(this.filters(), chip.field, buildFilter(chip.field, op, values)));
    // Nothing to read yet (any of … after "is set"): ask for the values straight away.
    if (to === 'list' && !values.length) this.valueOpen.set(chip.field);
  }

  protected onValueState(chip: Chip, state: 'open' | 'closed'): void {
    if (state === 'open') {
      this.valueOpen.set(chip.field);
      return;
    }
    if (this.valueOpen() === chip.field) this.valueOpen.set(null);
    // A list filter left with no value would hide everything: drop it.
    const f = this.filters().find((x) => x.field === chip.field);
    if (f && VALUE_GROUP[operatorOf(f, this.defOf(f.field).kind)] === 'list' && valuesOf(f).length === 0) {
      this.removeFilter(chip.field);
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
