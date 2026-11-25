// Field registry for saved views / list screens: which fields can be filtered, sorted and
// grouped per entity, and how to read their value(s) from an item.
import type { Issue, Project, ViewEntity } from '../contracts/domain';
import {
  ISSUE_KIND_META,
  ISSUE_STATUS_META,
  PRIORITY_META,
  PROJECT_STATUS_META,
} from '../meta';

export type EntityOf = {
  issue: Issue;
  project: Project;
};
export type Queryable = EntityOf[ViewEntity];

/** Extra data a field accessor or a filter may need beyond the item itself. */
export interface QueryContext {
  /** "Today" for date filters (tests pin it); defaults to the current time. */
  now?: Date;
  /** Ids of the tasks that have sub-tasks (the `subtasks` field). */
  subtaskParents?: ReadonlySet<string>;
}

export type FieldKind = 'enum' | 'id' | 'multi-id' | 'tags' | 'text' | 'date' | 'number';

export interface FieldDef {
  field: string;
  label: string;
  kind: FieldKind;
  /** Fixed value set for enums (in display order). */
  values?: readonly string[];
  /** For `id` / `multi-id` fields: the TramaStore collection the ids come from. */
  refersTo?: 'user' | 'project' | 'milestone' | 'issue' | 'actor';
  sortable: boolean;
  groupable: boolean;
  /** Only the task list offers it as a filter: saved views (evaluated on the server too) leave it out. */
  extended?: true;
}

const keysByOrder = (m: Record<string, { order: number }>) =>
  Object.keys(m).sort((a, b) => m[a].order - m[b].order);


export const FIELD_DEFS: Record<ViewEntity, readonly FieldDef[]> = {
  issue: [
    { field: 'kind', label: 'Type', kind: 'enum', values: keysByOrder(ISSUE_KIND_META), sortable: true, groupable: true },
    { field: 'status', label: 'Status', kind: 'enum', values: keysByOrder(ISSUE_STATUS_META), sortable: true, groupable: true },
    { field: 'assigneeId', label: 'Assignee', kind: 'id', refersTo: 'user', sortable: true, groupable: true },
    { field: 'priority', label: 'Priority', kind: 'enum', values: keysByOrder(PRIORITY_META), sortable: true, groupable: true },
    { field: 'source', label: 'Source', kind: 'enum', values: ['manual', 'github', 'gitlab', 'linear', 'email', 'api', 'agent'], sortable: false, groupable: true },
    { field: 'projectId', label: 'Project', kind: 'id', refersTo: 'project', sortable: false, groupable: true },
    { field: 'milestoneIds', label: 'Milestone', kind: 'multi-id', refersTo: 'milestone', sortable: false, groupable: false },
    { field: 'labels', label: 'Labels', kind: 'tags', sortable: false, groupable: false },
    { field: 'title', label: 'Title', kind: 'text', sortable: true, groupable: false },
    { field: 'createdAt', label: 'Created', kind: 'date', sortable: true, groupable: false },
    { field: 'updatedAt', label: 'Updated', kind: 'date', sortable: true, groupable: false },
    // Fields only the task list filters offer (`extended`): a saved view's public evaluator does not know them.
    { field: 'estimate', label: 'Estimate', kind: 'number', sortable: false, groupable: false, extended: true },
    { field: 'dueDate', label: 'Due date', kind: 'date', sortable: false, groupable: false, extended: true },
    { field: 'completedAt', label: 'Completed', kind: 'date', sortable: false, groupable: false, extended: true },
    { field: 'reporterId', label: 'Creator', kind: 'id', refersTo: 'user', sortable: false, groupable: false, extended: true },
    { field: 'thread', label: 'Thread', kind: 'enum', values: ['linked', 'none'], sortable: false, groupable: false, extended: true },
    { field: 'subtasks', label: 'Sub-tasks', kind: 'enum', values: ['yes', 'no'], sortable: false, groupable: false, extended: true },
  ],
  project: [
    { field: 'status', label: 'Status', kind: 'enum', values: keysByOrder(PROJECT_STATUS_META), sortable: true, groupable: true },
    { field: 'priority', label: 'Priority', kind: 'enum', values: keysByOrder(PRIORITY_META), sortable: true, groupable: true },
    { field: 'leadId', label: 'Lead', kind: 'id', refersTo: 'user', sortable: true, groupable: true },
    { field: 'repository', label: 'Repository', kind: 'text', sortable: true, groupable: false },
    { field: 'labels', label: 'Labels', kind: 'tags', sortable: false, groupable: false },
    { field: 'targetDate', label: 'Target date', kind: 'date', sortable: true, groupable: false },
    { field: 'startDate', label: 'Start date', kind: 'date', sortable: true, groupable: false },
    { field: 'name', label: 'Name', kind: 'text', sortable: true, groupable: false },
    { field: 'createdAt', label: 'Created', kind: 'date', sortable: true, groupable: false },
    { field: 'updatedAt', label: 'Updated', kind: 'date', sortable: true, groupable: false },
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
  if (entity === 'issue' && field === 'projectId') return issueProjectIds(item as Issue);
  if (entity === 'issue' && field === 'thread') return [(item as Issue).threadUrl ? 'linked' : 'none'];
  if (entity === 'issue' && field === 'subtasks') return [ctx.subtaskParents?.has((item as Issue).id) ? 'yes' : 'no'];
  const raw = any[field];
  if (raw === undefined || raw === null || raw === '') return [];
  if (Array.isArray(raw)) return raw.map(String);
  return [String(raw)];
}
