// The command-style popover of the filter bar. Two steps, like Linear's: a searchable list of properties,
// then the values of the one picked (multi-select with counts). Opened on a chip's value, it starts at the
// values. Keyboard: ↑ ↓ move, Enter picks, Space ticks a value, Backspace goes back, Esc closes.
//
//   <app-filter-menu [entity]="'issue'" [filters]="filters()" [extended]="true" [items]="items()"
//     (filtersChange)="filters.set($event)" (done)="close()" />
//
// What the value step shows depends on the property and on the operator of its filter: a list of values
// (status, assignee, labels…), date presets with a custom range (created, due date…), one date (before /
// after), or a number (estimate, in the last N days).
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  type OnInit,
} from '@angular/core';
import { LucideChevronLeft, LucideChevronRight, LucideCheck, LucideDynamicIcon, LucideSearch } from '@lucide/angular';
import {
  DATE_PRESETS,
  FIELD_DEFS,
  TramaStore,
  applyFilters,
  buildFilter,
  datePresetOf,
  defaultOperator,
  fieldValues,
  filterFields,
  operatorOf,
  replaceFilter,
  resolveDate,
  valuesOf,
  type DatePreset,
  type FieldDef,
  type FilterOp,
  type Queryable,
  type QueryContext,
  type ViewEntity,
  type ViewFilter,
} from '../../core';
import { OptionLeading, type PickOption } from '../../features/views/option-controls';
import { fieldOptions } from '../../features/views/view-model';
import { iconOfField } from './filter-fields';

type Mode = 'list' | 'presets' | 'date' | 'number';

type Row =
  | { kind: 'field'; id: string; def: FieldDef; used: boolean }
  | { kind: 'option'; id: string; option: PickOption; count: number; checked: boolean }
  | { kind: 'preset'; id: string; preset: DatePreset; checked: boolean };

let nextId = 0;

