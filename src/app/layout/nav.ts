import {
  LucideBellRing,
  LucideFolderGit2,
  LucideInbox,
  LucideLayoutDashboard,
  LucideNetwork,
  LucideScale,
  LucideWorkflow,
  type LucideIcon,
} from '@lucide/angular';

export interface NavItem {
  /** Path segment under /:workspaceSlug */
  segment: string;
  label: string;
  icon: LucideIcon;
  /** G-chord hint, e.g. "g o" */
  keys: string;
  badge?: 'attention' | 'issues';
}

export const MAIN_NAV: NavItem[] = [
  { segment: 'overview', label: 'Overview', icon: LucideLayoutDashboard, keys: 'g o' },
  { segment: 'attention', label: 'My Attention', icon: LucideBellRing, keys: 'g a', badge: 'attention' },
  { segment: 'issues', label: 'Issues', icon: LucideInbox, keys: 'g i', badge: 'issues' },
  { segment: 'workstreams', label: 'Workstreams', icon: LucideWorkflow, keys: 'g w' },
  { segment: 'graph', label: 'Graph', icon: LucideNetwork, keys: 'g x' },
  { segment: 'decisions', label: 'Decisions', icon: LucideScale, keys: 'g d' },
  { segment: 'projects', label: 'Projects', icon: LucideFolderGit2, keys: 'g p' },
];

/** Breadcrumb section labels for every first path segment. */
export const SECTION_LABELS: Record<string, string> = {
  overview: 'Overview',
  attention: 'My Attention',
  issues: 'Issues',
  workstreams: 'Workstreams',
  graph: 'Graph',
  decisions: 'Decisions',
  projects: 'Projects',
  repositories: 'Projects',
  teams: 'Teams',
  views: 'Views',
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

