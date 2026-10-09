// Keyboard shortcut catalogue — single source for the global handler, the shortcuts
// dialog and the hints shown in the command palette.

/** `G` then <key> → route segment under /:workspaceSlug (within GO_CHORD_TIMEOUT ms). */
export const GO_TO_ROUTES: Record<string, { segment: string; label: string }> = {
  o: { segment: 'overview', label: 'Overview' },
  y: { segment: 'stats', label: 'Statistics' },
  a: { segment: 'inbox?tab=needs-you', label: 'Inbox' },
  m: { segment: 'my-work', label: 'My work' },
  n: { segment: 'inbox?tab=updates', label: 'Inbox: updates' },
  i: { segment: 'issues', label: 'Issues' },
  c: { segment: 'customers', label: 'Customers' },
  w: { segment: 'workstreams', label: 'Workstreams' },
  d: { segment: 'decisions', label: 'Decisions' },
  p: { segment: 'projects', label: 'Projects' },
  u: { segment: 'documents', label: 'Documents' },
  r: { segment: 'repositories', label: 'Repositories' },
  x: { segment: 'graph', label: 'Graph' },
  s: { segment: 'settings/profile', label: 'Settings' },
  t: { segment: 'teams', label: 'Teams' },
  v: { segment: 'views', label: 'Views' },
  e: { segment: 'activity', label: 'Activity' },
  k: { segment: 'connect', label: 'Connect your agent' },
};

export const GO_CHORD_TIMEOUT = 1500;

export interface ShortcutEntry {
  label: string;
  /** Kbd notation understood by <app-kbd>: "mod+k", "g i", "up down" … */
  keys: string;
  /** Alternative binding rendered after "or". */
  alt?: string;
}

export interface ShortcutGroup {
  title: string;
  items: ShortcutEntry[];
}

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: 'General',
    items: [
      { label: 'Open command palette', keys: 'mod+k' },
      { label: 'Search', keys: '/' },
      { label: 'Create (context-aware)', keys: 'c' },
      { label: 'Toggle sidebar', keys: 'mod+b' },
      { label: 'Toggle theme', keys: 'mod+j' },
      { label: 'Keyboard shortcuts', keys: '?' },
      { label: 'Close / back', keys: 'esc' },
    ],
  },
  {
    title: 'Go to',
    items: Object.entries(GO_TO_ROUTES).map(([k, r]) => ({ label: r.label, keys: `g ${k}` })),
  },
  {
    title: 'Lists',
    items: [
      { label: 'Move focus', keys: 'up down', alt: 'j k' },
      { label: 'Open focused', keys: 'enter' },
      { label: 'Select', keys: 'x' },
      { label: 'Preview (issues, workstreams); select on other lists', keys: 'space' },
      { label: 'Clear selection', keys: 'esc' },
    ],
  },
];
