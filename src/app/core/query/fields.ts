// Field registry for saved views / list screens: which fields can be filtered, sorted and
// grouped per entity, and how to read their value(s) from an item.
import type {
  Decision,
  Execution,
  ID,
  IntakeItem,
  ViewEntity,
  Workstream,
} from '../contracts/domain';
import {
  DECISION_STATUS_META,
  EXECUTION_STATE_META,
  INTAKE_KIND_META,
  INTAKE_STATE_META,
  PRIORITY_META,
  PROVIDER_META,
  WORKSTREAM_STATUS_META,
} from '../meta';

export type EntityOf = {
  workstream: Workstream;
  intake: IntakeItem;
  execution: Execution;
  decision: Decision;
};
export type Queryable = EntityOf[ViewEntity];

/** Extra data a field accessor may need beyond the item itself. */
export interface QueryContext {
  /** Needed by execution `ownerTeamId` / `status` of the parent workstream. */
  workstreamById?: ReadonlyMap<ID, Workstream>;
}

export type FieldKind = 'enum' | 'id' | 'multi-id' | 'tags' | 'text' | 'date';

export interface FieldDef {
  field: string;
  label: string;
  kind: FieldKind;
  /** Fixed value set for enums (in display order). */
  values?: readonly string[];
  /** For `id` / `multi-id` fields: the NablaStore collection the ids come from. */
  refersTo?: 'team' | 'user' | 'repository' | 'workstream' | 'actor';
  sortable: boolean;
  groupable: boolean;
}

const keysByOrder = (m: Record<string, { order: number }>) =>
  Object.keys(m).sort((a, b) => m[a].order - m[b].order);

export const FIELD_DEFS: Record<ViewEntity, readonly FieldDef[]> = {
  workstream: [
    { field: 'status', label: 'Status', kind: 'enum', values: keysByOrder(WORKSTREAM_STATUS_META), sortable: true, groupable: true },
    { field: 'ownerTeamId', label: 'Owner team', kind: 'id', refersTo: 'team', sortable: true, groupable: true },
    { field: 'participatingTeamIds', label: 'Participating teams', kind: 'multi-id', refersTo: 'team', sortable: false, groupable: false },
    { field: 'teamId', label: 'Any team (owner or participating)', kind: 'multi-id', refersTo: 'team', sortable: false, groupable: false },
    { field: 'accountableUserId', label: 'Accountable', kind: 'id', refersTo: 'user', sortable: true, groupable: true },
    { field: 'priority', label: 'Priority', kind: 'enum', values: keysByOrder(PRIORITY_META), sortable: true, groupable: true },
    { field: 'labels', label: 'Labels', kind: 'tags', sortable: false, groupable: false },
    { field: 'repositoryIds', label: 'Repositories', kind: 'multi-id', refersTo: 'repository', sortable: false, groupable: false },
    { field: 'targetDate', label: 'Target date', kind: 'date', sortable: true, groupable: false },
    { field: 'title', label: 'Title', kind: 'text', sortable: true, groupable: false },
    { field: 'createdAt', label: 'Created', kind: 'date', sortable: true, groupable: false },
    { field: 'updatedAt', label: 'Updated', kind: 'date', sortable: true, groupable: false },
  ],
  intake: [
    { field: 'kind', label: 'Kind', kind: 'enum', values: keysByOrder(INTAKE_KIND_META), sortable: true, groupable: true },
    { field: 'state', label: 'State', kind: 'enum', values: keysByOrder(INTAKE_STATE_META), sortable: true, groupable: true },
    { field: 'teamId', label: 'Team', kind: 'id', refersTo: 'team', sortable: true, groupable: true },
    { field: 'priority', label: 'Priority', kind: 'enum', values: keysByOrder(PRIORITY_META), sortable: true, groupable: true },
    { field: 'source', label: 'Source', kind: 'enum', values: ['manual', 'github', 'gitlab', 'email', 'api', 'agent'], sortable: false, groupable: true },
    { field: 'title', label: 'Title', kind: 'text', sortable: true, groupable: false },
    { field: 'createdAt', label: 'Created', kind: 'date', sortable: true, groupable: false },
    { field: 'updatedAt', label: 'Updated', kind: 'date', sortable: true, groupable: false },
  ],
  execution: [
    { field: 'state', label: 'State', kind: 'enum', values: keysByOrder(EXECUTION_STATE_META), sortable: true, groupable: true },
    { field: 'provider', label: 'Provider', kind: 'enum', values: keysByOrder(PROVIDER_META), sortable: true, groupable: true },
    { field: 'performers', label: 'Performers', kind: 'multi-id', refersTo: 'actor', sortable: false, groupable: true },
    { field: 'teamId', label: 'Team', kind: 'id', refersTo: 'team', sortable: true, groupable: true },
    { field: 'workstreamId', label: 'Workstream', kind: 'id', refersTo: 'workstream', sortable: true, groupable: true },
    { field: 'repositoryIds', label: 'Repositories', kind: 'multi-id', refersTo: 'repository', sortable: false, groupable: false },
    { field: 'title', label: 'Title', kind: 'text', sortable: true, groupable: false },
    { field: 'createdAt', label: 'Created', kind: 'date', sortable: true, groupable: false },
    { field: 'updatedAt', label: 'Updated', kind: 'date', sortable: true, groupable: false },
  ],
  decision: [
    { field: 'status', label: 'Status', kind: 'enum', values: keysByOrder(DECISION_STATUS_META), sortable: true, groupable: true },
    { field: 'tags', label: 'Tags', kind: 'tags', sortable: false, groupable: false },
    { field: 'originWorkstreamId', label: 'Origin workstream', kind: 'id', refersTo: 'workstream', sortable: false, groupable: true },
    { field: 'title', label: 'Title', kind: 'text', sortable: true, groupable: false },
    { field: 'decidedAt', label: 'Decided', kind: 'date', sortable: true, groupable: false },
    { field: 'createdAt', label: 'Created', kind: 'date', sortable: true, groupable: false },
    { field: 'updatedAt', label: 'Updated', kind: 'date', sortable: true, groupable: false },
  ],
};

export function fieldDef(entity: ViewEntity, field: string): FieldDef | undefined {
  return FIELD_DEFS[entity].find((f) => f.field === field);
}

/**
 * All values of `field` on `item` as strings (empty array = no value). Multi-valued fields
 * return several. Unknown fields fall back to the raw property.
 */
export function fieldValues(entity: ViewEntity, item: Queryable, field: string, ctx: QueryContext = {}): string[] {
  const any = item as unknown as Record<string, unknown>;
  if (entity === 'workstream' && field === 'teamId') {
    const w = item as Workstream;
    return [w.ownerTeamId, ...w.participatingTeamIds];
  }
  if (entity === 'execution' && field === 'performers') {
    return (item as Execution).performers.filter((p) => p.id).map((p) => p.id as string);
  }
  if (entity === 'execution' && field === 'ownerTeamId') {
    return [ctx.workstreamById?.get((item as Execution).workstreamId)?.ownerTeamId ?? ''].filter(Boolean);
  }
  const raw = any[field];
  if (raw === undefined || raw === null || raw === '') return [];
  if (Array.isArray(raw)) return raw.map(String);
  return [String(raw)];
}
