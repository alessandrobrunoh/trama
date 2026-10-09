// Pure helpers for the issue screens: picker options, view tabs, display options (persisted).
import {
  DEFAULT_ESTIMATE_SCALE,
  ISSUE_KIND_META,
  ISSUE_KINDS,
  ISSUE_STATUSES,
  ISSUE_STATUS_META,
  PRIORITIES,
  PRIORITY_META,
  estimateFraction,
  estimateOptions,
  formatEstimateLong,
  type EstimateScale,
  type Issue,
  type IssueStatus,
  type NablaStore,
  type Workstream,
} from '../../core';
import { oneOf, readJson, writeJson } from '../../core/stores/storage';
import type { PickOption } from '../workstreams/picker';

export const SOURCE_LABEL: Record<string, string> = {
  manual: 'Manual',
  github: 'GitHub',
  gitlab: 'GitLab',
  linear: 'Linear',
  email: 'Email',
  api: 'API',
  agent: 'Agent',
};

export const isClosedIssue = (i: Pick<Issue, 'status'>): boolean =>
  i.status === 'done' || i.status === 'canceled';
const CLOSED_WS = new Set(['shipped', 'canceled']);
export const isOpenWorkstream = (w: Workstream): boolean => !CLOSED_WS.has(w.status);

// ───────────────────────── picker options ─────────────────────────

export const issueStatusOptions = (): PickOption[] =>
  ISSUE_STATUSES.map((s) => ({
    value: s,
    label: ISSUE_STATUS_META[s].label,
    kind: 'status',
    statusEntity: 'issue',
  }));

/**
 * Estimate picker options on a scale (`value` = points as a string): glyph + "3 points" ("M · 3 points" on the
 * t-shirt scale). A stored value that is not on the scale stays selectable. "No estimate" is the picker's clear row.
 */
export function issueEstimateOptions(
  current?: number,
  scale: EstimateScale = DEFAULT_ESTIMATE_SCALE,
): PickOption[] {
  const opts: PickOption[] = estimateOptions(scale).map((o) => ({
    value: String(o.value),
    label: formatEstimateLong(o.value, scale),
    kind: 'estimate',
    fraction: estimateFraction(o.value, scale),
    search: `${o.label} ${o.value}`,
    quickKey: /^\d+$/.test(o.label)
      ? o.value < 10
        ? String(o.value)
        : undefined
      : o.label.length === 1
        ? o.label.toLowerCase()
        : undefined,
  }));
  if (current !== undefined && !opts.some((o) => o.value === String(current))) {
    opts.push({
      value: String(current),
      label: formatEstimateLong(current, scale),
      kind: 'estimate',
      fraction: estimateFraction(current, scale),
    });
  }
  return opts;
}

export const issueKindOptions = (): PickOption[] =>
  ISSUE_KINDS.map((k) => ({
    value: k,
    label: ISSUE_KIND_META[k].label,
    hint: ISSUE_KIND_META[k].prefix,
  }));

/** Workstreams as picker options (hexagon glyph + key hint), open ones first. */
export function workstreamPickOptions(
  store: NablaStore,
  exclude: readonly string[] = [],
): PickOption[] {
  const skip = new Set(exclude);
  return store
    .workstreams()
    .filter((w) => !skip.has(w.id))
    .slice()
    .sort(
      (a, b) =>
        Number(isOpenWorkstream(b)) - Number(isOpenWorkstream(a)) ||
        (a.updatedAt < b.updatedAt ? 1 : -1),
    )
    .map((w) => ({
      value: w.id,
      label: w.title,
      hint: w.key,
      kind: 'status',
      status: w.status,
      statusEntity: 'workstream',
      search: `${w.key} ${w.title}`,
    }));
}

// ───────────────────────── view tabs ─────────────────────────

export type IssueViewTab = 'all' | 'active' | 'backlog' | 'done' | 'draft';

export const ISSUE_TABS: {
  id: IssueViewTab;
  label: string;
  statuses: readonly IssueStatus[] | null;
  hint: string;
}[] = [
  { id: 'all', label: 'All issues', statuses: null, hint: 'Every issue' },
  {
    id: 'active',
    label: 'Active',
    statuses: ['todo', 'in_progress', 'in_review'],
    hint: 'Todo, in progress and in review',
  },
  { id: 'backlog', label: 'Backlog', statuses: ['backlog'], hint: 'Unscheduled demand' },
  { id: 'done', label: 'Done', statuses: ['done', 'canceled'], hint: 'Done and canceled' },
  { id: 'draft', label: 'Drafts', statuses: ['draft'], hint: 'Saved for later' },
];

export const asViewTab = (v: string | null | undefined): IssueViewTab =>
  oneOf(
    v,
    ISSUE_TABS.map((t) => t.id),
    'all',
  );

export function tabStatuses(tab: IssueViewTab): readonly IssueStatus[] | null {
  return ISSUE_TABS.find((t) => t.id === tab)?.statuses ?? null;
}

// ───────────────────────── display options ─────────────────────────

export type IssueLayout = 'list' | 'board';
export type IssueGroup =
  | 'status'
  | 'kind'
  | 'priority'
  | 'teamId'
  | 'assigneeId'
  | 'workstreamIds'
  | 'projectId'
  | 'customerId'
  | 'customerTierId'
  | 'none';
export type IssueSort =
  | 'updatedAt'
  | 'createdAt'
  | 'priority'
  | 'status'
  | 'key'
  | 'title'
  | 'customerCount'
  | 'requestCount'
  | 'customerRevenue';
export type IssueDensity = 'comfortable' | 'compact';
export type IssueProp = 'kind' | 'workstreams' | 'project' | 'labels' | 'team' | 'assignee' | 'date';

