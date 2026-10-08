// Generic filter / sort / group for workstreams, issues, decisions and projects,
// driven by the contract's ViewFilter / SavedView. Pure functions: use inside `computed()`.
import type { SavedView, ViewEntity, ViewFilter } from '../contracts/domain';
import {
  DECISION_STATUS_META,
  ISSUE_KIND_META,
  ISSUE_STATUS_META,
  PRIORITY_META,
  PROJECT_HEALTH_META,
  PROJECT_STATUS_META,
  PROVIDER_META,
  WORKSTREAM_STATUS_META,
} from '../meta';
import { EntityOf, FieldDef, QueryContext, Queryable, fieldDef, fieldValues } from './fields';

export interface SortSpec {
  field: string;
  direction: 'asc' | 'desc';
}

export interface QuerySpec {
  filters?: readonly ViewFilter[];
  sort?: SortSpec | null;
  groupBy?: string | null;
  /** Free-text search over title (+ key / objective / statement / body where present). */
  search?: string | null;
}

export interface Group<T> {
  /** Field value (`''` = items without a value). */
  key: string;
  items: T[];
}

/** Display order of an enum value for (entity, field); `Infinity` when unordered. */
export function enumOrder(entity: ViewEntity, field: string, value: string): number {
  const table = (): Record<string, { order: number }> | null => {
    if (field === 'status' && entity === 'workstream') return WORKSTREAM_STATUS_META;
    if (field === 'status' && entity === 'decision') return DECISION_STATUS_META;
    if (field === 'status' && entity === 'issue') return ISSUE_STATUS_META;
    if (field === 'status' && entity === 'project') return PROJECT_STATUS_META;
    if (field === 'health' && entity === 'project') return PROJECT_HEALTH_META;
    if (field === 'kind' && entity === 'issue') return ISSUE_KIND_META;
    if (field === 'priority') return PRIORITY_META;
    if (field === 'provider') return PROVIDER_META;
    return null;
  };
  const t = table();
  if (!t) return Number.POSITIVE_INFINITY;
  return t[value]?.order ?? Number.POSITIVE_INFINITY;
}

// ───────────────────────── filtering ─────────────────────────

const asArray = (v: string | string[]): string[] => (Array.isArray(v) ? v : [v]);

/** Does one item satisfy one filter? */
export function matchesFilter<E extends ViewEntity>(
  entity: E,
  item: EntityOf[E],
  filter: ViewFilter,
  ctx: QueryContext = {},
): boolean {
  const values = fieldValues(entity, item, filter.field, ctx);
  const want = asArray(filter.value);
  switch (filter.op) {
    case 'is':
      // multi-valued: any value equals; empty wanted ("") matches "no value"
      return want[0] === '' ? values.length === 0 : values.includes(want[0]);
    case 'is_not':
      return want[0] === '' ? values.length > 0 : !values.includes(want[0]);
    case 'in':
      return want.some((w) => (w === '' ? values.length === 0 : values.includes(w)));
    case 'not_in':
      return !want.some((w) => (w === '' ? values.length === 0 : values.includes(w)));
    case 'contains': {
      const needle = want[0]?.toLowerCase() ?? '';
      return values.some((v) => v.toLowerCase().includes(needle));
    }
    case 'before':
      return values.length > 0 && values[0] < want[0];
    case 'after':
      return values.length > 0 && values[0] > want[0];
    default:
      return true;
  }
}

/** Items matching ALL filters. */
export function applyFilters<E extends ViewEntity>(
  entity: E,
  items: readonly EntityOf[E][],
  filters: readonly ViewFilter[] | undefined,
  ctx: QueryContext = {},
): EntityOf[E][] {
  if (!filters?.length) return items.slice();
  return items.filter((item) => filters.every((f) => matchesFilter(entity, item, f, ctx)));
}

/** Case-insensitive text match over the searchable text of an item. */
export function matchesSearch(item: Queryable, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const a = item as unknown as Record<string, unknown>;
  const hay = [a['key'], a['title'], a['name'], a['summary'], a['objective'], a['statement'], a['body'], a['description']]
    .filter((x): x is string => typeof x === 'string')
    .join('\n')
    .toLowerCase();
  return q.split(/\s+/).every((word) => hay.includes(word));
}

// ───────────────────────── sorting ─────────────────────────

function compareField(entity: ViewEntity, def: FieldDef | undefined, field: string, a: Queryable, b: Queryable, ctx: QueryContext): number {
  const va = fieldValues(entity, a, field, ctx)[0];
  const vb = fieldValues(entity, b, field, ctx)[0];
  if (va === undefined && vb === undefined) return 0;
  if (va === undefined) return 1; // empty values sort last in both directions (handled by caller)
  if (vb === undefined) return -1;
  if (def?.kind === 'enum') {
    const oa = enumOrder(entity, field, va);
    const ob = enumOrder(entity, field, vb);
    if (oa !== ob) return oa < ob ? -1 : 1;
    return va.localeCompare(vb);
  }
  return va.localeCompare(vb, undefined, { numeric: true, sensitivity: 'base' });
}

