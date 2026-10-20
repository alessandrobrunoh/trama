// Field registry for saved views / list screens: which fields can be filtered, sorted and
// grouped per entity, and how to read their value(s) from an item.
import type {
  Decision,
  Demand,
  ID,
  Issue,
  Project,
  ViewEntity,
} from '../contracts/domain';
import {
  DECISION_STATUS_META,
  ISSUE_KIND_META,
  ISSUE_STATUS_META,
  PRIORITY_META,
  PROJECT_HEALTH_META,
  PROJECT_STATUS_META,
} from '../meta';

export type EntityOf = {
  issue: Issue;
  decision: Decision;
  project: Project;
};
export type Queryable = EntityOf[ViewEntity];

/** Extra data a field accessor may need beyond the item itself. */
export interface QueryContext {
  /**
   * Customer demand per issue and project id (see `buildDemandIndex`). Needed by the customer fields of issues
   * and projects; without it they have no value.
   */
  demand?: ReadonlyMap<ID, Demand>;
}

export type FieldKind = 'enum' | 'id' | 'multi-id' | 'tags' | 'text' | 'date' | 'number';

export interface FieldDef {
  field: string;
  label: string;
  kind: FieldKind;
  /** Fixed value set for enums (in display order). */
  values?: readonly string[];
  /** For `id` / `multi-id` fields: the TramaStore collection the ids come from. */
  refersTo?: 'team' | 'user' | 'repository' | 'project' | 'milestone' | 'issue' | 'actor' | 'customer' | 'customerTier' | 'release';
  sortable: boolean;
  groupable: boolean;
}

const keysByOrder = (m: Record<string, { order: number }>) =>
  Object.keys(m).sort((a, b) => m[a].order - m[b].order);


/** Customer demand: derived from the customer requests on an issue or project (see `Demand`). */
const DEMAND_FIELDS: readonly FieldDef[] = [
  { field: 'customerId', label: 'Customer', kind: 'multi-id', refersTo: 'customer', sortable: false, groupable: true },
  { field: 'customerTierId', label: 'Customer tier', kind: 'multi-id', refersTo: 'customerTier', sortable: false, groupable: true },
  { field: 'customerCount', label: 'Customers', kind: 'number', sortable: true, groupable: false },
  { field: 'requestCount', label: 'Requests', kind: 'number', sortable: true, groupable: false },
  { field: 'importantCount', label: 'Important requests', kind: 'number', sortable: true, groupable: false },
  { field: 'customerRevenue', label: 'Customer revenue', kind: 'number', sortable: true, groupable: false },
  { field: 'customerSize', label: 'Largest customer size', kind: 'number', sortable: true, groupable: false },
];

/** The `Demand` property behind each numeric demand field. */
const DEMAND_NUMBER: Record<string, keyof Pick<Demand, 'customerCount' | 'requestCount' | 'importantCount' | 'revenue' | 'size'>> = {
  customerCount: 'customerCount',
  requestCount: 'requestCount',
  importantCount: 'importantCount',
  customerRevenue: 'revenue',
  customerSize: 'size',
};

const isDemandField = (field: string): boolean =>
  field === 'customerId' || field === 'customerTierId' || field in DEMAND_NUMBER;