export interface IssueDisplay {
  layout: IssueLayout;
  groupBy: IssueGroup;
  sortField: IssueSort;
  sortDir: 'asc' | 'desc';
  showEmptyGroups: boolean;
  density: IssueDensity;
  hidden: IssueProp[];
}

export const GROUPS: readonly IssueGroup[] = [
  'status',
  'kind',
  'priority',
  'teamId',
  'assigneeId',
  'workstreamIds',
  'projectId',
  'customerId',
  'customerTierId',
  'none',
];
export const SORTS: readonly IssueSort[] = [
  'updatedAt',
  'createdAt',
  'priority',
  'status',
  'key',
  'title',
  'customerCount',
  'requestCount',
  'customerRevenue',
];
export const PROPS: readonly IssueProp[] = ['kind', 'workstreams', 'project', 'labels', 'team', 'assignee', 'date'];

export const GROUP_LABEL: Record<IssueGroup, string> = {
  status: 'Status',
  kind: 'Type',
  priority: 'Priority',
  teamId: 'Team',
  assigneeId: 'Assignee',
  workstreamIds: 'Workstream',
  projectId: 'Project',
  customerId: 'Customer',
  customerTierId: 'Customer tier',
  none: 'No grouping',
};
export const SORT_LABEL: Record<IssueSort, string> = {
  updatedAt: 'Last updated',
  createdAt: 'Created',
  priority: 'Priority',
  status: 'Status',
  key: 'Key',
  title: 'Title',
  customerCount: 'Customers',
  requestCount: 'Requests',
  customerRevenue: 'Customer revenue',
};
export const PROP_LABEL: Record<IssueProp, string> = {
  kind: 'Type',
  workstreams: 'Workstreams',
  project: 'Project',
  labels: 'Labels',
  team: 'Team',
  assignee: 'Assignee',
  date: 'Date',
};

export const DEFAULT_DISPLAY: IssueDisplay = {
  layout: 'list',
  groupBy: 'status',
  sortField: 'priority',
  sortDir: 'asc',
  showEmptyGroups: false,
  density: 'comfortable',
  hidden: [],
};

export function readDisplay(key: string): IssueDisplay {
  const raw = readJson<IssueDisplay>(key) ?? {};
  return {
    layout: oneOf(raw.layout, ['list', 'board'], DEFAULT_DISPLAY.layout),
    groupBy: oneOf(raw.groupBy, GROUPS, DEFAULT_DISPLAY.groupBy),
    sortField: oneOf(raw.sortField, SORTS, DEFAULT_DISPLAY.sortField),
    sortDir: oneOf(raw.sortDir, ['asc', 'desc'], DEFAULT_DISPLAY.sortDir),
    showEmptyGroups:
      typeof raw.showEmptyGroups === 'boolean'
        ? raw.showEmptyGroups
        : DEFAULT_DISPLAY.showEmptyGroups,
    density: oneOf(raw.density, ['comfortable', 'compact'], DEFAULT_DISPLAY.density),
    hidden: Array.isArray(raw.hidden)
      ? raw.hidden.filter((p): p is IssueProp => (PROPS as readonly string[]).includes(p))
      : [],
  };
}

export function writeDisplay(key: string, value: IssueDisplay): void {
  writeJson(key, value);
}

/** Group keys forced to exist (empty columns / sections) for a grouping. */
export function groupUniverse(store: NablaStore, group: IssueGroup): string[] | undefined {
  switch (group) {
    case 'status':
      return [...ISSUE_STATUSES];
    case 'priority':
      return [...PRIORITIES];
    case 'kind':
      return [...ISSUE_KINDS];
    case 'teamId':
      return store.teams().map((t) => t.id);
    case 'assigneeId':
      return store.users().map((u) => u.id);
    case 'workstreamIds':
      return store
        .workstreams()
        .filter(isOpenWorkstream)
        .map((w) => w.id);
    case 'projectId':
      return store
        .projects()
        .filter((p) => p.status !== 'completed' && p.status !== 'canceled')
        .map((p) => p.id);
    default:
      return undefined;
  }
}

export function groupLabel(store: NablaStore, group: IssueGroup, key: string): string {
  switch (group) {
    case 'status':
      return ISSUE_STATUS_META[key as IssueStatus]?.label ?? key;
    case 'priority':
      return PRIORITY_META[key as keyof typeof PRIORITY_META]?.label ?? key;
    case 'kind':
      return ISSUE_KIND_META[key as keyof typeof ISSUE_KIND_META]?.label ?? key;
    case 'teamId':
      return key ? (store.getTeam(key)?.name ?? 'Unknown team') : 'No team';
    case 'assigneeId':
      return key ? (store.getUser(key)?.name ?? 'Unknown') : 'Unassigned';
    case 'workstreamIds':
      return key ? (store.getWorkstream(key)?.title ?? 'Unknown workstream') : 'No workstream';
    case 'projectId':
      return key ? (store.getProject(key)?.name ?? 'Unknown project') : 'No project';
    case 'customerId':
      return key ? (store.getCustomer(key)?.name ?? 'Unknown customer') : 'No customer';
    case 'customerTierId':
      return key ? (store.settings().customerTiers.find((t) => t.id === key)?.name ?? 'Unknown tier') : 'No tier';
    default:
      return 'Issues';
  }
}

/** Milestones as filter options; the hint is the project they belong to. */
export function milestoneFilterOptions(store: NablaStore): PickOption[] {
  return store
    .milestones()
    .map((m) => {
      const hint = store.getProject(m.projectId)?.name ?? '';
      return { value: m.id, label: m.name, hint, search: `${hint} ${m.name}` };
    })
    .sort((a, b) => a.hint.localeCompare(b.hint) || a.label.localeCompare(b.label));
}
