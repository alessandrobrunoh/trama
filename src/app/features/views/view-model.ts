// Pure helpers for saved views: value labels, picker options per field, filter descriptions.
import { LucideBox, LucideCircle, LucideHexagon, LucideScale, type LucideIcon } from '@lucide/angular';
import {
  DECISION_STATUS_META,
  FIELD_DEFS,
  ISSUE_KIND_META,
  ISSUE_STATUS_META,
  PRIORITY_META,
  PROJECT_HEALTH_META,
  PROJECT_STATUS_META,
  WORKSTREAM_STATUS_META,
  type ActorRef,
  type FieldDef,
  type NablaStore,
  type Priority,
  type Queryable,
  type SavedView,
  type ViewEntity,
  type ViewFilter,
} from '../../core';
import type { AnyStatus, StatusEntity } from '../../shared/status';
import type { PickOption } from './option-controls';

/** One group of a view (a list section, a board column, or a timeline band). */
export interface ViewGroup {
  key: string;
  label: string;
  status?: AnyStatus;
  priority?: Priority;
  actor?: { type: 'team' | 'user'; id: string };
  /** CSS colour of a leading dot (project status / health). */
  color?: string;
  items: Queryable[];
}

export const ENTITY_LABEL: Record<ViewEntity, string> = {
  workstream: 'Workstreams',
  issue: 'Issues',
  decision: 'Decisions',
  project: 'Projects',
};

/** Hexagon = workstreams (outcomes), circle = issues (demand), scale = decisions. */
export const ENTITY_ICON: Record<ViewEntity, LucideIcon> = {
  workstream: LucideHexagon,
  issue: LucideCircle,
  decision: LucideScale,
  project: LucideBox,
};

export const STATUS_ENTITY: Record<ViewEntity, StatusEntity> = {
  workstream: 'workstream',
  issue: 'issue',
  decision: 'other',
  project: 'other',
};

const SOURCE_LABEL: Record<string, string> = {
  manual: 'Manual',
  github: 'GitHub',
  gitlab: 'GitLab',
  email: 'Email',
  api: 'API',
  agent: 'Agent',
};

/** Fields offered as filter chips: value sets, and numbers (customer demand) as "at least N". */
export function filterableFields(entity: ViewEntity): FieldDef[] {
  return FIELD_DEFS[entity].filter(
    (f) => f.kind === 'enum' || f.kind === 'id' || f.kind === 'multi-id' || f.kind === 'tags' || f.kind === 'number',
  );
}

/** Is the field a number (compared with at least / at most)? */
export function isNumberField(entity: ViewEntity, field: string): boolean {
  return FIELD_DEFS[entity].find((f) => f.field === field)?.kind === 'number';
}

export function fieldLabel(entity: ViewEntity, field: string): string {
  return FIELD_DEFS[entity].find((f) => f.field === field)?.label ?? field;
}

function enumLabel(entity: ViewEntity, field: string, value: string): string | undefined {
  if (field === 'status') {
    const t =
      entity === 'workstream'
        ? WORKSTREAM_STATUS_META
        : entity === 'issue'
          ? ISSUE_STATUS_META
          : entity === 'project'
            ? PROJECT_STATUS_META
            : DECISION_STATUS_META;
    return (t as Record<string, { label: string }>)[value]?.label;
  }
  if (field === 'health') return PROJECT_HEALTH_META[value as keyof typeof PROJECT_HEALTH_META]?.label;
  if (field === 'priority') return PRIORITY_META[value as keyof typeof PRIORITY_META]?.label;
  if (field === 'kind') return ISSUE_KIND_META[value as keyof typeof ISSUE_KIND_META]?.label;
  if (field === 'source') return SOURCE_LABEL[value];
  return undefined;
}