export const FIELD_DEFS: Record<ViewEntity, readonly FieldDef[]> = {
  issue: [
    { field: 'kind', label: 'Type', kind: 'enum', values: keysByOrder(ISSUE_KIND_META), sortable: true, groupable: true },
    { field: 'status', label: 'Status', kind: 'enum', values: keysByOrder(ISSUE_STATUS_META), sortable: true, groupable: true },
    { field: 'assigneeId', label: 'Assignee', kind: 'id', refersTo: 'user', sortable: true, groupable: true },
    { field: 'teamId', label: 'Team', kind: 'id', refersTo: 'team', sortable: true, groupable: true },
    { field: 'priority', label: 'Priority', kind: 'enum', values: keysByOrder(PRIORITY_META), sortable: true, groupable: true },
    { field: 'source', label: 'Source', kind: 'enum', values: ['manual', 'github', 'gitlab', 'email', 'api', 'agent'], sortable: false, groupable: true },
    { field: 'projectId', label: 'Project', kind: 'id', refersTo: 'project', sortable: false, groupable: true },
    { field: 'releaseId', label: 'Release', kind: 'id', refersTo: 'release', sortable: false, groupable: true },
    { field: 'milestoneIds', label: 'Milestones', kind: 'multi-id', refersTo: 'milestone', sortable: false, groupable: false },
    { field: 'labels', label: 'Labels', kind: 'tags', sortable: false, groupable: false },
    { field: 'title', label: 'Title', kind: 'text', sortable: true, groupable: false },
    { field: 'createdAt', label: 'Created', kind: 'date', sortable: true, groupable: false },
    { field: 'updatedAt', label: 'Updated', kind: 'date', sortable: true, groupable: false },
    ...DEMAND_FIELDS,
  ],
  decision: [
    { field: 'status', label: 'Status', kind: 'enum', values: keysByOrder(DECISION_STATUS_META), sortable: true, groupable: true },
    { field: 'tags', label: 'Tags', kind: 'tags', sortable: false, groupable: false },
    { field: 'originIssueId', label: 'Origin issue', kind: 'id', refersTo: 'issue', sortable: false, groupable: true },
    { field: 'title', label: 'Title', kind: 'text', sortable: true, groupable: false },
    { field: 'decidedAt', label: 'Decided', kind: 'date', sortable: true, groupable: false },
    { field: 'createdAt', label: 'Created', kind: 'date', sortable: true, groupable: false },
    { field: 'updatedAt', label: 'Updated', kind: 'date', sortable: true, groupable: false },
  ],
  project: [
    { field: 'status', label: 'Status', kind: 'enum', values: keysByOrder(PROJECT_STATUS_META), sortable: true, groupable: true },
    { field: 'priority', label: 'Priority', kind: 'enum', values: keysByOrder(PRIORITY_META), sortable: true, groupable: true },
    { field: 'health', label: 'Health', kind: 'enum', values: keysByOrder(PROJECT_HEALTH_META), sortable: true, groupable: true },
    { field: 'leadId', label: 'Lead', kind: 'id', refersTo: 'user', sortable: true, groupable: true },
    { field: 'teamIds', label: 'Teams', kind: 'multi-id', refersTo: 'team', sortable: false, groupable: true },
    { field: 'repositoryIds', label: 'Repositories', kind: 'multi-id', refersTo: 'repository', sortable: false, groupable: false },
    { field: 'labels', label: 'Labels', kind: 'tags', sortable: false, groupable: false },
    { field: 'targetDate', label: 'Target date', kind: 'date', sortable: true, groupable: false },
    { field: 'startDate', label: 'Start date', kind: 'date', sortable: true, groupable: false },
    { field: 'name', label: 'Name', kind: 'text', sortable: true, groupable: false },
    { field: 'createdAt', label: 'Created', kind: 'date', sortable: true, groupable: false },
    { field: 'updatedAt', label: 'Updated', kind: 'date', sortable: true, groupable: false },
    ...DEMAND_FIELDS,
  ],
};

export function fieldDef(entity: ViewEntity, field: string): FieldDef | undefined {
  return FIELD_DEFS[entity].find((f) => f.field === field);
}

/** Project assigned directly to an issue. */
export function issueProjectIds(issue: Issue): string[] {
  return issue.projectId ? [issue.projectId] : [];
}

/**
 * All values of `field` on `item` as strings (empty array = no value). Multi-valued fields
 * return several. Unknown fields fall back to the raw property.
 */
export function fieldValues(entity: ViewEntity, item: Queryable, field: string, ctx: QueryContext = {}): string[] {
  const any = item as unknown as Record<string, unknown>;
  if ((entity === 'issue' || entity === 'project') && isDemandField(field)) {
    const demand = ctx.demand?.get((item as Issue | Project).id);
    if (field === 'customerId') return demand ? [...demand.customerIds] : [];
    if (field === 'customerTierId') return demand ? [...demand.tierIds] : [];
    // Numbers are 0 for work nobody asked for, so "at least 1" and sorting just work. No context, no value.
    return ctx.demand ? [String(demand?.[DEMAND_NUMBER[field]] ?? 0)] : [];
  }
  if (entity === 'issue' && field === 'projectId') return issueProjectIds(item as Issue);
  const raw = any[field];
  if (raw === undefined || raw === null || raw === '') return [];
  if (Array.isArray(raw)) return raw.map(String);
  return [String(raw)];
}
