// Series colours as design tokens (CSS variables), never raw hex. Status and priority keep the
// colour they have everywhere else in the app; plain comparisons use the --chart-* slots in order.
import type { CriterionState, IssueKind, IssueStatus, Priority, WorkstreamStatus } from '../../core';

export const WS_COLOR: Record<WorkstreamStatus, string> = {
  draft: 'var(--status-draft)',
  planned: 'var(--status-planned)',
  working: 'var(--status-working)',
  needs_input: 'var(--status-needs-input)',
  in_review: 'var(--status-in-review)',
  blocked: 'var(--status-blocked)',
  ready_to_land: 'var(--status-ready-to-land)',
  shipped: 'var(--status-shipped)',
  canceled: 'var(--status-canceled)',
};

export const ISSUE_COLOR: Record<IssueStatus, string> = {
  backlog: 'var(--status-draft)',
  todo: 'var(--status-planned)',
  in_progress: 'var(--status-working)',
  in_review: 'var(--status-in-review)',
  done: 'var(--status-shipped)',
  canceled: 'var(--status-canceled)',
};

export const PRIORITY_COLOR: Record<Priority, string> = {
  urgent: 'var(--status-blocked)',
  high: 'var(--status-needs-input)',
  medium: 'var(--status-working)',
  low: 'var(--status-planned)',
  none: 'var(--status-draft)',
};

export const CRITERION_COLOR: Record<CriterionState, string> = {
  pending: 'var(--status-draft)',
  in_progress: 'var(--status-working)',
  met: 'var(--status-shipped)',
};

export const ARTIFACT_COLOR: Record<string, string> = {
  draft: 'var(--status-draft)',
  open: 'var(--status-working)',
  merged: 'var(--status-shipped)',
  closed: 'var(--status-canceled)',
  pending: 'var(--status-planned)',
  running: 'var(--status-working)',
  succeeded: 'var(--status-shipped)',
  failed: 'var(--status-blocked)',
  healthy: 'var(--status-ready-to-land)',
  degraded: 'var(--status-needs-input)',
  published: 'var(--status-shipped)',
};

export const DECISION_COLOR = {
  proposed: 'var(--status-needs-input)',
  accepted: 'var(--status-shipped)',
  superseded: 'var(--status-draft)',
  rejected: 'var(--status-blocked)',
} as const;

export const KIND_FALLBACK: Record<IssueKind, string> = {
  incident: 'var(--status-blocked)',
  security: 'var(--status-needs-input)',
  bug: 'var(--status-in-review)',
  feature: 'var(--status-working)',
  tech_debt: 'var(--status-planned)',
  feedback: 'var(--status-ready-to-land)',
  idea: 'var(--status-draft)',
};
