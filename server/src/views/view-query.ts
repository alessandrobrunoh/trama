// Server-side evaluation of a saved view (filters, sort, group), used for the public link.
// Mirrors src/app/core/query/{fields,query}.ts, with one deliberate difference: only the fields
// listed below can be filtered, sorted or grouped on. An unknown field never falls back to the raw
// property, so a crafted view cannot be used to probe columns the view does not display.
import type { Demand, ViewEntity, ViewFilter } from '../contracts/domain.js';

type Row = Record<string, unknown>;
type FieldKind = 'enum' | 'id' | 'multi-id' | 'tags' | 'text' | 'date' | 'number';
export type RefKind = 'team' | 'user' | 'project' | 'workstream';

interface FieldSpec {
  kind: FieldKind;
  refersTo?: RefKind;
  values?: readonly string[];
  /** `false`: the field may filter and sort but never group, because group labels would name what the ids stand for. */
  groupable?: false;
}

const PRIORITIES = ['urgent', 'high', 'medium', 'low', 'none'];

const enumOf = (values: readonly string[]): FieldSpec => ({ kind: 'enum', values });
const ref = (refersTo: RefKind): FieldSpec => ({ kind: 'id', refersTo });
const refs = (refersTo: RefKind): FieldSpec => ({ kind: 'multi-id', refersTo });
const text: FieldSpec = { kind: 'text' };
const date: FieldSpec = { kind: 'date' };
const tags: FieldSpec = { kind: 'tags' };
const count: FieldSpec = { kind: 'number' };

/**
 * Customer demand on issues and projects (derived from the customer requests, see `Demand`). It can filter and
 * sort a public view but never group it, and nothing about a customer (name, tier name) is ever returned.
 */
const DEMAND_FIELDS: Record<string, FieldSpec> = {
  customerId: { kind: 'multi-id', groupable: false },
  customerTierId: { kind: 'multi-id', groupable: false },
  customerCount: count,
  requestCount: count,
  importantCount: count,
  customerRevenue: count,
  customerSize: count,
};
const DEMAND_NUMBER = {
  customerCount: 'customerCount',
  requestCount: 'requestCount',
  importantCount: 'importantCount',
  customerRevenue: 'revenue',
  customerSize: 'size',
} as const;

/** Queryable fields per entity; enum values are in display order. */
export const VIEW_FIELDS: Record<ViewEntity, Record<string, FieldSpec>> = {
  workstream: {
    status: enumOf(['blocked', 'needs_input', 'ready_to_land', 'in_review', 'working', 'planned', 'draft', 'shipped', 'canceled']),
    ownerTeamId: ref('team'),
    participatingTeamIds: refs('team'),
    teamId: refs('team'),
    accountableUserId: ref('user'),
    priority: enumOf(PRIORITIES),
    labels: tags,
    projectId: ref('project'),
    repositoryIds: { kind: 'multi-id' },
    startDate: date,
    targetDate: date,
    title: text,
    createdAt: date,
    updatedAt: date,
  },
  issue: {
    kind: enumOf(['incident', 'security', 'bug', 'feature', 'tech_debt', 'feedback', 'idea']),
    status: enumOf(['draft', 'backlog', 'todo', 'in_progress', 'in_review', 'done', 'canceled']),
    assigneeId: ref('user'),
    teamId: ref('team'),
    priority: enumOf(PRIORITIES),
    source: enumOf(['manual', 'github', 'gitlab', 'email', 'api', 'agent']),
    projectId: ref('project'),
    milestoneIds: { kind: 'multi-id' },
    labels: tags,
    title: text,
    createdAt: date,
    updatedAt: date,
    ...DEMAND_FIELDS,
  },
  decision: {
    status: enumOf(['draft', 'proposed', 'accepted', 'superseded', 'rejected']),
    tags,
    originWorkstreamId: ref('workstream'),
    title: text,
    decidedAt: date,
    createdAt: date,
    updatedAt: date,
  },
  project: {
    status: enumOf(['backlog', 'planned', 'in_progress', 'paused', 'completed', 'canceled']),
    priority: enumOf(PRIORITIES),
    health: enumOf(['on_track', 'at_risk', 'off_track']),
    leadId: ref('user'),
    teamIds: refs('team'),
    repositoryIds: { kind: 'multi-id' },
    labels: tags,
    targetDate: date,
    startDate: date,
    name: text,
    createdAt: date,
    updatedAt: date,
    ...DEMAND_FIELDS,
  },
};

export interface QueryContext {
  /** Workstream id -> its project id, so an issue's `projectId` also counts its workstreams' projects. */
  workstreamProjects?: ReadonlyMap<string, string | null>;
  /** Customer demand per issue and project id; without it the customer fields have no value. */
  demand?: ReadonlyMap<string, Demand>;
}

const asArray = (v: string | string[]): string[] => (Array.isArray(v) ? v : [v]);

function toStrings(raw: unknown): string[] {
  if (raw === undefined || raw === null || raw === '') return [];
  if (raw instanceof Date) return [raw.toISOString()];
  if (Array.isArray(raw)) return raw.filter((x): x is string | number => typeof x === 'string' || typeof x === 'number').map(String);
  return typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean' ? [String(raw)] : [];
}

