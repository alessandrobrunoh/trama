// Display metadata for the Nabla domain enums: labels, ordering, semantic tone.
// `tone` is a semantic colour role the UI maps to its status tokens; `cssVar()` gives the
// conventional CSS custom property (`--status-needs-input`, ...). Verify names in src/styles.
import type {
  ArtifactKind,
  AttentionKind,
  AttentionSeverity,
  CriterionState,
  DecisionStatus,
  ExecutionProvider,
  IssueKind,
  IssueStatus,
  Priority,
  Role,
  WorkstreamStatus,
} from './contracts/domain';

export const APP_NAME = 'Trama';

export type Tone = 'neutral' | 'muted' | 'info' | 'accent' | 'success' | 'warning' | 'danger';

export interface Meta {
  label: string;
  tone: Tone;
  /** Lower sorts first. */
  order: number;
}

/** `var(--status-needs-input)` for a snake_case enum value. */
export function statusVar(value: string): string {
  return `var(--status-${value.replace(/_/g, '-')})`;
}

export const WORKSTREAM_STATUS_META: Record<WorkstreamStatus, Meta> = {
  blocked: { label: 'Blocked', tone: 'danger', order: 0 },
  needs_input: { label: 'Needs input', tone: 'warning', order: 1 },
  ready_to_land: { label: 'Ready to land', tone: 'success', order: 2 },
  in_review: { label: 'In review', tone: 'accent', order: 3 },
  working: { label: 'Working', tone: 'info', order: 4 },
  planned: { label: 'Planned', tone: 'neutral', order: 5 },
  draft: { label: 'Draft', tone: 'muted', order: 6 },
  shipped: { label: 'Shipped', tone: 'success', order: 7 },
  canceled: { label: 'Canceled', tone: 'muted', order: 8 },
};
export const WORKSTREAM_STATUSES = sortedKeys(WORKSTREAM_STATUS_META);
/** Board / overview column order (flow order rather than urgency order). */
export const WORKSTREAM_STATUS_FLOW: WorkstreamStatus[] = [
  'draft',
  'planned',
  'working',
  'needs_input',
  'in_review',
  'blocked',
  'ready_to_land',
  'shipped',
  'canceled',
];

export const PRIORITY_META: Record<Priority, Meta> = {
  urgent: { label: 'Urgent', tone: 'danger', order: 0 },
  high: { label: 'High', tone: 'warning', order: 1 },
  medium: { label: 'Medium', tone: 'info', order: 2 },
  low: { label: 'Low', tone: 'muted', order: 3 },
  none: { label: 'No priority', tone: 'muted', order: 4 },
};
export const PRIORITIES = sortedKeys(PRIORITY_META);

export const PROVIDER_META: Record<ExecutionProvider, { label: string; order: number }> = {
  human: { label: 'Human', order: 0 },
  delta: { label: 'Delta', order: 1 },
  claude_code: { label: 'Claude Code', order: 2 },
  codex: { label: 'Codex', order: 3 },
  cursor: { label: 'Cursor', order: 4 },
  other: { label: 'Other', order: 5 },
};
export const PROVIDERS = sortedKeys(PROVIDER_META);

export const ISSUE_KIND_META: Record<IssueKind, { label: string; prefix: string; order: number }> =
  {
    incident: { label: 'Incident', prefix: 'INC', order: 0 },
    security: { label: 'Security', prefix: 'SEC', order: 1 },
    bug: { label: 'Bug', prefix: 'BUG', order: 2 },
    feature: { label: 'Feature', prefix: 'FEAT', order: 3 },
    tech_debt: { label: 'Tech debt', prefix: 'DEBT', order: 4 },
    feedback: { label: 'Feedback', prefix: 'FB', order: 5 },
    idea: { label: 'Idea', prefix: 'IDEA', order: 6 },
  };
export const ISSUE_KINDS = sortedKeys(ISSUE_KIND_META);

export const ISSUE_STATUS_META: Record<IssueStatus, Meta> = {
  draft: { label: 'Draft', tone: 'muted', order: -1 },
  backlog: { label: 'Backlog', tone: 'muted', order: 0 },
  todo: { label: 'Todo', tone: 'accent', order: 1 },
  in_progress: { label: 'In Progress', tone: 'info', order: 2 },
  in_review: { label: 'In Review', tone: 'warning', order: 3 },
  done: { label: 'Done', tone: 'success', order: 4 },
  canceled: { label: 'Canceled', tone: 'muted', order: 5 },
};
export const ISSUE_STATUSES = sortedKeys(ISSUE_STATUS_META);

