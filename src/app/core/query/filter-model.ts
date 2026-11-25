// The model behind the task filters (Linear-style): which operators a property offers, the relative date
// tokens (`today`, `-7d`, `week_start`…), how a filter reads in a chip, and how a filter set is written
// into / read back from the URL. Pure functions, no Angular: unit-tested in filter-model.spec.ts.
import type { ViewEntity, ViewFilter } from '../contracts/domain';
import { FIELD_DEFS, type FieldDef, type FieldKind } from './fields';

/** What a chip's operator segment can say. `set` / `unset` are `is_not ''` / `is ''` in a ViewFilter. */
export type FilterOp =
  | 'in'
  | 'not_in'
  | 'all'
  | 'set'
  | 'unset'
  | 'eq'
  | 'gte'
  | 'lte'
  | 'between'
  | 'before'
  | 'after'
  | 'last'
  | 'next'
  | 'overdue';

/** Operators that take no value. */
export const VALUELESS_OPS: readonly FilterOp[] = ['set', 'unset', 'overdue'];

const ALL_VIEW_OPS: readonly ViewFilter['op'][] = [
  'is',
  'is_not',
  'in',
  'not_in',
  'contains',
  'before',
  'after',
  'gte',
  'lte',
  'all',
  'between',
  'last',
  'next',
  'overdue',
];

/** Operators whose value is a list (the rest hold one string). */
const LIST_OPS: readonly ViewFilter['op'][] = ['in', 'not_in', 'all', 'between'];

// ───────────────────────── fields and operators ─────────────────────────

/**
 * Fields offered as filters. `extended` (the task list) adds dates and the task-only fields; saved views
 * stay with what the server's public evaluator understands.
 */
export function filterFields(entity: ViewEntity, extended: boolean): FieldDef[] {
  return FIELD_DEFS[entity].filter((f) => {
    if (f.extended && !extended) return false;
    if (f.kind === 'date') return extended;
    return f.kind !== 'text';
  });
}

/** The operators a property offers, in menu order. */
export function operatorsFor(def: FieldDef, extended: boolean): FilterOp[] {
  switch (def.kind) {
    case 'enum':
      return ['in', 'not_in'];
    case 'id':
      return ['in', 'not_in', 'set', 'unset'];
    case 'multi-id':
      return ['in', 'not_in', 'set', 'unset'];
    case 'tags':
      return extended ? ['in', 'all', 'not_in', 'set', 'unset'] : ['in', 'not_in', 'set', 'unset'];
    case 'number':
      return extended ? ['eq', 'gte', 'lte', 'set', 'unset'] : ['gte', 'lte'];
    case 'date':
      return [
        'between',
        'before',
        'after',
        'last',
        'next',
        ...(def.field === 'dueDate' ? (['overdue'] as FilterOp[]) : []),
        'set',
        'unset',
      ];
    default:
      return ['in', 'not_in'];
  }
}

/** The operator a stored filter stands for. */
export function operatorOf(filter: ViewFilter, kind: FieldKind): FilterOp {
  const empty = Array.isArray(filter.value) ? filter.value.length === 1 && filter.value[0] === '' : filter.value === '';
  switch (filter.op) {
    case 'is':
      return empty ? 'unset' : kind === 'number' ? 'eq' : 'in';
    case 'is_not':
      return empty ? 'set' : 'not_in';
    case 'contains':
      return 'in';
    default:
      return filter.op;
  }
}

/** Plain words of an operator ("is any of"), for the chip and the operator menu. */
export function operatorLabel(op: FilterOp, kind: FieldKind, count: number): string {
  switch (op) {
    case 'in':
      if (kind === 'tags') return count > 1 ? 'includes any of' : 'includes';
      return count > 1 ? 'is any of' : 'is';
    case 'not_in':
      if (kind === 'tags') return 'excludes';
      return count > 1 ? 'is none of' : 'is not';
    case 'all':
      return 'includes all of';
    case 'set':
      return 'is set';
    case 'unset':
      return 'is not set';
    case 'eq':
      return 'is';
    case 'gte':
      return 'at least';
    case 'lte':
      return 'at most';
    case 'between':
      return 'is within';
    case 'before':
      return 'is before';
    case 'after':
      return 'is after';
    case 'last':
      return 'is in the last';
    case 'next':
      return 'is in the next';
    case 'overdue':
      return 'is overdue';
  }
}

/** Menu wording of an operator (no count: the menu lists every operator of the property). */
export function operatorMenuLabel(op: FilterOp, kind: FieldKind): string {
  if (op === 'in') return kind === 'tags' ? 'includes any of' : 'is any of';
  if (op === 'not_in') return kind === 'tags' ? 'excludes' : 'is none of';
  return operatorLabel(op, kind, 1);
}