@Component({
  selector: 'app-filter-menu',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideDynamicIcon, OptionLeading],
  host: { class: 'block w-72 text-[13px]', '(keydown)': 'onKey($event)' },
  template: `
    @if (stage() === 'values' && def(); as d) {
      <div
        class="border-border text-faint flex h-8 items-center gap-1.5 border-b px-2 font-mono text-[10.5px] tracking-[0.06em] uppercase"
      >
        @if (canGoBack()) {
          <button
            type="button"
            tabindex="-1"
            class="hover:text-foreground hover:bg-hover -ml-0.5 inline-flex size-5 items-center justify-center outline-none"
            aria-label="Back to properties"
            (mousedown)="$event.preventDefault()"
            (click)="back()"
          >
            <svg [lucideIcon]="backIcon" [size]="13"></svg>
          </button>
        }
        <svg [lucideIcon]="iconOf(d.field)" [size]="12" [class.ml-1]="!canGoBack()"></svg>
        <span>{{ d.label }}</span>
      </div>
    }

    @if (mode() === 'list') {
      <div class="border-border flex h-[37.5px] items-center gap-2 border-b px-3">
        <svg [lucideIcon]="searchIcon" [size]="13" class="text-faint shrink-0"></svg>
        <input
          type="text"
          class="placeholder:text-faint caret-primary min-w-0 flex-1 bg-transparent text-[13px] outline-hidden"
          role="combobox"
          aria-expanded="true"
          autocomplete="off"
          [attr.aria-controls]="uid + '-list'"
          [attr.aria-activedescendant]="rows().length ? uid + '-' + active() : null"
          [attr.aria-label]="stage() === 'fields' ? 'Filter by property' : 'Search values'"
          [placeholder]="stage() === 'fields' ? 'Filter by…' : 'Search…'"
          [value]="query()"
          (input)="setQuery($any($event.target).value)"
        />
      </div>
      <div
        class="max-h-72 overflow-y-auto py-1"
        role="listbox"
        [id]="uid + '-list'"
        [attr.aria-multiselectable]="stage() === 'values'"
      >
        @for (r of rows(); track r.id; let i = $index) {
          <div
            role="option"
            class="flex min-h-[34px] cursor-default items-center gap-2.5 px-2.5 select-none"
            [id]="uid + '-' + i"
            [class.bg-selected]="i === active()"
            [attr.aria-selected]="r.kind === 'option' ? r.checked : null"
            (mousedown)="$event.preventDefault()"
            (mousemove)="active.set(i)"
            (click)="activate(r)"
          >
            @switch (r.kind) {
              @case ('field') {
                <svg [lucideIcon]="iconOf(r.def.field)" [size]="14" class="text-muted-foreground shrink-0"></svg>
                <span class="min-w-0 flex-1 truncate">{{ r.def.label }}</span>
                @if (r.used) {
                  <span class="bg-primary size-1.5 shrink-0" aria-label="In use"></span>
                }
                <svg [lucideIcon]="nextIcon" [size]="13" class="text-faint shrink-0"></svg>
              }
              @case ('option') {
                <span
                  class="border-border-strong flex size-3.5 shrink-0 items-center justify-center border"
                  [class]="r.checked ? 'bg-primary border-primary text-primary-foreground' : ''"
                  aria-hidden="true"
                >
                  @if (r.checked) {
                    <svg [lucideIcon]="checkIcon" [size]="11"></svg>
                  }
                </span>
                <app-option-leading [option]="r.option" />
                <span class="min-w-0 truncate" [class.font-mono]="r.option.mono" [class.text-xs]="r.option.mono">{{
                  r.option.label
                }}</span>
                @if (r.option.hint) {
                  <span class="text-faint shrink-0 font-mono text-[10.5px]">{{ r.option.hint }}</span>
                }
                <span class="text-faint ml-auto shrink-0 pl-2 font-mono text-[10.5px] tabular-nums">{{ r.count }}</span>
              }
            }
          </div>
        } @empty {
          <div class="text-faint px-3 py-4 text-center font-mono text-[11px]">No matches</div>
        }
      </div>
    } @else if (mode() === 'presets') {
      <div class="max-h-72 overflow-y-auto py-1" role="listbox" [id]="uid + '-list'">
        @for (r of rows(); track r.id; let i = $index) {
          @if (r.kind === 'preset') {
            <div
              role="option"
              class="flex min-h-[34px] cursor-default items-center gap-2.5 px-2.5 select-none"
              [id]="uid + '-' + i"
              [class.bg-selected]="i === active()"
              [attr.aria-selected]="r.checked"
              (mousedown)="$event.preventDefault()"
              (mousemove)="active.set(i)"
              (click)="activate(r)"
            >
              <span class="min-w-0 flex-1 truncate">{{ r.preset.label }}</span>
              @if (r.checked) {
                <svg [lucideIcon]="checkIcon" [size]="14" class="text-foreground shrink-0"></svg>
              }
            </div>
          }
        }
      </div>
      <div class="border-border grid grid-cols-2 gap-2 border-t p-2.5">
        <label class="text-faint flex flex-col gap-1 font-mono text-[10.5px] tracking-[0.06em] uppercase">
          From
          <input
            type="date"
            class="border-border text-foreground focus:border-ring h-7 border bg-transparent px-1.5 text-xs normal-case outline-none"
            [value]="rangeFrom()"
            (change)="setRange($any($event.target).value, rangeTo())"
          />
        </label>
        <label class="text-faint flex flex-col gap-1 font-mono text-[10.5px] tracking-[0.06em] uppercase">
          To
          <input
            type="date"
            class="border-border text-foreground focus:border-ring h-7 border bg-transparent px-1.5 text-xs normal-case outline-none"
            [value]="rangeTo()"
            [min]="rangeFrom()"
            (change)="setRange(rangeFrom(), $any($event.target).value)"
          />
        </label>
      </div>
    } @else if (mode() === 'date') {
      <label class="text-faint flex flex-col gap-1.5 p-2.5 font-mono text-[10.5px] tracking-[0.06em] uppercase">
        {{ op() === 'before' ? 'Before' : 'After' }}
        <input
          type="date"
          class="border-border text-foreground focus:border-ring h-8 border bg-transparent px-2 text-[13px] normal-case outline-none"
          [value]="singleDate()"
          (change)="setSingle($any($event.target).value)"
          (keydown.enter)="done.emit()"
        />
      </label>
    } @else {
      <label class="text-faint flex flex-col gap-1.5 p-2.5 font-mono text-[10.5px] tracking-[0.06em] uppercase">
        {{ numberLabel() }}
        <input
          type="number"
          min="0"
          step="1"
          class="border-border text-foreground focus:border-ring h-8 border bg-transparent px-2 text-[13px] normal-case tabular-nums outline-none"
          [value]="numberValue()"
          (input)="setNumber($any($event.target).value)"
          (keydown.enter)="done.emit()"
        />
      </label>
    }

    <div
      class="border-border text-faint flex items-center gap-3 border-t px-3 py-1.5 font-mono text-[10.5px]"
      aria-hidden="true"
    >
      <span>↑↓ move</span>
      @if (mode() === 'list') {
        <span>{{ stage() === 'fields' ? '↵ open' : '↵ tick' }}</span>
      }
      @if (canGoBack()) {
        <span>⌫ back</span>
      }
      <span class="ml-auto">esc</span>
    </div>
  `,
})
export class FilterMenu implements OnInit {
  private readonly store = inject(TramaStore);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly entity = input.required<ViewEntity>();
  readonly filters = input.required<readonly ViewFilter[]>();
  /** Offer the task-only properties, dates and operators. */
  readonly extended = input(false);
  /** The list the counts are taken from. */
  readonly items = input<readonly Queryable[]>([]);
  readonly ctx = input<QueryContext>({});
  /** Open straight at this property's values (a chip's value segment): no property list, no going back. */
  readonly field = input<string | null>(null);