export const ARTIFACT_KIND_META: Record<ArtifactKind, { label: string; order: number }> = {
  pull_request: { label: 'Pull request', order: 0 },
  merge_request: { label: 'Merge request', order: 1 },
  build: { label: 'Build', order: 2 },
  test_report: { label: 'Test report', order: 3 },
  deployment: { label: 'Deployment', order: 4 },
  release: { label: 'Release', order: 5 },
  document: { label: 'Document', order: 6 },
  design: { label: 'Design', order: 7 },
  image: { label: 'Image', order: 8 },
  file: { label: 'File', order: 9 },
};
export const ARTIFACT_KINDS = sortedKeys(ARTIFACT_KIND_META);

export const DECISION_STATUS_META: Record<DecisionStatus, Meta> = {
  draft: { label: 'Draft', tone: 'muted', order: -1 },
  proposed: { label: 'Proposed', tone: 'warning', order: 0 },
  accepted: { label: 'Accepted', tone: 'success', order: 1 },
  superseded: { label: 'Superseded', tone: 'muted', order: 2 },
  rejected: { label: 'Rejected', tone: 'danger', order: 3 },
};
export const DECISION_STATUSES = sortedKeys(DECISION_STATUS_META);

export const CRITERION_STATE_META: Record<CriterionState, { label: string }> = {
  pending: { label: 'Pending' },
  in_progress: { label: 'In progress' },
  met: { label: 'Met' },
};

export const ATTENTION_KIND_META: Record<
  AttentionKind,
  { label: string; groupTitle: string; defaultSeverity: AttentionSeverity; order: number }
> = {
  input_requested: {
    label: 'Input requested',
    groupTitle: 'Needs your input',
    defaultSeverity: 'high',
    order: 0,
  },
  needs_decision: {
    label: 'Needs decision',
    groupTitle: 'Needs decision',
    defaultSeverity: 'high',
    order: 1,
  },
  ci_failed: { label: 'CI failed', groupTitle: 'CI failed', defaultSeverity: 'high', order: 2 },
  blocked: { label: 'Blocked', groupTitle: 'Blocked', defaultSeverity: 'high', order: 3 },
  review_requested: {
    label: 'Review requested',
    groupTitle: 'Review requested',
    defaultSeverity: 'medium',
    order: 4,
  },
  conflict: {
    label: 'Conflict',
    groupTitle: 'Merge conflicts',
    defaultSeverity: 'medium',
    order: 5,
  },
  ready_to_land: {
    label: 'Ready to land',
    groupTitle: 'Ready to land',
    defaultSeverity: 'medium',
    order: 6,
  },
  deadline: { label: 'Deadline', groupTitle: 'Deadlines', defaultSeverity: 'medium', order: 7 },
  dependency: {
    label: 'Waiting on dependency',
    groupTitle: 'Waiting on others',
    defaultSeverity: 'low',
    order: 8,
  },
  ready_to_ship: {
    label: 'Ready to ship',
    groupTitle: 'Ready to ship',
    defaultSeverity: 'low',
    order: 9,
  },
  triage: { label: 'Triage', groupTitle: 'Needs triage', defaultSeverity: 'low', order: 10 },
};
export const ATTENTION_KINDS = sortedKeys(ATTENTION_KIND_META);
export const SEVERITY_ORDER: Record<AttentionSeverity, number> = { high: 0, medium: 1, low: 2 };

export const ROLE_META: Record<Role, { label: string; rank: number; description: string }> = {
  viewer: { label: 'Viewer', rank: 0, description: 'Read only' },
  member: { label: 'Member', rank: 1, description: 'Create and update work' },
  admin: { label: 'Admin', rank: 2, description: 'Manage teams, repositories, agents and members' },
  owner: { label: 'Owner', rank: 3, description: 'Everything, including deleting the workspace' },
};
export const ROLES: Role[] = ['owner', 'admin', 'member', 'viewer'];

/** Longer role explanations for Settings → Members and Roles & permissions. */
export const ROLE_DETAILS: Record<Role, string> = {
  owner:
    'Full control. Sets the roles & permissions matrix, grants the owner role and can delete the workspace. A workspace always keeps at least one owner.',
  admin:
    'Manages people and structure: members, teams, repositories, agents, integrations. Can do everything a member can, whatever the permission matrix says about work.',
  member:
    'Does the everyday work: creates and edits workstreams, issues, decisions and comments. What else a member may do is set in Roles & permissions.',
  viewer: 'Read-only. Can browse everything in the workspace but cannot change anything.',
};

function sortedKeys<K extends string>(meta: Record<K, { order: number }>): K[] {
  return (Object.keys(meta) as K[]).sort((a, b) => meta[a].order - meta[b].order);
}