/** The ViewFilter an operator and its values make. */
export function buildFilter(field: string, op: FilterOp, values: readonly string[]): ViewFilter {
  switch (op) {
    case 'set':
      return { field, op: 'is_not', value: '' };
    case 'unset':
      return { field, op: 'is', value: '' };
    case 'overdue':
      return { field, op: 'overdue', value: '' };
    case 'eq':
      return { field, op: 'is', value: values[0] ?? '' };
    case 'in':
    case 'not_in':
    case 'all':
      return { field, op, value: [...values] };
    case 'between':
      return { field, op, value: [values[0] ?? 'today', values[1] ?? values[0] ?? 'today'] };
    default:
      return { field, op, value: values[0] ?? '' };
  }
}

/** The values of a filter as a list (`set`, `unset` and `overdue` have none). */
export function valuesOf(filter: ViewFilter): string[] {
  const raw = Array.isArray(filter.value) ? filter.value : [filter.value];
  if (filter.op === 'overdue') return [];
  if ((filter.op === 'is' || filter.op === 'is_not') && raw.length === 1 && raw[0] === '') return [];
  return [...raw];
}

/** A sensible starting operator for a property that has just been picked. */
export function defaultOperator(def: FieldDef): FilterOp {
  return def.kind === 'date' ? 'between' : def.kind === 'number' ? 'gte' : 'in';
}

// ───────────────────────── dates ─────────────────────────

const pad = (n: number): string => String(n).padStart(2, '0');

/** `YYYY-MM-DD` of a date in local time. */
export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const shift = (d: Date, days: number): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate() + days);

/** Fields holding a calendar day (stored as midnight UTC): read the day as written, not shifted by the time zone. */
const CALENDAR_FIELDS = new Set(['dueDate', 'targetDate', 'startDate']);

/** The local day (`YYYY-MM-DD`) a field value falls on, or null when it is not a date. */
export function dayOf(field: string, value: string | undefined): string | null {
  if (!value) return null;
  if (CALENDAR_FIELDS.has(field) && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  const t = new Date(value);
  return Number.isNaN(t.getTime()) ? null : dayKey(t);
}

/** `today`, `-7d`, `+30d`, `week_start`… or a date, as a `YYYY-MM-DD` day; null when it is none of those. */
export function resolveDate(token: string, now: Date = new Date()): string | null {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (/^\d{4}-\d{2}-\d{2}/.test(token)) return token.slice(0, 10);
  switch (token) {
    case 'today':
      return dayKey(today);
    case 'yesterday':
      return dayKey(shift(today, -1));
    case 'tomorrow':
      return dayKey(shift(today, 1));
    case 'week_start':
      return dayKey(shift(today, -((today.getDay() + 6) % 7)));
    case 'week_end':
      return dayKey(shift(today, 6 - ((today.getDay() + 6) % 7)));
    case 'month_start':
      return dayKey(new Date(today.getFullYear(), today.getMonth(), 1));
    case 'month_end':
      return dayKey(new Date(today.getFullYear(), today.getMonth() + 1, 0));
  }
  const rel = /^([+-])(\d{1,4})d$/.exec(token);
  if (rel) return dayKey(shift(today, (rel[1] === '-' ? -1 : 1) * Number(rel[2])));
  return null;
}

/** A named range of days ("Last 7 days"), written as two tokens. */
export interface DatePreset {
  id: string;
  label: string;
  from: string;
  to: string;
}

export const DATE_PRESETS: readonly DatePreset[] = [
  { id: 'today', label: 'Today', from: 'today', to: 'today' },
  { id: 'yesterday', label: 'Yesterday', from: 'yesterday', to: 'yesterday' },
  { id: 'this_week', label: 'This week', from: 'week_start', to: 'week_end' },
  { id: 'last_7', label: 'Last 7 days', from: '-7d', to: 'today' },
  { id: 'last_30', label: 'Last 30 days', from: '-30d', to: 'today' },
  { id: 'this_month', label: 'This month', from: 'month_start', to: 'month_end' },
  { id: 'next_7', label: 'Next 7 days', from: 'today', to: '+7d' },
  { id: 'next_30', label: 'Next 30 days', from: 'today', to: '+30d' },
];

export function datePresetOf(value: readonly string[]): DatePreset | undefined {
  return DATE_PRESETS.find((p) => p.from === value[0] && p.to === value[1]);
}

/** "May 4" (or "May 4, 2025" in another year) for a `YYYY-MM-DD` day; other text is returned as is. */
export function formatDay(day: string, now: Date = new Date()): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(day);
  if (!m) return day;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}

