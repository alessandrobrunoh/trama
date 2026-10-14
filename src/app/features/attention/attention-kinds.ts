import {
  LucideCircleHelp,
  LucideCircleX,
  LucideGavel,
  LucideGitPullRequest,
  LucideInbox,
  LucideOctagonAlert,
  LucideGitMerge,
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
  conflict: { icon: LucideGitMerge, color: 'text-status-blocked' },
  triage: { icon: LucideInbox, color: 'text-status-working' },
};

/** One-sentence explanation of why an item of each kind is in My Attention (tooltips). */
export const ATTENTION_KIND_HELP: Record<AttentionKind, string> = {
  input_requested: 'Someone (often an agent) asked a question and is waiting for a human answer.',
  needs_decision: 'A decision was proposed and needs to be accepted or rejected.',
  review_requested: 'A pull or merge request is waiting for your review.',
  ci_failed: 'Checks are failing on an open pull request you are involved in.',
  conflict: 'A pull request has merge conflicts that need resolving.',
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
    title: 'Needs a fix',
    hint: 'Failing checks and merge conflicts on Issue artifacts',
    kinds: ['ci_failed', 'conflict'],
    icon: LucideOctagonAlert,
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