/** Human label of one field value ('' = "No …"). */
export function valueLabel(store: NablaStore, entity: ViewEntity, field: string, value: string): string {
  const def = FIELD_DEFS[entity].find((f) => f.field === field);
  if (value === '') return `No ${(def?.label ?? field).toLowerCase()}`;
  if (field === 'labels') return store.settings().labels.find((l) => l.id === value)?.name ?? value;
  if (def?.kind === 'enum') return enumLabel(entity, field, value) ?? value;
  switch (def?.refersTo) {
    case 'team':
      return store.getTeam(value)?.name ?? value;
    case 'user':
      return store.getUser(value)?.name ?? value;
    case 'repository':
      return store.getRepository(value)?.fullName ?? value;
    case 'project':
      return store.getProject(value)?.name ?? value;
    case 'milestone': {
      const m = store.getMilestone(value);
      return m ? m.name : value;
    }
    case 'customer':
      return store.getCustomer(value)?.name ?? value;
    case 'customerTier':
      return store.settings().customerTiers.find((t) => t.id === value)?.name ?? value;
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
  // Project statuses have their own coloured dot (see valueDot), not a status glyph.
  if (entity === 'project' && field === 'status') return {};
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

const PROJECT_STATUS_COLOR: Record<string, string> = {
  backlog: 'var(--status-draft)',
  planned: 'var(--status-planned)',
  in_progress: 'var(--status-working)',
  paused: 'var(--status-needs-input)',
  completed: 'var(--status-shipped)',
  canceled: 'var(--status-draft)',
};
const PROJECT_HEALTH_COLOR: Record<string, string> = {
  on_track: 'var(--status-shipped)',
  at_risk: 'var(--status-needs-input)',
  off_track: 'var(--status-blocked)',
};

/** CSS colour of the dot that marks a project status / health value (undefined for every other field). */
export function valueColor(entity: ViewEntity, field: string, value: string): string | undefined {
  if (!value || entity !== 'project') return undefined;
  if (field === 'status') return PROJECT_STATUS_COLOR[value];
  if (field === 'health') return PROJECT_HEALTH_COLOR[value];
  return undefined;
}

/** All selectable values for a filterable field. */
export function fieldOptions(store: NablaStore, entity: ViewEntity, field: string): PickOption[] {
  const def = FIELD_DEFS[entity].find((f) => f.field === field);
  if (!def) return [];
  const opt = (value: string, extra: Partial<PickOption> = {}): PickOption => ({
    value,
    label: valueLabel(store, entity, field, value),
    ...valueGlyph(entity, field, value, store),
    color: valueColor(entity, field, value),
    ...extra,
  });
  if (def.kind === 'enum') return (def.values ?? []).map((v) => opt(v));
  if (field === 'labels') {
    return store.settings().labels.filter((l) => !l.archived).map((l) => opt(l.id, { color: l.color }));
  }
  if (def.kind === 'tags') {
    const set = new Set<string>();
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
    case 'project':
      return [...none, ...store.projects().map((p) => opt(p.id))];
    case 'workstream':
      return [...none, ...store.workstreams().map((w) => opt(w.id, { label: w.key, hint: w.title, mono: true }))];
    case 'milestone':
      return store.milestones().map((m) => opt(m.id, { hint: store.getProject(m.projectId)?.name }));
    case 'customer':
      return store.customers().filter((c) => !c.archivedAt).map((c) => opt(c.id, { hint: c.domain }));
    case 'customerTier':
      return store.settings().customerTiers.map((t) => opt(t.id));
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
  gte: 'at least',
  lte: 'at most',
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

/** Router commands to the workspace's timeline: its first timeline view (workstreams first), else the views list. */
export function timelineViewLink(store: NablaStore): string[] {
  const views = store.views();
  const view = views.find((v) => v.layout === 'timeline' && v.entity === 'workstream') ?? views.find((v) => v.layout === 'timeline');
  const base = ['/', store.slug() ?? '', 'views'];
  return view ? [...base, view.id] : base;
}
