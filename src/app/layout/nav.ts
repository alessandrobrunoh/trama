import {
  LucideActivity,
  LucideInbox,
  LucideBox,
  LucideCalendar,
  LucideChartColumn,
  LucideCircleUserRound,
  LucideHouse,
  LucideLayers,
  LucideListTodo,
  LucidePlug,
  LucideSparkles,
  LucideSquareKanban,
  LucideTimer,
  type LucideIcon,
} from '@lucide/angular';

export interface NavItem {
  /** Path segment under /:workspaceSlug */
  segment: string;
  label: string;
  icon: LucideIcon;
  /** G-chord hint, e.g. "g o" */
  keys: string;
  /** inbox: needs you + unread · issues: all tasks · mine: my open tasks · time: my time this week */
  badge?: 'inbox' | 'issues' | 'mine' | 'time';
  /** One-line explanation, shown as the item tooltip and on the page header. */
  hint?: string;
  /** Extra words the command palette matches ("go to inbox" also finds "attention"). */
  keywords?: string;
}

/**
 * The v3 sidebar ("v3 · 01 UI Kit" → Sidebar): Home, Inbox, My tasks, Tasks, Board, Timeline, Time, Ask.
 * Projects follow as their own list; Settings sits under "Workspace".
 */
export const PRIMARY_NAV: NavItem[] = [
  {
    segment: 'overview',
    label: 'Home',
    icon: LucideHouse,
    keys: 'g o',
    hint: 'What you are working on, what is next and what needs you',
    keywords: 'home overview dashboard pulse briefing summary status week',
  },
  {
    segment: 'inbox',
    label: 'Inbox',
    icon: LucideInbox,
    keys: 'g a',
    badge: 'inbox',
    hint: 'What needs you and what changed: reviews, blockers, mentions and updates',
    keywords: 'attention notifications needs you updates unread',
  },
  {
    segment: 'my-tasks',
    label: 'My tasks',
    icon: LucideCircleUserRound,
    keys: 'g m',
    badge: 'mine',
    hint: 'Tasks assigned to you, as a list or a board',
    keywords: 'my work assigned mine',
  },
  {
    segment: 'tasks',
    label: 'Tasks',
    icon: LucideListTodo,
    keys: 'g i',
    badge: 'issues',
    hint: 'Every task and subtask, from GitHub, GitLab, Jira or created here',
    keywords: 'issues list',
  },
  {
    segment: 'board',
    label: 'Board',
    icon: LucideSquareKanban,
    keys: 'g b',
    hint: 'Tasks as columns by status',
    keywords: 'kanban columns',
  },
  {
    segment: 'timeline',
    label: 'Timeline',
    icon: LucideCalendar,
    keys: 'g t',
    hint: 'Projects and due dates on one time axis',
    keywords: 'roadmap gantt schedule milestones forecast calendar dates',
  },
  {
    segment: 'timer',
    label: 'Time',
    icon: LucideTimer,
    keys: 'g h',
    badge: 'time',
    hint: 'Timer, timesheet and time logged per task',
    keywords: 'timer timesheet hours log',
  },
  {
    segment: 'assistant',
    label: 'Ask',
    icon: LucideSparkles,
    keys: '',
    hint: 'Ask across every thread record: decisions, summaries, changes',
    keywords: 'assistant ask question records search ai',
  },
];

/** Everything else, tucked under "More" in the sidebar. All of it stays one keystroke away (G chords, ⌘K). */
export const MORE_NAV: NavItem[] = [
  {
    segment: 'projects',
    label: 'Projects',
    icon: LucideBox,
    keys: 'g p',
    hint: 'Planned outcomes: what we want to achieve, by when, and where',
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
    hint: 'Finished work, work in progress and estimates',
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

/**
 * Destinations a guest does not get: saved views and statistics (workspace-wide), Ask and "Connect your
 * agent" (AI and tokens need the whole workspace). Everything else shows only what their projects hold.
 */
export const GUEST_HIDDEN_SEGMENTS: ReadonlySet<string> = new Set(['assistant', 'views', 'stats', 'connect']);

/** Whether a guest may open the first path segment of a workspace URL (`tasks`, `settings`, …). */
export function guestMayOpen(segment: string | null | undefined): boolean {
  return !segment || !GUEST_HIDDEN_SEGMENTS.has(segment);
}

/** `items` without the destinations a guest does not get. Everyone else keeps them all. */
export function navForRole<T extends { segment: string }>(items: readonly T[], guest: boolean): T[] {
  return guest ? items.filter((item) => guestMayOpen(item.segment)) : [...items];
}

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
  overview: 'Home',
  board: 'Board',
  timer: 'Time',
  stats: 'Statistics',
  inbox: 'Inbox',
  assistant: 'Ask',
  connect: 'Connect your agent',
  tasks: 'Tasks',
  issues: 'Tasks',
  projects: 'Projects',
  timeline: 'Timeline',
  views: 'Views',
  activity: 'Activity',
  settings: 'Settings',
};

/** Sections that have a list page to link back to. */
export const SECTIONS_WITH_LIST = new Set([
  'tasks',
  'issues',
  'projects',
  'views',
  'settings',
]);
