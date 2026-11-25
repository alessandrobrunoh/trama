// Pure helpers for saved views: value labels, picker options per field, filter descriptions.
import {
  LucideBox,
  LucideCircle,
  type LucideIcon,
} from '@lucide/angular';
import {
  FIELD_DEFS,
  ISSUE_KIND_META,
  ISSUE_STATUS_META,
  PRIORITY_META,
  PROJECT_STATUS_META,
  resolveStatusEntry,
  type ActorRef,
  type FieldDef,
  type TramaStore,
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
  actor?: { type: 'user'; id: string };
  /** CSS colour of a leading dot (fallback when there is no glyph). */
  color?: string;
  items: Queryable[];
}

export const ENTITY_LABEL: Record<ViewEntity, string> = {
  issue: 'Tasks',
  project: 'Projects',
};

/** Circle = tasks, box = projects. */
export const ENTITY_ICON: Record<ViewEntity, LucideIcon> = {
  issue: LucideCircle,
  project: LucideBox,
};

export const STATUS_ENTITY: Record<ViewEntity, StatusEntity> = {
  issue: 'issue',
  project: 'project',
};

const SOURCE_LABEL: Record<string, string> = {
  manual: 'Manual',
  github: 'GitHub',
  gitlab: 'GitLab',
  linear: 'Linear',
  email: 'Email',
  api: 'API',
  agent: 'Agent',
};

/** Fields offered as filter chips: value sets, and numbers as "at least N". */
export function filterableFields(entity: ViewEntity): FieldDef[] {
  return FIELD_DEFS[entity].filter(
    (f) =>
      f.kind === 'enum' ||
      f.kind === 'id' ||
      f.kind === 'multi-id' ||
      f.kind === 'tags' ||
      f.kind === 'number',
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
    const t = entity === 'issue' ? ISSUE_STATUS_META : PROJECT_STATUS_META;
    return (t as Record<string, { label: string }>)[value]?.label;
  }
  if (field === 'priority') return PRIORITY_META[value as keyof typeof PRIORITY_META]?.label;
  if (field === 'kind') return ISSUE_KIND_META[value as keyof typeof ISSUE_KIND_META]?.label;
  if (field === 'source') return SOURCE_LABEL[value];
  if (field === 'thread') return value === 'linked' ? 'Thread linked' : 'No thread';
  if (field === 'subtasks') return value === 'yes' ? 'Has sub-tasks' : 'No sub-tasks';
  return undefined;
}

/** Human label of one field value ('' = "No …"). */
/** Board columns for a status field: the workspace catalog, in catalog order. */
export function statusColumnIds(store: TramaStore, entity: ViewEntity, _field: string): string[] {
  const catalog = store.settings().statuses;
  if (entity === 'issue') return catalog.issue.map((entry) => entry.id);
  return catalog.project.map((entry) => entry.id);
}

export function valueLabel(store: TramaStore, entity: ViewEntity, field: string, value: string): string {
  const def = FIELD_DEFS[entity].find((f) => f.field === field);
  if (value === '') return `No ${(def?.label ?? field).toLowerCase()}`;
  if (field === 'labels') return store.settings().labels.find((l) => l.id === value)?.name ?? value;
  if (field === 'status') {
    const catalog = store.settings().statuses;
    const entries = entity === 'issue' ? catalog.issue : catalog.project;
    const named = resolveStatusEntry(entries, value)?.name;
    if (named) return named;
  }
  if (def?.kind === 'enum') return enumLabel(entity, field, value) ?? value;
  switch (def?.refersTo) {
    case 'user':
      return store.getUser(value)?.name ?? value;
    case 'project':
      return store.getProject(value)?.name ?? value;
    case 'milestone': {
      const m = store.getMilestone(value);
      return m ? m.name : value;
    }
  }
  return value;
}

/** Leading glyph data for a value (status glyph, actor avatar). */
export function valueGlyph(
  entity: ViewEntity,
  field: string,
  value: string,
  store: TramaStore,
): { status?: AnyStatus; statusEntity?: StatusEntity; actor?: ActorRef } {
  if (!value) return {};
  if (field === 'status')
    return { status: value as AnyStatus, statusEntity: STATUS_ENTITY[entity] };
  const def = FIELD_DEFS[entity].find((f) => f.field === field);
  if (def?.refersTo === 'user') return { actor: { type: 'user', id: value } };
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
/** CSS colour of the dot that marks a project status value (undefined for every other field). */
export function valueColor(entity: ViewEntity, field: string, value: string): string | undefined {
  if (!value || entity !== 'project') return undefined;
  if (field === 'status') return PROJECT_STATUS_COLOR[value];
  return undefined;
}

/** All selectable values for a filterable field. */
export function fieldOptions(store: TramaStore, entity: ViewEntity, field: string): PickOption[] {
  const def = FIELD_DEFS[entity].find((f) => f.field === field);
  if (!def) return [];
  const opt = (value: string, extra: Partial<PickOption> = {}): PickOption => ({
    value,
    label: valueLabel(store, entity, field, value),
    ...valueGlyph(entity, field, value, store),
    color: valueColor(entity, field, value),
    ...extra,
  });
  if (def.kind === 'enum' && field === 'status') {
    const catalog = store.settings().statuses;
    const entries = entity === 'issue' ? catalog.issue : catalog.project;
    return entries.map((entry) => opt(entry.id));
  }
  if (def.kind === 'enum') return (def.values ?? []).map((v) => opt(v));
  if (field === 'labels') {
    const scope = entity === 'issue' || entity === 'project' ? entity : null;
    return store
      .settings()
      .labels.filter((l) => !l.archived && (scope === null || l.scope === scope))
      .map((l) => opt(l.id, { color: l.color }));
  }
  if (def.kind === 'tags') return [];
  const none = def.kind === 'id' ? [opt('')] : [];
  switch (def.refersTo) {
    case 'user':
    {
      // The signed-in person first: "my" tasks are the filter people reach for most.
      const me = store.me()?.id;
      const users = store.users().map((u) => opt(u.id, u.id === me ? { hint: 'you' } : {}));
      return [...none, ...users.filter((o) => o.value === me), ...users.filter((o) => o.value !== me)];
    }
    case 'project':
      return [...none, ...store.projects().map((p) => opt(p.id))];
    case 'milestone':
      return store
        .milestones()
        .map((m) => opt(m.id, { hint: store.getProject(m.projectId)?.name }));
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
  all: 'includes all of',
  between: 'between',
  last: 'in the last (days)',
  next: 'in the next (days)',
  overdue: 'is overdue',
};

export function describeFilter(store: TramaStore, entity: ViewEntity, f: ViewFilter): string {
  const values = (Array.isArray(f.value) ? f.value : [f.value]).map((v) =>
    f.op === 'before' || f.op === 'after' ? v.slice(0, 10) : valueLabel(store, entity, f.field, v),
  );
  const op = f.op === 'in' && values.length === 1 ? 'is' : OP_LABEL[f.op];
  return `${fieldLabel(entity, f.field)} ${op} ${values.join(', ')}`;
}

export function describeFilters(store: TramaStore, view: SavedView): string {
  if (!view.filters.length) return 'No filters';
  return view.filters.map((f) => describeFilter(store, view.entity, f)).join(' · ');
}

/** Router commands to the first timeline view, or the views list when none exists. */
export function timelineViewLink(store: TramaStore): string[] {
  const views = store.views();
  const view = views.find((v) => v.layout === 'timeline');
  const base = ['/', store.slug() ?? '', 'views'];
  return view ? [...base, view.id] : base;
}