/** How a date token reads: "Today", "May 4", "7 days ago". */
export function describeDateToken(token: string, now: Date = new Date()): string {
  const named: Record<string, string> = {
    today: 'Today',
    yesterday: 'Yesterday',
    tomorrow: 'Tomorrow',
    week_start: 'Start of week',
    week_end: 'End of week',
    month_start: 'Start of month',
    month_end: 'End of month',
  };
  if (named[token]) return named[token];
  const rel = /^([+-])(\d{1,4})d$/.exec(token);
  if (rel) return `${rel[2]} day${rel[2] === '1' ? '' : 's'} ${rel[1] === '-' ? 'ago' : 'ahead'}`;
  return formatDay(token, now);
}

/** Does the day a date field holds satisfy a date filter? Used by the query evaluator. */
export function matchesDate(
  filter: ViewFilter,
  field: string,
  value: string | undefined,
  now: Date,
  closed: boolean,
): boolean {
  const day = dayOf(field, value);
  if (day === null) return false;
  const want = Array.isArray(filter.value) ? filter.value : [filter.value];
  const today = dayKey(now);
  switch (filter.op) {
    case 'before': {
      const to = resolveDate(want[0] ?? '', now);
      return to !== null && day < to;
    }
    case 'after': {
      const from = resolveDate(want[0] ?? '', now);
      return from !== null && day > from;
    }
    case 'between': {
      const from = resolveDate(want[0] ?? '', now);
      const to = resolveDate(want[1] ?? want[0] ?? '', now);
      return from !== null && to !== null && day >= from && day <= to;
    }
    case 'last': {
      const n = Number(want[0]);
      return Number.isFinite(n) && day <= today && day >= dayKey(shift(now, -Math.max(0, Math.floor(n))));
    }
    case 'next': {
      const n = Number(want[0]);
      return Number.isFinite(n) && day >= today && day <= dayKey(shift(now, Math.max(0, Math.floor(n))));
    }
    case 'overdue':
      return day < today && !closed;
    default:
      return false;
  }
}

// ───────────────────────── URL ─────────────────────────

/** Most filters / values a link may carry. */
const MAX_FILTERS = 20;
const MAX_VALUES = 100;

const esc = (v: string): string => v.replace(/%/g, '%25').replace(/,/g, '%2C').replace(/:/g, '%3A');
const unesc = (v: string): string => v.replace(/%(25|2C|3A)/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)));

/** One filter as `field:op:value1,value2` (`,` `:` `%` in a value are percent-escaped). */
export function serializeFilter(filter: ViewFilter): string {
  const values = Array.isArray(filter.value) ? filter.value : [filter.value];
  return `${filter.field}:${filter.op}:${values.map(esc).join(',')}`;
}

/** The query values (`f=…`, repeated) of a filter set. */
export function serializeFilters(filters: readonly ViewFilter[]): string[] {
  return filters.map(serializeFilter);
}

/**
 * Filters written by {@link serializeFilters}. Anything that does not parse, names an unknown property or an
 * operator the property does not offer is dropped: a link cannot make the table throw or hide its own chips.
 */
export function parseFilters(raw: unknown, entity: ViewEntity, extended = true): ViewFilter[] {
  const list = (Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw]).slice(0, MAX_FILTERS);
  const out: ViewFilter[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const a = item.indexOf(':');
    const b = item.indexOf(':', a + 1);
    if (a <= 0 || b < 0) continue;
    const field = item.slice(0, a);
    const op = item.slice(a + 1, b) as ViewFilter['op'];
    if (!ALL_VIEW_OPS.includes(op) || seen.has(field)) continue;
    const def = filterFields(entity, extended).find((f) => f.field === field);
    if (!def) continue;
    const values = item
      .slice(b + 1)
      .split(',')
      .slice(0, MAX_VALUES)
      .map(unesc);
    const filter: ViewFilter = { field, op, value: LIST_OPS.includes(op) ? values : (values[0] ?? '') };
    if (!operatorsFor(def, extended).includes(operatorOf(filter, def.kind))) continue;
    seen.add(field);
    out.push(filter);
  }
  return out;
}

/** Same filters (order and values)? */
export function sameFilters(a: readonly ViewFilter[], b: readonly ViewFilter[]): boolean {
  const x = serializeFilters(a);
  const y = serializeFilters(b);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/** The filter set with the filter on `field` replaced in place (or appended), or removed when `next` is null. */
export function replaceFilter(
  filters: readonly ViewFilter[],
  field: string,
  next: ViewFilter | null,
): ViewFilter[] {
  const at = filters.findIndex((f) => f.field === field);
  if (at < 0) return next ? [...filters, next] : [...filters];
  if (!next) return filters.filter((_, i) => i !== at);
  return filters.map((f, i) => (i === at ? next : f));
}
