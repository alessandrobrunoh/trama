import {
  LucideCalendarClock,
  LucideCircleArrowUp,
  LucideCircleHelp,
  LucideCircleX,
  LucideFileSearch,
  LucideGavel,
  LucideGitMerge,
  LucideGitPullRequest,
  LucideHourglass,
  LucideInbox,
  LucideOctagonAlert,
  LucideRocket,
  type LucideIcon,
} from '@lucide/angular';
import type { AttentionKind, AttentionSeverity } from '../../core';

export interface KindView {
  icon: LucideIcon;
  /** Tailwind text colour class (status token). */
  color: string;
}

/** Icon + tint per attention kind (tokens only, dark-mode safe). */
export const ATTENTION_KIND_VIEW: Record<AttentionKind, KindView> = {
  input_requested: { icon: LucideCircleHelp, color: 'text-status-needs-input' },
  needs_decision: { icon: LucideGavel, color: 'text-status-needs-input' },
  review_requested: { icon: LucideGitPullRequest, color: 'text-status-in-review' },
  ci_failed: { icon: LucideCircleX, color: 'text-status-blocked' },
  blocked: { icon: LucideOctagonAlert, color: 'text-status-blocked' },
  conflict: { icon: LucideGitMerge, color: 'text-status-blocked' },
  ready_to_land: { icon: LucideCircleArrowUp, color: 'text-status-ready-to-land' },
  ready_to_ship: { icon: LucideRocket, color: 'text-status-ready-to-land' },
  proof_missing: { icon: LucideFileSearch, color: 'text-muted-foreground' },
  deadline: { icon: LucideCalendarClock, color: 'text-status-needs-input' },
  dependency: { icon: LucideHourglass, color: 'text-muted-foreground' },
  triage: { icon: LucideInbox, color: 'text-status-working' },
};

/** One-sentence explanation of why an item of each kind is in My Attention (tooltips). */
export const ATTENTION_KIND_HELP: Record<AttentionKind, string> = {
  input_requested: 'Someone (often an agent) asked a question on a workstream and is waiting for a human answer.',
  needs_decision: 'A decision was proposed and needs to be accepted or rejected.',
  review_requested: 'A pull or merge request is waiting for your review.',
  ci_failed: 'Checks are failing on an open pull request of a workstream you are involved in.',
  blocked: 'A workstream you are accountable for is blocked and cannot move on its own.',
  conflict: 'A pull request has merge conflicts that need resolving.',
  ready_to_land: 'Approved and green: a pull request can be merged.',
  ready_to_ship: 'Every acceptance criterion is met; the workstream can be marked shipped.',
  proof_missing: 'The code is delivered, but criteria marked met have no evidence. Link a PR, a build or a note that shows what was verified.',
  deadline: 'A target date is close or has passed.',
  dependency: 'Your workstream waits on another workstream that has not shipped yet.',
  triage: 'A new issue for one of your teams sits in the backlog and needs triage.',
};

export interface AttentionSection {
  id: string;
  title: string;
  hint: string;
  kinds: readonly AttentionKind[];
  icon: LucideIcon;
}

/** The order in which My Attention groups its items. */
export const ATTENTION_SECTIONS: readonly AttentionSection[] = [
  {
    id: 'input',
    title: 'Needs your input',
    hint: 'Agents and teammates are waiting on an answer or a decision',
    kinds: ['input_requested', 'needs_decision'],
    icon: LucideCircleHelp,
  },
  {
    id: 'review',
    title: 'Review requested',
    hint: 'Pull requests waiting for your review',
    kinds: ['review_requested'],
    icon: LucideGitPullRequest,
  },
  {
    id: 'broken',
    title: 'Blocked',
    hint: 'CI failures, merge conflicts and blocked work',
    kinds: ['ci_failed', 'blocked', 'conflict'],
    icon: LucideOctagonAlert,
  },
  {
    id: 'ready',
    title: 'Ready to land or ship',
    hint: 'Approved and green, or everything done',
    kinds: ['ready_to_land', 'ready_to_ship'],
    icon: LucideCircleArrowUp,
  },
  {
    id: 'proof',
    title: 'Proof missing',
    hint: 'Delivered work whose met criteria have no evidence',
    kinds: ['proof_missing'],
    icon: LucideFileSearch,
  },
  {
    id: 'deadline',
    title: 'Deadlines',
    hint: 'Due soon or overdue',
    kinds: ['deadline'],
    icon: LucideCalendarClock,
  },
  {
    id: 'dependency',
    title: 'Waiting on others',
    hint: 'Your work depends on workstreams that have not shipped',
    kinds: ['dependency'],
    icon: LucideHourglass,
  },
  {
    id: 'triage',
    title: 'Triage',
    hint: 'Backlog issues for your teams',
    kinds: ['triage'],
    icon: LucideInbox,
  },
];

/** Left accent + dot colour for a severity (tokens). */
export const SEVERITY_VIEW: Record<AttentionSeverity, { bar: string; label: string }> = {
  high: { bar: 'bg-status-blocked', label: 'High' },
  medium: { bar: 'bg-status-needs-input', label: 'Medium' },
  low: { bar: 'bg-transparent', label: 'Low' },
};