  readonly filtersChange = output<ViewFilter[]>();
  /** The menu has nothing more to ask: the owner closes the popover. */
  readonly done = output<void>();

  protected readonly uid = `fm${nextId++}`;
  protected readonly stage = signal<'fields' | 'values'>('fields');
  private readonly current = signal<string | null>(null);
  protected readonly query = signal('');
  protected readonly active = signal(0);
  private startedAtValues = false;

  protected readonly searchIcon = LucideSearch;
  protected readonly backIcon = LucideChevronLeft;
  protected readonly nextIcon = LucideChevronRight;
  protected readonly checkIcon = LucideCheck;
  protected readonly iconOf = iconOfField;

  protected readonly def = computed<FieldDef | undefined>(() => {
    const f = this.current();
    return f ? FIELD_DEFS[this.entity()].find((d) => d.field === f) : undefined;
  });
  private readonly filter = computed(() => {
    const f = this.current();
    return f ? this.filters().find((x) => x.field === f) : undefined;
  });
  /** The operator the values are read under: the filter's own, or the property's default. */
  protected readonly op = computed<FilterOp>(() => {
    const d = this.def();
    if (!d) return 'in';
    const f = this.filter();
    return f ? operatorOf(f, d.kind) : defaultOperator(d);
  });
  protected readonly canGoBack = computed(() => this.stage() === 'values' && !this.startedAtValues);

  protected readonly mode = computed<Mode>(() => {
    if (this.stage() === 'fields') return 'list';
    const d = this.def();
    const op = this.op();
    if (!d) return 'list';
    if (d.kind === 'date') {
      if (op === 'before' || op === 'after') return 'date';
      if (op === 'last' || op === 'next') return 'number';
      return 'presets';
    }
    if (d.kind === 'number') return 'number';
    return 'list';
  });

  private readonly fieldList = computed(() => filterFields(this.entity(), this.extended()));
  private readonly options = computed<PickOption[]>(() => {
    const d = this.def();
    if (!d || this.mode() !== 'list') return [];
    return fieldOptions(this.store, this.entity(), d.field);
  });
  /** How many of the list's tasks have each value, under the other filters. */
  private readonly counts = computed(() => {
    const d = this.def();
    const out = new Map<string, number>();
    if (!d || this.mode() !== 'list') return out;
    const rest = this.filters().filter((f) => f.field !== d.field);
    const pool = applyFilters(this.entity(), this.items() as never[], rest, this.ctx()) as Queryable[];
    for (const item of pool) {
      const values = fieldValues(this.entity(), item, d.field, this.ctx());
      for (const v of values.length ? values : ['']) out.set(v, (out.get(v) ?? 0) + 1);
    }
    return out;
  });
  private readonly selected = computed(() => {
    const f = this.filter();
    return new Set(f ? valuesOf(f) : []);
  });

  protected readonly rows = computed<Row[]>(() => {
    const q = this.query().trim().toLowerCase();
    if (this.stage() === 'fields') {
      const used = new Set(this.filters().map((f) => f.field));
      return this.fieldList()
        .filter((d) => !q || d.label.toLowerCase().includes(q))
        .map((def) => ({ kind: 'field', id: def.field, def, used: used.has(def.field) }));
    }
    if (this.mode() === 'presets') {
      const f = this.filter();
      const current = f && f.op === 'between' ? datePresetOf(valuesOf(f)) : undefined;
      return DATE_PRESETS.map((preset) => ({
        kind: 'preset',
        id: preset.id,
        preset,
        checked: current?.id === preset.id,
      }));
    }
    const counts = this.counts();
    const selected = this.selected();
    return this.options()
      .filter((o) => !q || `${o.label} ${o.hint ?? ''}`.toLowerCase().includes(q))
      .map((option) => ({
        kind: 'option',
        id: option.value || '__none',
        option,
        count: counts.get(option.value) ?? 0,
        checked: selected.has(option.value),
      }));
  });

  protected readonly numberLabel = computed(() => {
    const op = this.op();
    if (op === 'last' || op === 'next') return `Days ${op === 'last' ? 'back' : 'ahead'}`;
    return op === 'gte' ? 'At least' : op === 'lte' ? 'At most' : 'Value';
  });
  protected readonly numberValue = computed(() => {
    const f = this.filter();
    return f && !Array.isArray(f.value) ? f.value : '';
  });
  protected readonly singleDate = computed(() => {
    const f = this.filter();
    return (f && resolveDate(valuesOf(f)[0] ?? '', this.ctx().now)) ?? '';
  });
  protected readonly rangeFrom = computed(() => this.range()[0]);
  protected readonly rangeTo = computed(() => this.range()[1]);
  private readonly range = computed<[string, string]>(() => {
    const f = this.filter();
    if (!f || f.op !== 'between') return ['', ''];
    const [from, to] = valuesOf(f);
    return [resolveDate(from ?? '', this.ctx().now) ?? '', resolveDate(to ?? '', this.ctx().now) ?? ''];
  });

