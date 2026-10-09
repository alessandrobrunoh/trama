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
    date: '2026-10-09',
    title: 'Customers: see who is waiting on what',
    summary: 'A customer list and page built around demand, demand filters on issues, projects and views, and a bell that tells you when a request is delivered.',
    changes: [
      {
        kind: 'new',
        text: 'Customers list with revenue, size, tier, requests, important requests and what is still waiting. Sort, group by tier or status, filter, and keep your cuts while you navigate.',
      },
      {
        kind: 'new',
        text: 'Customer page with requests (waiting, delivered, important), the work they asked for grouped your way, and an activity timeline.',
      },
      {
        kind: 'new',
        text: 'Follow a customer to be told when a request is added, flagged important or delivered, when the issue is done or the project completed. Whoever recorded a request hears about its delivery too.',
      },
      {
        kind: 'new',
        text: 'Filter and sort issues, projects and saved views by customer, tier, number of customers or requests, revenue and size. Issue, project and workstream pages show who is waiting.',
      },
      {
        kind: 'new',
        text: 'Create a customer or a customer request from the command menu, and pin customers to your favorites. The same filters are available in the API and the MCP tools.',
      },
    ],
  },
  {
    date: '2026-10-08',
    title: 'Projects, separate from repositories',
    summary: 'Plan outcomes as projects, carry them out with workstreams, and keep repositories in their own section.',
    changes: [
      {
        kind: 'new',
        text: 'Projects: planned outcomes with a status, lead, teams, target dates and the repositories they touch.',
      },
      {
        kind: 'new',
        text: 'Milestones now belong to projects. Workstream pages show their project’s milestones read-only; workstreams that already had milestones moved into a project of their own.',
      },
      {
        kind: 'new',
        text: 'A workstream can carry out a project and works in its repositories, inherited unless you pick a subset.',
      },
      {
        kind: 'new',
        text: 'Projects in search, favorites, workstream filters, saved views and the MCP tools for agents.',
      },
      {
        kind: 'improved',
        text: 'Repositories are back in their own section at /repositories; old /projects links to repositories keep working.',
      },
    ],
  },
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
