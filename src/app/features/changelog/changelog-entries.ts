/** Release notes, newest first. Add an entry when something user-visible ships. */
export type ChangeKind = 'new' | 'improved' | 'fixed';

export interface ChangelogEntry {
  /** ISO date (YYYY-MM-DD). */
  date: string;
  title: string;
  summary: string;
  changes: { kind: ChangeKind; text: string }[];
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    date: '2026-10-08',
    title: 'A public home for Trama',
    summary: 'Trama now has a landing page, a blog, a public roadmap and this changelog.',
    changes: [
      {
        kind: 'new',
        text: 'Landing page at / for signed-out visitors, with a side-by-side comparison with Trello, Jira and Linear.',
      },
      {
        kind: 'new',
        text: 'Blog, starting with “Introducing Trama” and “Trama vs Trello, Jira and Linear”.',
      },
      { kind: 'new', text: 'Public roadmap and changelog.' },
      {
        kind: 'improved',
        text: 'Account creation moved to /register; old /signup links keep working.',
      },
    ],
  },
  {
    date: '2026-10-08',
    title: 'Agents, assistant and scoped tokens',
    summary: 'Agents get precise permissions, and the assistant is one keystroke away.',
    changes: [
      {
        kind: 'new',
        text: 'API tokens with fine-grained resource × action permissions and usage caps.',
      },
      {
        kind: 'new',
        text: 'Assistant popup with chat history, a full-page view and unread markers for replies that arrive out of sight.',
      },
      { kind: 'new', text: 'Command palette with Ask Trama and chord shortcuts.' },
      { kind: 'new', text: 'Draft status for issues, workstreams and decisions.' },
      { kind: 'improved', text: 'Compact composer with instant quick suggestions.' },
    ],
  },
  {
    date: '2026-10-08',
    title: 'Workstreams grow up',
    summary: 'Plan, sequence and unblock outcomes, and see the whole workspace at a glance.',
    changes: [
      {
        kind: 'new',
        text: 'Milestones, timeline, dependencies and input requests on workstreams.',
      },
      { kind: 'new', text: 'Overview dashboard, statistics, My Work and activity feed.' },
      {
        kind: 'new',
        text: 'Roles, agents, tokens, integrations, projects and teams in settings, plus outgoing webhooks.',
      },
      { kind: 'new', text: 'Installable mobile experience (PWA).' },
      { kind: 'new', text: 'Customizable sidebar: visibility, order and badge style.' },
      {
        kind: 'improved',
        text: 'Inline editing, bulk actions and a richer issue page; board drag-and-drop for issues and workstreams.',
      },
      {
        kind: 'improved',
        text: 'Linear-style design tokens, Inter typography and a calmer app shell.',
      },
      { kind: 'fixed', text: 'The workstream issues tab now uses the full width.' },
    ],
  },
  {
    date: '2026-10-07',
    title: 'First commit',
    summary:
      'The first version of Trama: issues, workstreams, decisions and artifacts in one workspace.',
    changes: [
      {
        kind: 'new',
        text: 'Issues, workstreams, decisions and artifacts, with an API and PostgreSQL storage.',
      },
      { kind: 'new', text: 'Workspaces, teams, projects and saved views.' },
    ],
  },
];