/** Stable sort by a field; items with no value always go last. */
export function sortItems<E extends ViewEntity>(
  entity: E,
  items: readonly EntityOf[E][],
  sort: SortSpec | null | undefined,
  ctx: QueryContext = {},
): EntityOf[E][] {
  const out = items.slice();
  if (!sort) return out;
  const def = fieldDef(entity, sort.field);
  const dir = sort.direction === 'desc' ? -1 : 1;
  return out
    .map((item, index) => ({ item, index }))
    .sort((x, y) => {
      const ex = fieldValues(entity, x.item, sort.field, ctx).length === 0;
      const ey = fieldValues(entity, y.item, sort.field, ctx).length === 0;
      if (ex !== ey) return ex ? 1 : -1;
      return dir * compareField(entity, def, sort.field, x.item, y.item, ctx) || x.index - y.index;
    })
    .map((x) => x.item);
}

// ───────────────────────── grouping ─────────────────────────

/**
 * Group by a field. Group order: enum fields follow their display order; other fields sort
 * keys alphabetically; the "no value" group (`key: ''`) is last. Multi-valued fields place an
 * item in each of its groups. Pass `include` to force empty groups and fix their order (board columns, e.g. WORKSTREAM_STATUS_FLOW).
 */
export function groupItems<E extends ViewEntity>(
  entity: E,
  items: readonly EntityOf[E][],
  groupBy: string | null | undefined,
  ctx: QueryContext = {},
  include?: readonly string[],
): Group<EntityOf[E]>[] {
  if (!groupBy) return [{ key: '', items: items.slice() }];
  const map = new Map<string, EntityOf[E][]>();
  for (const key of include ?? []) map.set(key, []);
  for (const item of items) {
    const keys = fieldValues(entity, item, groupBy, ctx);
    for (const key of keys.length ? keys : ['']) {
      const bucket = map.get(key);
      if (bucket) bucket.push(item);
      else map.set(key, [item]);
    }
  }
  const def = fieldDef(entity, groupBy);
  return [...map.entries()]
    .map(([key, list]) => ({ key, items: list }))
    .sort((a, b) => {
      if (a.key === '' || b.key === '') return a.key === '' ? 1 : -1;
      if (include?.length) {
        // `include` fixes the order of the groups it names (board columns); others follow.
        const ia = include.indexOf(a.key);
        const ib = include.indexOf(b.key);
        if (ia !== ib) return (ia < 0 ? Infinity : ia) < (ib < 0 ? Infinity : ib) ? -1 : 1;
      }
      if (def?.kind === 'enum') {
        const d = enumOrder(entity, groupBy, a.key) - enumOrder(entity, groupBy, b.key);
        if (d) return d;
      }
      return a.key.localeCompare(b.key);
    });
}

// ───────────────────────── one-shot ─────────────────────────

/** Filter, search, sort — in that order. */
export function queryItems<E extends ViewEntity>(
  entity: E,
  items: readonly EntityOf[E][],
  spec: QuerySpec,
  ctx: QueryContext = {},
): EntityOf[E][] {
  let out = applyFilters(entity, items, spec.filters, ctx);
  if (spec.search) out = out.filter((i) => matchesSearch(i, spec.search as string));
  return sortItems(entity, out, spec.sort, ctx);
}

/** Filter, search, sort, then group (what a list/board screen renders). */
export function queryGroups<E extends ViewEntity>(
  entity: E,
  items: readonly EntityOf[E][],
  spec: QuerySpec,
  ctx: QueryContext = {},
  include?: readonly string[],
): Group<EntityOf[E]>[] {
  return groupItems(entity, queryItems(entity, items, spec, ctx), spec.groupBy, ctx, include);
}

/** The QuerySpec a SavedView describes. */
export function specFromView(view: Pick<SavedView, 'filters' | 'sort' | 'groupBy'>): QuerySpec {
  return { filters: view.filters, sort: view.sort ?? null, groupBy: view.groupBy ?? null };
}

// ───────────────────────── filter editing helpers ─────────────────────────

/** Add or replace the filter on `field` (one filter per field) — or remove it when `value` is empty. */
export function setFilter(
  filters: readonly ViewFilter[],
  field: string,
  op: ViewFilter['op'],
  value: string | string[] | null,
): ViewFilter[] {
  const rest = filters.filter((f) => f.field !== field);
  if (value === null || (Array.isArray(value) && value.length === 0)) return rest;
  return [...rest, { field, op, value }];
}

/** Toggle one value inside an `in` filter on `field`. */
export function toggleFilterValue(filters: readonly ViewFilter[], field: string, value: string): ViewFilter[] {
  const current = filters.find((f) => f.field === field);
  const set = new Set(current ? asArray(current.value) : []);
  if (set.has(value)) set.delete(value);
  else set.add(value);
  return setFilter(filters, field, 'in', [...set]);
}

/** Selected values of the `in` / `is` filter on `field` (empty when none). */
export function filterValues(filters: readonly ViewFilter[], field: string): string[] {
  const f = filters.find((x) => x.field === field);
  return f ? asArray(f.value) : [];
}
