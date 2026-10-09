// Helpers shared by the health, flow and contributors views: how a severity looks, where an item links to.
import {
  LucideCircleCheck,
  LucideInfo,
  LucideOctagonAlert,
  LucideTriangleAlert,
  type LucideIcon,
} from '@lucide/angular';
import type { ActorRef, InsightActor, InsightItem, InsightSeverity } from '../../core';

export interface SeverityView {
  label: string;
  /** Text colour for the icon and label (never the only carrier of the meaning: the label stays). */
  text: string;
  /** Left stripe on a tile. */
  stripe: string;
  icon: LucideIcon;
}

export const SEVERITY_VIEW: Record<InsightSeverity, SeverityView> = {
  ok: { label: 'Clear', text: 'text-muted-foreground', stripe: 'var(--border-strong)', icon: LucideCircleCheck },
  info: { label: 'Watch', text: 'text-tone-blue', stripe: 'var(--tone-blue)', icon: LucideInfo },
  warning: { label: 'Needs action', text: 'text-tone-amber', stripe: 'var(--tone-amber)', icon: LucideTriangleAlert },
  critical: { label: 'Critical', text: 'text-tone-red', stripe: 'var(--tone-red)', icon: LucideOctagonAlert },
};

export const SEVERITY_RANK: Record<InsightSeverity, number> = { critical: 0, warning: 1, info: 2, ok: 3 };

/** Router link of an item, relative to the app root; `null` when it has no page. */
export function itemLink(slug: string, item: InsightItem): string[] | null {
  switch (item.type) {
    case 'workstream':
      return item.key ? ['/', slug, 'workstreams', item.key] : null;
    case 'issue':
      return item.key ? ['/', slug, 'issues', item.key] : null;
    case 'decision':
      return item.key ? ['/', slug, 'decisions', item.key] : null;
    case 'milestone':
    case 'project':
      return item.projectId ? ['/', slug, 'projects', item.projectId] : null;
    case 'artifact':
      return item.workstreamKey ? ['/', slug, 'workstreams', item.workstreamKey] : null;
  }
}

/** The actor as a ref the avatar can resolve; `null` for "nobody". */
export function actorRef(a: InsightActor | undefined): ActorRef | null {
  return a && a.id && a.type !== 'unassigned' ? { type: a.type, id: a.id } : null;
}

const TYPE_LABEL: Record<InsightItem['type'], string> = {
  workstream: 'Workstream',
  issue: 'Issue',
  decision: 'Decision',
  milestone: 'Milestone',
  artifact: 'Pull request',
  project: 'Project',
};
export const itemTypeLabel = (t: InsightItem['type']): string => TYPE_LABEL[t];

/** 0.4 -> "10h", 3 -> "3d", 34.2 -> "34d" */
export function formatAge(days: number | undefined): string {
  if (days === undefined) return '';
  if (days < 1 / 24) return '<1h';
  if (days < 1) return `${Math.round(days * 24)}h`;
  if (days < 10) return `${+days.toFixed(1)}d`;
  return `${Math.round(days)}d`;
}
