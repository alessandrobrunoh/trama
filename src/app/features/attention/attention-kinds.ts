import {
  LucideCircleX,
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
  review_requested: { icon: LucideGitPullRequest, color: 'text-status-in-review' },
  ci_failed: { icon: LucideCircleX, color: 'text-status-blocked' },
  conflict: { icon: LucideGitMerge, color: 'text-status-blocked' },
  triage: { icon: LucideInbox, color: 'text-status-working' },
};

/** One-sentence explanation of why an item of each kind is in My Attention (tooltips). */
export const ATTENTION_KIND_HELP: Record<AttentionKind, string> = {
  review_requested: 'A pull or merge request is waiting for your review.',
  ci_failed: 'Checks are failing on an open pull request you are involved in.',
  conflict: 'A pull request has merge conflicts that need resolving.',
  triage: 'A new task sits in the backlog and needs triage.',
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
    id: 'review',
    title: 'Review requested',
    hint: 'Pull requests waiting for your review',
    kinds: ['review_requested'],
    icon: LucideGitPullRequest,
  },
  {
    id: 'broken',
    title: 'Needs a fix',
    hint: 'Failing checks and merge conflicts on Task artifacts',
    kinds: ['ci_failed', 'conflict'],
    icon: LucideOctagonAlert,
  },
  {
    id: 'triage',
    title: 'Triage',
    hint: 'Backlog tasks that need triage',
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