/** All values of `field` on `item` as strings (empty = no value). Unknown fields have no value. */
export function fieldValues(entity: ViewEntity, item: Row, field: string, ctx: QueryContext = {}): string[] {
  if (!Object.hasOwn(VIEW_FIELDS[entity], field)) return [];
  if (Object.hasOwn(DEMAND_FIELDS, field)) {
    const demand = ctx.demand?.get(String(item['id']));
    if (field === 'customerId') return demand ? [...demand.customerIds] : [];
    if (field === 'customerTierId') return demand ? [...demand.tierIds] : [];
    // Numbers are 0 for work nobody asked for; without a demand map there is no value at all.
    return ctx.demand ? [String(demand?.[DEMAND_NUMBER[field as keyof typeof DEMAND_NUMBER]] ?? 0)] : [];
  }
  if (entity === 'workstream' && field === 'teamId') {
    return [...toStrings(item['ownerTeamId']), ...toStrings(item['participatingTeamIds'])];
  }
  if (entity === 'issue' && field === 'projectId') {
    const ids = new Set<string>(toStrings(item['projectId']));
    for (const w of toStrings(item['workstreamIds'])) {
      const p = ctx.workstreamProjects?.get(w);
      if (p) ids.add(p);
    }
    return [...ids];
  }
  return toStrings(item[field]);
}

export function matchesFilter(entity: ViewEntity, item: Row, filter: ViewFilter, ctx: QueryContext = {}): boolean {
  const values = fieldValues(entity, item, filter.field, ctx);
  // Rows saved before the DTO validated `value` may hold numbers or null: never throw on them.
  const want = asArray(filter.value).map((w) => (typeof w === 'string' ? w : w == null ? '' : String(w)));
  switch (filter.op) {
    case 'is':
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
    case 'gte':
    case 'lte': {
      const have = Number(values[0]);
      const limit = Number(want[0]);
      if (values.length === 0 || Number.isNaN(have) || Number.isNaN(limit)) return false;
      return filter.op === 'gte' ? have >= limit : have <= limit;
    }
    default:
      // An operator this server does not know must never widen what an anonymous reader sees.
      return false;
  }
}

export function applyFilters<T extends Row>(entity: ViewEntity, items: readonly T[], filters: readonly ViewFilter[] | undefined, ctx: QueryContext = {}): T[] {
  if (!filters?.length) return items.slice();
  return items.filter((item) => filters.every((f) => matchesFilter(entity, item, f, ctx)));
}

function enumOrder(entity: ViewEntity, field: string, value: string): number {
  const i = VIEW_FIELDS[entity][field]?.values?.indexOf(value) ?? -1;
  return i < 0 ? Number.POSITIVE_INFINITY : i;
}

function compareField(entity: ViewEntity, field: string, a: Row, b: Row, ctx: QueryContext): number {
  const va = fieldValues(entity, a, field, ctx)[0];
  const vb = fieldValues(entity, b, field, ctx)[0];
  if (VIEW_FIELDS[entity][field]?.kind === 'enum') {
    const oa = enumOrder(entity, field, va);
    const ob = enumOrder(entity, field, vb);
    if (oa !== ob) return oa < ob ? -1 : 1;
  }
  return va.localeCompare(vb, undefined, { numeric: true, sensitivity: 'base' });
}

/** Stable sort by a field; items without a value go last in both directions. */
export function sortItems<T extends Row>(entity: ViewEntity, items: readonly T[], sort: { field: string; direction: 'asc' | 'desc' } | null | undefined, ctx: QueryContext = {}): T[] {
  if (!sort || !Object.hasOwn(VIEW_FIELDS[entity], sort.field)) return items.slice();
  const dir = sort.direction === 'desc' ? -1 : 1;
  return items
    .map((item, index) => ({ item, index, empty: fieldValues(entity, item, sort.field, ctx).length === 0 }))
    .sort((x, y) => {
      if (x.empty !== y.empty) return x.empty ? 1 : -1;
      if (x.empty) return x.index - y.index;
      return dir * compareField(entity, sort.field, x.item, y.item, ctx) || x.index - y.index;
    })
    .map((x) => x.item);
}

export interface Group<T> {
  /** `''` = no value. */
  key: string;
  items: T[];
}

/** Group by a field (multi-valued fields place an item in each group); the "no value" group is last. */
export function groupItems<T extends Row>(entity: ViewEntity, items: readonly T[], groupBy: string | null | undefined, ctx: QueryContext = {}): Group<T>[] {
  if (!groupBy || !Object.hasOwn(VIEW_FIELDS[entity], groupBy) || VIEW_FIELDS[entity][groupBy].groupable === false) {
    return [{ key: '', items: items.slice() }];
  }
  const map = new Map<string, T[]>();
  for (const item of items) {
    const keys = fieldValues(entity, item, groupBy, ctx);
    for (const key of keys.length ? keys : ['']) {
      const bucket = map.get(key);
      if (bucket) bucket.push(item);
      else map.set(key, [item]);
    }
  }
  const isEnum = VIEW_FIELDS[entity][groupBy]?.kind === 'enum';
  return [...map.entries()]
    .map(([key, list]) => ({ key, items: list }))
    .sort((a, b) => {
      if (a.key === '' || b.key === '') return a.key === '' ? 1 : -1;
      if (isEnum) {
        const d = enumOrder(entity, groupBy, a.key) - enumOrder(entity, groupBy, b.key);
        if (d) return d;
      }
      return a.key.localeCompare(b.key);
    });
}
