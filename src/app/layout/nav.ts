import {
  LucideActivity,
  LucideBellRing,
  LucideChartColumn,
  LucideChartGantt,
  LucideCircleDot,
  LucideFolderGit2,
  LucideHexagon,
  LucideLayoutDashboard,
  LucideNetwork,
  LucideScale,
  LucideUserRoundCheck,
  type LucideIcon,
} from '@lucide/angular';

export interface NavItem {
  /** Path segment under /:workspaceSlug */
  segment: string;
  label: string;
  icon: LucideIcon;
  /** G-chord hint, e.g. "g o" */
  keys: string;
  badge?: 'attention' | 'issues' | 'my-work';
  /** One-line explanation, shown as the item tooltip and on the page header. */
  hint?: string;
}

/** Personal entry points, above the workspace sections. */
export const PERSONAL_NAV: NavItem[] = [
  {
    segment: 'attention',
    label: 'My Attention',
    icon: LucideBellRing,
    keys: 'g a',
    badge: 'attention',
    hint: 'Reviews, questions and blockers waiting on you',
  },
  {
    segment: 'my-work',
    label: 'My Work',
    icon: LucideUserRoundCheck,
    keys: 'g m',
    hint: 'Issues assigned to you and workstreams you are accountable for',
  },
];

/**
 * Workspace sections. Issues and Workstreams are deliberately adjacent but distinct:
 * issues are demand (what problems exist), workstreams are outcomes (what we are trying to achieve).
 */
export const MAIN_NAV: NavItem[] = [
  { segment: 'overview', label: 'Overview', icon: LucideLayoutDashboard, keys: 'g o', hint: 'What is in flight across the workspace' },
  {
    segment: 'issues',
    label: 'Issues',
    icon: LucideCircleDot,
    keys: 'g i',
    badge: 'issues',
    hint: 'Demand — bugs, requests, incidents: what problems exist',
  },
  {
    segment: 'workstreams',
    label: 'Workstreams',
    icon: LucideHexagon,
    keys: 'g w',
    hint: 'Outcomes — coordinated work that resolves one or more issues',
  },
  { segment: 'timeline', label: 'Timeline', icon: LucideChartGantt, keys: 'g l', hint: 'Workstreams and milestones on a calendar' },
  { segment: 'decisions', label: 'Decisions', icon: LucideScale, keys: 'g d', hint: 'What was decided and why' },
  { segment: 'projects', label: 'Projects', icon: LucideFolderGit2, keys: 'g p', hint: 'Repositories and the work touching them' },
  { segment: 'activity', label: 'Activity', icon: LucideActivity, keys: 'g e', hint: 'Everything that happened, newest first' },
  { segment: 'graph', label: 'Graph', icon: LucideNetwork, keys: 'g x', hint: 'Dependencies between workstreams' },
  { segment: 'stats', label: 'Statistics', icon: LucideChartColumn, keys: 'g y', hint: 'Throughput, health and trends' },
];

/** Breadcrumb section labels for every first path segment. */
export const SECTION_LABELS: Record<string, string> = {
  overview: 'Overview',
  stats: 'Statistics',
  attention: 'My Attention',
  'my-work': 'My Work',
  issues: 'Issues',
  workstreams: 'Workstreams',
  timeline: 'Timeline',
  graph: 'Graph',
  decisions: 'Decisions',
  projects: 'Projects',
  repositories: 'Projects',
  teams: 'Teams',
  views: 'Views',
  activity: 'Activity',
  settings: 'Settings',
};

/** Sections that have a list page to link back to. */
export const SECTIONS_WITH_LIST = new Set([
  'workstreams',
  'issues',
  'decisions',
  'projects',
  'repositories',
  'teams',
  'views',
  'settings',
]);
