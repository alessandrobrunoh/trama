// Pure helpers for saved views: value labels, picker options per field, filter descriptions.
import { LucideCircle, LucideHexagon, LucideScale, type LucideIcon } from '@lucide/angular';
import {
  DECISION_STATUS_META,
  FIELD_DEFS,
  ISSUE_KIND_META,
  ISSUE_STATUS_META,
  PRIORITY_META,
  WORKSTREAM_STATUS_META,
  type ActorRef,
  type FieldDef,
  type NablaStore,
  type SavedView,
  type ViewEntity,
  type ViewFilter,
} from '../../core';
import type { AnyStatus, StatusEntity } from '../../shared/status';
import type { PickOption } from './option-controls';

export const ENTITY_LABEL: Record<ViewEntity, string> = {
  workstream: 'Workstreams',
  issue: 'Issues',
  decision: 'Decisions',
};

/** Hexagon = workstreams (outcomes), circle = issues (demand), scale = decisions. */
export const ENTITY_ICON: Record<ViewEntity, LucideIcon> = {
  workstream: LucideHexagon,
  issue: LucideCircle,
  decision: LucideScale,
};

export const STATUS_ENTITY: Record<ViewEntity, StatusEntity> = {
  workstream: 'workstream',
  issue: 'issue',
  decision: 'other',
};

const SOURCE_LABEL: Record<string, string> = {
  manual: 'Manual',
  github: 'GitHub',
  gitlab: 'GitLab',
  email: 'Email',
  api: 'API',
  agent: 'Agent',
};

/** Fields offered as filter chips (value-set fields only). */
export function filterableFields(entity: ViewEntity): FieldDef[] {
  return FIELD_DEFS[entity].filter((f) => f.kind === 'enum' || f.kind === 'id' || f.kind === 'multi-id' || f.kind === 'tags');
}

export function fieldLabel(entity: ViewEntity, field: string): string {
  return FIELD_DEFS[entity].find((f) => f.field === field)?.label ?? field;
}

function enumLabel(entity: ViewEntity, field: string, value: string): string | undefined {
  if (field === 'status') {
    const t =
      entity === 'workstream' ? WORKSTREAM_STATUS_META : entity === 'issue' ? ISSUE_STATUS_META : DECISION_STATUS_META;
    return (t as Record<string, { label: string }>)[value]?.label;
  }
  if (field === 'priority') return PRIORITY_META[value as keyof typeof PRIORITY_META]?.label;
  if (field === 'kind') return ISSUE_KIND_META[value as keyof typeof ISSUE_KIND_META]?.label;
  if (field === 'source') return SOURCE_LABEL[value];
  return undefined;
}

/** Human label of one field value ('' = "No …"). */
export function valueLabel(store: NablaStore, entity: ViewEntity, field: string, value: string): string {
  const def = FIELD_DEFS[entity].find((f) => f.field === field);
  if (value === '') return `No ${(def?.label ?? field).toLowerCase()}`;
  if (def?.kind === 'enum') return enumLabel(entity, field, value) ?? value;
  switch (def?.refersTo) {
    case 'team':
      return store.getTeam(value)?.name ?? value;
    case 'user':
      return store.getUser(value)?.name ?? value;
    case 'repository':
      return store.getRepository(value)?.fullName ?? value;
    case 'workstream': {
      const w = store.getWorkstream(value);
      return w ? `${w.key} ${w.title}` : value;
    }
  }
  return value;
}

/** Leading glyph data for a value (status glyph, actor avatar). */
export function valueGlyph(
  entity: ViewEntity,
  field: string,
  value: string,
  store: NablaStore,
): { status?: AnyStatus; statusEntity?: StatusEntity; actor?: ActorRef } {
  if (!value) return {};
  if (field === 'status') return { status: value as AnyStatus, statusEntity: STATUS_ENTITY[entity] };
  const def = FIELD_DEFS[entity].find((f) => f.field === field);
  if (def?.refersTo === 'team') return { actor: { type: 'team', id: value } };
  if (def?.refersTo === 'user') return { actor: { type: 'user', id: value } };
  if (def?.refersTo === 'workstream') {
    const w = store.getWorkstream(value);
    return w ? { status: w.status, statusEntity: 'workstream' } : {};
  }
  return {};
}

/** All selectable values for a filterable field. */
export function fieldOptions(store: NablaStore, entity: ViewEntity, field: string): PickOption[] {
  const def = FIELD_DEFS[entity].find((f) => f.field === field);
  if (!def) return [];
  const opt = (value: string, extra: Partial<PickOption> = {}): PickOption => ({
    value,
    label: valueLabel(store, entity, field, value),
    ...valueGlyph(entity, field, value, store),
    ...extra,
  });
  if (def.kind === 'enum') return (def.values ?? []).map((v) => opt(v));
  if (def.kind === 'tags') {
    const set = new Set<string>();
    if (entity === 'workstream') for (const w of store.workstreams()) for (const l of w.labels) set.add(l);
    if (entity === 'decision') for (const d of store.decisions()) for (const t of d.tags) set.add(t);
    return [...set].sort().map((v) => opt(v));
  }
  const none = def.kind === 'id' ? [opt('')] : [];
  switch (def.refersTo) {
    case 'team':
      return [...none, ...store.teams().map((t) => opt(t.id, { hint: t.key }))];
    case 'user':
      return [...none, ...store.users().map((u) => opt(u.id))];
    case 'repository':
      return [...none, ...store.repositories().map((r) => opt(r.id))];
    case 'workstream':
      return [...none, ...store.workstreams().map((w) => opt(w.id, { label: w.key, hint: w.title, mono: true }))];
  }
  return none;
}

/** Filters an OptionMenu can edit (value-set ops); others are shown read-only. */
export function isEditableFilter(f: ViewFilter): boolean {
  return f.op === 'in' || f.op === 'is';
}

const OP_LABEL: Record<ViewFilter['op'], string> = {
  is: 'is',
  is_not: 'is not',
  in: 'is any of',
  not_in: 'is none of',
  contains: 'contains',
  before: 'before',
  after: 'after',
};

export function describeFilter(store: NablaStore, entity: ViewEntity, f: ViewFilter): string {
  const values = (Array.isArray(f.value) ? f.value : [f.value]).map((v) =>
    f.op === 'before' || f.op === 'after' ? v.slice(0, 10) : valueLabel(store, entity, f.field, v),
  );
  const op = f.op === 'in' && values.length === 1 ? 'is' : OP_LABEL[f.op];
  return `${fieldLabel(entity, f.field)} ${op} ${values.join(', ')}`;
}

export function describeFilters(store: NablaStore, view: SavedView): string {
  if (!view.filters.length) return 'No filters';
  return view.filters.map((f) => describeFilter(store, view.entity, f)).join(' · ');
}
