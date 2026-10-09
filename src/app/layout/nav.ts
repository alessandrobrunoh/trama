import {
  LucideActivity,
  LucideBell,
  LucideBellRing,
  LucideBox,
  LucideBuilding2,
  LucideChartColumn,
  LucideCircleDot,
  LucideFileText,
  LucideFolderGit2,
  LucideHexagon,
  LucideLayers,
  LucideLayoutDashboard,
  LucideMessageSquare,
  LucideNetwork,
  LucideScale,
  LucideUserRoundCheck,
  LucideUsers,
  type LucideIcon,
} from '@lucide/angular';

export interface NavItem {
  /** Path segment under /:workspaceSlug */
  segment: string;
  label: string;
  icon: LucideIcon;
  /** G-chord hint, e.g. "g o" */
  keys: string;
  badge?: 'attention' | 'issues' | 'my-work' | 'notifications';
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
  {
    segment: 'assistant',
    label: 'Assistant',
    icon: LucideMessageSquare,
    keys: '',
    hint: 'Chat with Trama about your work',
  },
  {
    segment: 'notifications',
    label: 'Notifications',
    icon: LucideBell,
    keys: 'g n',
    badge: 'notifications',
    hint: 'Assignments, questions, reviews and comments that concern you',
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
    segment: 'customers',
    label: 'Customers',
    icon: LucideBuilding2,
    keys: 'g c',
    hint: 'Companies whose feedback is linked to issues',
  },
  {
    segment: 'workstreams',
    label: 'Workstreams',
    icon: LucideHexagon,
    keys: 'g w',
    hint: 'Outcomes — coordinated work that resolves one or more issues',
  },
  { segment: 'decisions', label: 'Decisions', icon: LucideScale, keys: 'g d', hint: 'What was decided and why' },
  { segment: 'projects', label: 'Projects', icon: LucideBox, keys: 'g p', hint: 'Planned outcomes — what we want to achieve, by when, and where' },
  { segment: 'documents', label: 'Documents', icon: LucideFileText, keys: 'g u', hint: 'Specs, plans and notes that do not live in a repository' },
  { segment: 'repositories', label: 'Repositories', icon: LucideFolderGit2, keys: 'g r', hint: 'Repositories and the work touching them' },
  { segment: 'teams', label: 'Teams', icon: LucideUsers, keys: 'g t', hint: 'Who works on what, team by team' },
  { segment: 'views', label: 'Views', icon: LucideLayers, keys: 'g v', hint: 'Saved filters for issues, workstreams, projects and decisions, as lists, boards or timelines' },
  { segment: 'activity', label: 'Activity', icon: LucideActivity, keys: 'g e', hint: 'Everything that happened, newest first' },
  { segment: 'graph', label: 'Graph', icon: LucideNetwork, keys: 'g x', hint: 'Dependencies between workstreams' },
  { segment: 'stats', label: 'Statistics', icon: LucideChartColumn, keys: 'g y', hint: 'Throughput, health and trends' },
];

/** `items` in the user's custom `order` (segments); entries missing from it keep their default order after the listed ones. */
export function orderNav(items: readonly NavItem[], order: readonly string[]): NavItem[] {
  const rank = (n: NavItem): number => {
    const i = order.indexOf(n.segment);
    return i < 0 ? order.length : i;
  };
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => rank(a.item) - rank(b.item) || a.index - b.index)
    .map((x) => x.item);
}

/** Breadcrumb section labels for every first path segment. */
export const SECTION_LABELS: Record<string, string> = {
  overview: 'Overview',
  stats: 'Statistics',
  attention: 'My Attention',
  'my-work': 'My Work',
  assistant: 'Assistant',
  notifications: 'Notifications',
  issues: 'Issues',
  customers: 'Customers',
  workstreams: 'Workstreams',
  graph: 'Graph',
  decisions: 'Decisions',
  projects: 'Projects',
  documents: 'Documents',
  repositories: 'Repositories',
  teams: 'Teams',
  views: 'Views',
  activity: 'Activity',
  settings: 'Settings',
};

/** Sections that have a list page to link back to. */
export const SECTIONS_WITH_LIST = new Set([
  'workstreams',
  'issues',
  'customers',
  'decisions',
  'projects',
  'documents',
  'repositories',
  'teams',
  'views',
  'settings',
]);
