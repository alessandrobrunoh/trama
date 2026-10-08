/**
 * Blog content. Posts are static and authored here; `html` fields are trusted markup
 * (inline `<strong>`, `<em>`, `<code>`, `<a>` only) rendered through Angular's sanitizer.
 */
export type BlogBlock =
  | { type: 'p'; html: string }
  | { type: 'h2'; text: string; id: string }
  | { type: 'list'; items: string[] }
  | { type: 'quote'; text: string }
  | { type: 'code'; text: string }
  | { type: 'comparison' };

export interface BlogPost {
  slug: string;
  title: string;
  description: string;
  /** ISO date (YYYY-MM-DD). */
  date: string;
  readingMinutes: number;
  tag: string;
  blocks: BlogBlock[];
}

/** Newest first. */
export const BLOG_POSTS: readonly BlogPost[] = [
  {
    slug: 'trama-vs-trello-jira-linear',
    title: 'Trama vs Trello, Jira and Linear: why another issue tracker?',
    description:
      'Trello, Jira and Linear are excellent at tracking tickets. Trama starts from a different question: what is the unit of work when humans and agents ship together?',
    date: '2026-10-08',
    readingMinutes: 8,
    tag: 'Comparison',
    blocks: [
      {
        type: 'p',
        html: 'Every team that sees Trama for the first time asks the same thing: <em>we already have a tracker, why would we need another one?</em> It is a fair question. Trello, Jira and Linear are mature, well-loved products. We use ideas from all three every day.',
      },
      {
        type: 'p',
        html: 'This post is our honest answer. We will look at what each tool does best, where the ticket-centric model starts to strain, and where Trama is deliberately different. If one of the others is the better fit for your team, we will say so.',
      },
      { type: 'h2', id: 'shared-assumption', text: 'The assumption all three share' },
      {
        type: 'p',
        html: 'Under very different interfaces, Trello, Jira and Linear agree on one thing: <strong>the ticket is the unit of work</strong>. Someone reports a problem, the ticket gets an assignee, a branch, a pull request, and is closed when the PR merges.',
      },
      { type: 'code', text: 'Issue → Assignee → Branch → Pull request → Review → Done' },
      {
        type: 'p',
        html: 'That works when one report maps to one piece of work. It strains when five bug reports share one root cause, when a fix spans three repositories, when two developers and an agent work in the same context, or when someone has to pick up the work next week and reconstruct why it went the way it did.',
      },
      {
        type: 'p',
        html: 'Coding agents make this more common, not less. The industry response has mostly been to make the agent another assignee on the ticket. Trama takes a different route: keep the ticket for what it is good at, and add the layer that is missing.',
      },
      { type: 'h2', id: 'trello', text: 'Trello: the friendliest board' },
      {
        type: 'p',
        html: '<strong>Where it shines.</strong> Trello is the simplest way to see work move. Boards, lists and cards are understood by anyone in minutes, and they adapt to almost anything: a content calendar, a hiring pipeline, a small product backlog.',
      },
      {
        type: 'p',
        html: '<strong>Where it strains for software teams.</strong> A card is the request, the plan, the discussion and the status at the same time. Grouping cards around a root cause means a label or a dedicated list; context lives in long comment threads; links to code depend on Power-Ups. Progress is wherever the card currently sits.',
      },
      {
        type: 'p',
        html: '<strong>Choose Trello</strong> when the team is small, the work is not primarily engineering, and simplicity beats structure.',
      },
      { type: 'h2', id: 'jira', text: 'Jira: the configurable enterprise standard' },
      {
        type: 'p',
        html: '<strong>Where it shines.</strong> Jira can model nearly any process: custom workflows, fields, permissions, epics, sprints, dashboards and an enormous marketplace. For large organisations with compliance needs and many teams, that flexibility is the point.',
      },
      {
        type: 'p',
        html: '<strong>Where it strains.</strong> The epic → story → sub-task hierarchy is about <em>decomposing scope</em>, not about recognising that several independent reports have one cause. Decisions tend to drift into Confluence pages that are hard to find from the work. Progress is often story points and burndown charts: estimates presented as facts. And every configurable field is a field someone has to keep up to date.',
      },
      {
        type: 'p',
        html: '<strong>Choose Jira</strong> when you need deep process customisation, an established enterprise ecosystem, or a self-managed deployment with vendor support.',
      },
      { type: 'h2', id: 'linear', text: 'Linear: fast, opinionated, built for engineers' },
      {
        type: 'p',
        html: '<strong>Where it shines.</strong> Linear proved that an issue tracker can be fast and pleasant. Keyboard-first navigation, cycles, projects and a tight Git integration that moves issues as pull requests open and merge. Trama’s interface openly borrows from that standard of craft.',
      },
      {
        type: 'p',
        html: '<strong>Where it strains.</strong> The issue is still the unit of execution, and projects group work by initiative or timeline rather than by shared cause. When work is solved by one change across many issues, the PR links get scattered across tickets and the reasoning lives in comments. Agents can take issues, but they take them the way a human assignee would: one ticket at a time.',
      },
      {
        type: 'p',
        html: '<strong>Choose Linear</strong> when your work maps cleanly to one issue per change and you want the most polished hosted tracker available.',
      },
      { type: 'h2', id: 'trama', text: 'Where Trama is different' },
      {
        type: 'p',
        html: 'Trama keeps the issue exactly as you know it, with statuses, priorities, estimates, teams and views. Then it separates four things that a ticket usually has to carry alone:',
      },
      {
        type: 'list',
        items: [
          '<strong>Issues</strong> describe demand: the bug, the request, the incident.',
          '<strong>Workstreams</strong> describe the outcome: the coordinated effort that solves one or many issues, with an objective, acceptance criteria and a link to the shared workspace where the work happens.',
          '<strong>Decisions</strong> preserve the why: proposed, accepted or superseded, linked to the work they shaped.',
          '<strong>Artifacts</strong> show what was delivered: pull requests, documents and releases, with CI and review state, traced back to the issues they addressed.',
        ],
      },
      {
        type: 'p',
        html: 'Two principles follow from that. First, <strong>no fake progress</strong>: a workstream’s status is derived from observable facts such as resolved issues, merged pull requests and met criteria, never from a percentage someone typed. Second, <strong>agents are contributors, not just assignees</strong>: they join a workstream next to people, ask humans for input when they are blocked, and use API tokens scoped per resource and action, with usage caps.',
      },
      { type: 'h2', id: 'side-by-side', text: 'Side by side' },
      { type: 'comparison' },
      {
        type: 'p',
        html: 'A note on fairness: all of these products evolve quickly, and each can be stretched with plugins and conventions. The table describes their default model, not the limits of what a determined admin can build.',
      },
      { type: 'h2', id: 'switching', text: 'Do I have to switch everything?' },
      {
        type: 'p',
        html: 'No. Trama is designed for gradual adoption. One issue, one workstream is a perfectly valid way to start, and the model only shows its depth when your work needs it. Issues can already arrive from the API, email, GitHub, GitLab or an agent. Linking issues that live in Jira, Linear or GitHub Issues directly to a Trama workstream is on our roadmap, so a team can add the coordination layer without moving its backlog on day one.',
      },
      { type: 'h2', id: 'summary', text: 'The short version' },
      {
        type: 'list',
        items: [
          'Pick <strong>Trello</strong> for simple, visual, mostly non-engineering work.',
          'Pick <strong>Jira</strong> for heavy process customisation at enterprise scale.',
          'Pick <strong>Linear</strong> for a fast hosted tracker where one issue maps to one change.',
          'Pick <strong>Trama</strong> when several issues share one fix, when humans and agents work in the same context, and when you want the decisions and artifacts to stay attached to the outcome. Open source, on your own infrastructure.',
        ],
      },
    ],
  },
  {
    slug: 'introducing-trama',
    title: 'Introducing Trama',
    description:
      'Issues describe problems. Workstreams organise outcomes. Decisions and artifacts explain what was delivered. Meet the open-source coordination layer for humans and coding agents.',
    date: '2026-10-06',
    readingMinutes: 6,
    tag: 'Announcement',
    blocks: [
      {
        type: 'p',
        html: 'Today we are opening up <strong>Trama</strong>, an open-source coordination layer for software teams that work with coding agents. The name is Italian for <em>weft</em>: the thread that runs across a loom and turns separate strands into one fabric. That is what we want Trama to do for your work.',
      },
      { type: 'h2', id: 'shape-of-work', text: 'The shape of work changed' },
      {
        type: 'p',
        html: 'For a long time, software work had a natural shape: one issue, one developer, one branch, one pull request. Issue trackers were built around it, and they are very good at it.',
      },
      {
        type: 'p',
        html: 'That shape is no longer the only one. A single architectural change now routinely closes several bug reports. Agents delegate to sub-agents. One effort spans multiple repositories and several contributors, some human, some not. And the context that explains the work lives in a shared workspace, not only in commit messages.',
      },
      {
        type: 'quote',
        text: 'The unit used to report a problem does not have to be the same unit used to execute the solution.',
      },
      { type: 'h2', id: 'issues', text: 'Issues stay first-class' },
      {
        type: 'p',
        html: 'We are not trying to replace the issue. Bugs, requests, incidents, tech debt and feedback are still best described one at a time, with the statuses, priorities and estimates your team already understands. In Trama, issues are the <strong>unit of demand</strong>: what problems exist?',
      },
      { type: 'h2', id: 'workstreams', text: 'Meet the workstream' },
      {
        type: 'p',
        html: 'A <strong>workstream</strong> is a coherent outcome your team has decided to pursue. It expresses a decision: <em>these pieces of work belong together because solving them together leads to one meaningful result.</em>',
      },
      {
        type: 'code',
        text: 'AUTH-12  Stabilize authentication before v2\n\nIssues\n├── BUG-142  Session expires unexpectedly\n├── BUG-148  OAuth callback loops on Safari\n├── BUG-153  Logout leaves a stale cookie\n└── BUG-159  Refresh token occasionally fails\n\nWorkspace     Delta thread ↗\nAccountable   Alessandro\nContributors  Marco, Sara, claude-code\nArtifacts     PR #201, PR #204, ADR-021',
      },
      {
        type: 'p',
        html: 'A workstream has an objective, acceptance criteria, an accountable owner, participating teams and repositories. It links to the shared workspace where the implementation actually happens, so the next person, or the next agent, can open it and continue instead of reconstructing context from chat logs and Git history.',
      },
      {
        type: 'p',
        html: 'Workstreams are not epics (containers for scope) and not projects (broad initiatives). They are operational: one coordinated effort toward one outcome. Issues are grouped <strong>by outcome, not by convenience</strong>.',
      },
      { type: 'h2', id: 'decisions-artifacts', text: 'Decisions and artifacts' },
      {
        type: 'p',
        html: 'Most of the reasoning behind a change happens in conversation. Trama does not try to copy that conversation. Instead, when a choice has lasting relevance, it becomes a <strong>decision</strong>: a short record with its rationale and a lifecycle (proposed, accepted, superseded), linked to the work it shaped.',
      },
      {
        type: 'p',
        html: '<strong>Artifacts</strong> are what the work produced: pull requests, documents, designs, builds and releases, with their CI and review state. They are traced back to the issues they addressed, so you can always answer <em>why does this PR exist, and what did it fix?</em>',
      },
      { type: 'h2', id: 'facts', text: 'Facts, not fake progress' },
      {
        type: 'p',
        html: 'You will not find a “73% complete” bar in Trama unless something can actually be measured. A workstream’s status is derived from facts: issues resolved, pull requests merged, acceptance criteria met. When something needs a human, it shows up in <strong>My Attention</strong> instead of hiding behind an optimistic percentage.',
      },
      { type: 'h2', id: 'agents', text: 'Agent-native, not agent-dependent' },
      {
        type: 'p',
        html: 'Agents such as Claude Code, Codex or Cursor are first-class participants. They connect through the API and our MCP server, report progress, attach artifacts and open <em>input requests</em> when they need a human answer. Every token is scoped per resource and action, with usage caps, so an agent can do exactly what you allow and nothing more.',
      },
      {
        type: 'p',
        html: 'At the same time, nothing in Trama requires AI. The workstream model works just as well for a team of people, and it does not collapse if a provider changes.',
      },
      { type: 'h2', id: 'open-source', text: 'Open source and self-hosted' },
      {
        type: 'p',
        html: 'Trama is licensed under the <strong>AGPL-3.0</strong>. It runs as an Angular web app and a NestJS API on top of PostgreSQL, with no infrastructure zoo required. The open-source edition is the real product, not a demo of it.',
      },
      { type: 'h2', id: 'next', text: 'What comes next' },
      {
        type: 'list',
        items: [
          'Deeper GitHub and GitLab integrations, so artifacts and their state are discovered automatically.',
          'Linking issues that live in Jira, Linear or GitHub Issues to Trama workstreams, for teams that want to adopt Trama gradually.',
          'Richer context exchange with shared agent workspaces.',
        ],
      },
      {
        type: 'p',
        html: 'Curious how Trama compares to the tools you use today? Read <a href="/blog/trama-vs-trello-jira-linear">Trama vs Trello, Jira and Linear</a>. Or simply create a workspace and group your first issues into a workstream.',
      },
    ],
  },
];

export function findPost(slug: string | undefined): BlogPost | undefined {
  return BLOG_POSTS.find((p) => p.slug === slug);
}