  constructor() {
    // Keep the highlighted row on screen while the arrows move it.
    effect(() => {
      const i = this.active();
      this.rows();
      queueMicrotask(() =>
        this.host.nativeElement.querySelector<HTMLElement>(`[id="${this.uid}-${i}"]`)?.scrollIntoView({ block: 'nearest' }),
      );
    });
    // A step change puts the cursor in the field of that step.
    effect(() => {
      this.mode();
      this.stage();
      setTimeout(() => this.host.nativeElement.querySelector<HTMLElement>('input')?.focus());
    });
  }

  ngOnInit(): void {
    const f = this.field();
    if (f && this.fieldList().some((d) => d.field === f)) {
      this.startedAtValues = true;
      this.pick(f);
    }
  }

  // ───────────────────────── steps ─────────────────────────

  protected setQuery(value: string): void {
    this.query.set(value);
    this.active.set(0);
  }

  private pick(field: string): void {
    this.current.set(field);
    this.query.set('');
    this.active.set(0);
    this.stage.set('values');
  }

  protected back(): void {
    if (!this.canGoBack()) return;
    this.current.set(null);
    this.query.set('');
    this.active.set(0);
    this.stage.set('fields');
  }

  protected activate(r: Row): void {
    if (r.kind === 'field') this.pick(r.def.field);
    else if (r.kind === 'option') this.toggle(r.option.value);
    else {
      const d = this.def();
      if (!d) return;
      this.put(buildFilter(d.field, 'between', [r.preset.from, r.preset.to]));
      this.done.emit();
    }
  }

  // ───────────────────────── editing ─────────────────────────

  private put(next: ViewFilter | null): void {
    const d = this.def();
    if (d) this.filtersChange.emit(replaceFilter(this.filters(), d.field, next));
  }

  /** Tick or untick a value; unticking the last one removes the filter. */
  private toggle(value: string): void {
    const d = this.def();
    if (!d) return;
    const f = this.filter();
    const op = f ? operatorOf(f, d.kind) : 'in';
    const keep: FilterOp = op === 'not_in' || op === 'all' ? op : 'in';
    const have = f && (op === 'in' || op === 'not_in' || op === 'all') ? valuesOf(f) : [];
    const values = have.includes(value) ? have.filter((v) => v !== value) : [...have, value];
    this.put(values.length ? buildFilter(d.field, keep, values) : null);
  }

  protected setRange(from: string, to: string): void {
    const d = this.def();
    if (!d || (!from && !to)) return;
    this.put(buildFilter(d.field, 'between', [from || to, to || from]));
  }

  protected setSingle(day: string): void {
    const d = this.def();
    if (!d) return;
    this.put(day ? buildFilter(d.field, this.op(), [day]) : null);
  }

  protected setNumber(raw: string): void {
    const d = this.def();
    if (!d) return;
    const n = Number(raw);
    if (!raw.trim() || !Number.isFinite(n) || n < 0) return this.put(null);
    this.put(buildFilter(d.field, this.op(), [String(n)]));
  }

  // ───────────────────────── keyboard ─────────────────────────

  protected onKey(e: KeyboardEvent): void {
    const rows = this.rows();
    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        this.done.emit();
        return;
      case 'ArrowDown':
      case 'ArrowUp': {
        if (!rows.length || this.mode() === 'date' || this.mode() === 'number') return;
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        this.active.update((i) => (i + step + rows.length) % rows.length);
        return;
      }
      case 'Enter': {
        const row = rows[this.active()];
        // Enter inside a date / number field applies it (its own handler), it does not pick a row.
        if ((e.target as HTMLElement).closest('label')) return;
        if (row && (this.mode() === 'list' || this.mode() === 'presets')) {
          e.preventDefault();
          this.activate(row);
        }
        return;
      }
      case 'ArrowRight': {
        const row = rows[this.active()];
        if (row?.kind === 'field' && this.query() === '') {
          e.preventDefault();
          this.activate(row);
        }
        return;
      }
      case ' ': {
        const row = rows[this.active()];
        if (row?.kind === 'option' && this.query() === '') {
          e.preventDefault();
          this.activate(row);
        }
        return;
      }
      case 'Backspace':
      case 'ArrowLeft':
        if (this.canGoBack() && this.mode() === 'list' && this.query() === '') {
          e.preventDefault();
          this.back();
        }
        return;
    }
  }
}
