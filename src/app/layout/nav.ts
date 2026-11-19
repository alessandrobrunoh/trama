import {
  LucideActivity,
  LucideInbox,
  LucideBox,
  LucideChartColumn,
  LucideCircleDot,
  LucideFileText,
  LucideLayers,
  LucideLayoutDashboard,
  LucideMessageSquare,
  LucidePlug,
  LucideTimer,
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
  badge?: 'inbox' | 'issues';
  /** One-line explanation, shown as the item tooltip and on the page header. */
  hint?: string;
  /** Extra words the command palette matches ("go to inbox" also finds "attention"). */
  keywords?: string;
}

/**
 * The five places people live in, always visible at the top of the sidebar.
 * Inbox merges what used to be My Attention and Notifications.
 */
export const PRIMARY_NAV: NavItem[] = [
  {
    segment: 'inbox',
    label: 'Inbox',
    icon: LucideInbox,
    keys: 'g a',
    badge: 'inbox',
    hint: 'Everything waiting on you: questions, reviews, blockers, mentions and updates',
    keywords: 'attention notifications needs you updates unread',
  },
  {
    segment: 'my-work',
    label: 'My work',
    icon: LucideUserRoundCheck,
    keys: 'g m',
    hint: 'Tasks assigned to you or reported by you',
    keywords: 'issues',
  },
  {
    segment: 'tasks',
    label: 'Tasks',
    icon: LucideCircleDot,
    keys: 'g i',
    badge: 'issues',
    hint: 'Bugs, requests, and incidents',
    keywords: 'issues',
  },
  {
    segment: 'projects',
    label: 'Projects',
    icon: LucideBox,
    keys: 'g p',
    hint: 'Planned outcomes: what we want to achieve, by when, and where',
  },
];

/** Everything else, tucked under "More" in the sidebar. All of it stays one keystroke away (G chords, ⌘K). */
export const MORE_NAV: NavItem[] = [
  {
    segment: 'timer',
    label: 'Timer',
    icon: LucideTimer,
    keys: 'g h',
    hint: 'Start, stop, or add your own time. It stays in Trama.',
  },
  {
    segment: 'overview',
    label: 'Overview',
    icon: LucideLayoutDashboard,
    keys: 'g o',
    hint: 'What is in flight across the workspace',
  },
  {
    segment: 'documents',
    label: 'Documents',
    icon: LucideFileText,
    keys: 'g u',
    hint: 'Specs, plans and notes',
  },
  {
    segment: 'views',
    label: 'Views',
    icon: LucideLayers,
    keys: 'g v',
    hint: 'Saved filters for tasks and projects, as lists, boards or timelines',
    keywords: 'issues',
  },
  {
    segment: 'activity',
    label: 'Activity',
    icon: LucideActivity,
    keys: 'g e',
    hint: 'Everything that happened, newest first',
  },
  {
    segment: 'stats',
    label: 'Statistics',
    icon: LucideChartColumn,
    keys: 'g y',
    hint: 'Throughput, health and trends',
  },
  {
    segment: 'assistant',
    label: 'Assistant',
    icon: LucideMessageSquare,
    keys: '',
    hint: 'Chat with Trama about your work',
  },
  {
    segment: 'connect',
    label: 'Connect your agent',
    icon: LucidePlug,
    keys: 'g k',
    hint: 'Connect Claude Code, Cursor or the CLI to this workspace',
    keywords: 'mcp token cli install onboarding',
  },
];

/** Every destination reachable from the sidebar, for the command bar and the mobile menu. */
export const ALL_NAV: NavItem[] = [...PRIMARY_NAV, ...MORE_NAV];

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
  timer: 'Timer',
  stats: 'Statistics',
  inbox: 'Inbox',
  'my-work': 'My work',
  assistant: 'Assistant',
  connect: 'Connect your agent',
  tasks: 'Tasks',
  issues: 'Tasks',
  projects: 'Projects',
  documents: 'Documents',
  views: 'Views',
  activity: 'Activity',
  settings: 'Settings',
};

/** Sections that have a list page to link back to. */
export const SECTIONS_WITH_LIST = new Set([
  'tasks',
  'issues',
  'projects',
  'documents',
  'views',
  'settings',
]);
