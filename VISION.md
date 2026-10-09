# Trama Vision

> **Issues describe problems. Workstreams organize outcomes. Shared workspaces preserve implementation context. Artifacts show what was delivered.**

Trama is a source-available coordination layer for software teams working with humans and coding agents.

It keeps the familiar Issue model that software teams already understand, but introduces a new organizational unit — the **Workstream** — to represent how modern engineering work actually happens.

The central idea is simple:

> **The unit used to report a problem does not have to be the same unit used to execute the solution.**

A bug report may describe one symptom. A customer request may describe one need. A technical task may describe one implementation detail. But a team may decide that several apparently separate Issues should be solved together because they share the same root cause, touch the same architecture, or contribute to the same outcome.

That coordinated effort is a **Workstream**.

Trama exists to connect those layers without forcing teams to abandon the Issue-based workflows they already use.

---

# 1. The problem

Traditional issue trackers are optimized around a model like:

```text
Issue
  ↓
Assignee
  ↓
In Progress
  ↓
Pull Request
  ↓
Review
  ↓
Done
```

This assumes that the Issue is also the natural unit of execution.

That works well when one Issue roughly corresponds to one implementation effort.

It becomes less accurate when:

- several Issues share the same root cause;
- several developers collaborate on one implementation context;
- coding agents perform substantial parts of the work;
- agents delegate to subagents;
- the work spans several repositories;
- several Issues are solved by the same architectural change;
- implementation context exists outside Git commits alone;
- another developer may need to continue the exact same work later.

The Issue remains useful.

The mistake is assuming that an Issue must represent **the problem, the execution, the collaboration, and the outcome at the same time**.

Trama separates those concerns.

---

# 2. Core thesis

The core thesis of Trama is:

> **Issues are excellent units of demand. They are not always the best units of execution.**

The conceptual model is:

```text
Issues
"What problems or requests exist?"
        │
        ▼
Workstream
"What outcome are we pursuing?"
        │
        ▼
Shared Workspace
"Where is the implementation context?"
        │
        ▼
Artifacts
"What did the work produce?"
        │
        ▼
Outcome
"What did we actually deliver?"
```

Trama is not trying to eliminate Issues.

It adds a missing layer between Issue tracking and modern collaborative execution.

---

# 3. Issues remain first-class

Issues are not legacy objects in Trama.

They remain the familiar way to represent individual problems, requests, tasks, incidents, technical debt, improvements, security findings, and customer feedback.

Examples:

```text
BUG-142
Session expires unexpectedly

BUG-148
OAuth callback loops on Safari

BUG-153
Logout leaves a stale authentication cookie
```

An Issue can still contain familiar fields:

```text
identifier
title
description
status
priority
team
assignee
labels
project
cycle
comments
createdAt
updatedAt
```

A team should be able to use Trama almost like a traditional issue tracker if that is all it needs.

That compatibility is intentional.

The new workflow should be additive rather than destructive.

---

# 4. Workstreams

A **Workstream** represents a coherent outcome that the team has decided to pursue.

It expresses a decision:

> These pieces of work belong together because solving them together leads to one meaningful outcome.

Example:

```text
AUTH-12
Stabilize authentication before v2
```

That Workstream may contain:

```text
Issues
├── BUG-142 Session expires unexpectedly
├── BUG-148 OAuth callback loops
├── BUG-153 Logout leaves stale cookie
├── BUG-159 Refresh token occasionally fails
└── BUG-166 Safari loses session after token rotation
```

The Issues answer:

> What problems exist?

The Workstream answers:

> What are we trying to accomplish about them?

---

# 5. Workstreams are outcome-oriented

A Workstream should exist because there is a coherent outcome.

Good:

```text
AUTH-12
Stabilize authentication before v2
```

with several authentication-related bugs.

Weak:

```text
Fix ten random bugs
```

containing unrelated Issues from billing, authentication, notifications, styling, and infrastructure.

The fact that an agent can technically work on ten unrelated Issues does not make them one Workstream.

A core rule is:

> **Issues are grouped by outcome, not by convenience.**

This keeps Workstreams meaningful for the rest of the team.

---

# 6. A Workstream is not a Delta Thread

Trama is designed around workflows enabled by collaborative environments such as Delta, but a Workstream is not equivalent to a Delta Thread.

The relationship is:

```text
Workstream
    │
    └── Shared Workspace
          └── Delta Thread
```

The Workstream is the organizational layer.

The Delta Thread is the implementation workspace.

A Workstream may have:

- one primary Delta Thread;
- multiple Delta Threads over its lifetime;
- no Delta Thread at all;
- another execution environment instead;
- a mixture of human and agent work.

Therefore Trama should never encode:

```text
Workstream == Delta Thread
```

as a domain assumption.

Delta is a first-class integration, not the definition of the Workstream.

---

# 7. The shared workspace

For a Delta-based workflow, the Delta Thread is where implementation context lives.

That may include:

- conversation;
- turns;
- code changes;
- worktree state;
- branch changes;
- agent activity;
- subagents;
- code exploration;
- debugging;
- bookmarks;
- intermediate implementation history.

Trama should link to that workspace.

Trama should not mirror it.

Example:

```text
AUTH-12
Stabilize authentication before v2

Issues
5 linked

Workspace
△ Delta
Authentication stabilization
Open thread ↗

Contributors
Alessandro
Marco
Sara

Artifacts
PR #201
PR #204
ADR-021
```

A developer joining the effort should be able to:

1. open the Workstream;
2. understand the objective;
3. see which Issues are involved;
4. see who is participating;
5. see the relevant repositories;
6. understand durable decisions;
7. open the shared Delta Thread;
8. continue implementation there.

The handoff should not require reconstructing the project from chat messages and Git history.

---

# 8. Context handoff is a first-class problem

Traditional handoff often looks like:

```text
Developer A works on something

↓
writes code

↓
commits some changes

↓
writes a summary somewhere

↓
Developer B reads the Issue

↓
reads the PR

↓
asks what remains

↓
reconstructs context

↓
continues
```

That reconstruction is slow and often incomplete.

With a shared execution environment:

```text
Developer A
     │
     ▼
Shared implementation context
     │
     ▼
Developer B
```

The second developer can inspect the same working history and continue from it.

Trama's role is to make that shared context discoverable from the organizational layer.

It should not become another place where developers must rewrite that context manually.

---

# 9. Trama should not duplicate Delta

This is a hard product boundary.

Trama should not attempt to reproduce:

- Delta turns;
- full agent transcripts;
- subagent trees;
- worktree internals;
- prompt history;
- bookmarks;
- every file change;
- every action performed by the agent;
- detailed implementation history.

Those belong to the execution environment.

If a developer needs implementation detail, the correct action is:

```text
Open in Delta
```

not:

```text
Open the copied Delta history inside Trama
```

Duplicating execution history would create:

- two sources of truth;
- synchronization problems;
- additional storage;
- confusing UX;
- fragile integrations;
- unnecessary maintenance.

Trama exists above that layer.

---

# 10. The duplication test

Every new Trama feature should be evaluated with one question:

> **Would the developer feel like they already did this somewhere else and now have to document it again in Trama?**

If yes, the feature is probably wrong.

Bad examples:

```text
"Mark an implementation checkpoint in Trama"
"Copy this Delta bookmark into Trama"
"Summarize what the agent just did"
"List which files were modified"
"Update completion percentage"
"Record which subagent handled each change"
```

Those are forms of bookkeeping, not durable coordination.

A central product principle is:

> **If using Trama feels like “I already did this in Delta, now I need to document it again”, the workflow is wrong.**

---

# 11. What belongs in Trama

Trama should contain information whose value extends beyond the implementation session.

Examples:

- Workstream objective;
- linked Issues;
- status;
- priority;
- owner team;
- accountable person;
- participating teams;
- contributors;
- relevant repositories;
- important decisions;
- dependencies;
- artifacts;
- delivery state;
- Project relationship;
- dates and deadlines;
- final outcome.

The key question is:

> Will someone who never opens the Delta Thread still need this information?

If yes, it probably belongs in Trama.

---

# 12. What belongs in Delta

Implementation-local information belongs in the shared workspace.

Examples:

- coding conversation;
- exploration;
- temporary approaches;
- failed attempts;
- prompts;
- agent turns;
- subagents;
- file changes;
- branch switching;
- local implementation notes;
- debugging details;
- implementation bookmarks.

The key question is:

> Is this mainly useful to someone continuing the implementation?

If yes, it probably belongs in Delta.

---

# 13. Decisions

Decisions are the main exception.

Important decisions should be elevated into Trama when they become durable organizational knowledge.

Example:

```text
Decision

Keep the previous refresh token valid for 30 seconds after rotation.

Reason

Concurrent requests may still carry the previous token.
Immediately invalidating it creates unnecessary session failures.
```

The discussion may have happened inside Delta.

But once the decision is made, the conclusion should be available independently.

Future developers, reviewers, product owners, and agents should not have to search through a long implementation thread to rediscover it.

Therefore:

```text
Discussion → Delta
Durable decision → Trama
```

Not every coding choice deserves a Decision.

Only choices with lasting relevance should be promoted.

---

# 14. Artifacts

Artifacts represent concrete outputs produced by a Workstream.

Examples:

- Pull Requests;
- Merge Requests;
- commits;
- branches;
- documents;
- ADRs;
- designs;
- builds;
- test reports;
- deployments;
- releases.

Example:

```text
AUTH-12
Stabilize authentication before v2

Artifacts

PR #201
Fix refresh token rotation

PR #204
Fix Safari session handling

ADR-021
Authentication token strategy

Deployment
v2.4.0
```

Artifacts connect intent to delivered change.

Trama should automate artifact discovery where reliable integrations exist.

## Documents

Some knowledge has no home in a repository: the spec of a feature, a plan, the notes of a decision that is still forming. Trama keeps those as **documents**: Markdown pages of the workspace that people and agents write in Trama itself and attach, as `document` artifacts, to the projects, workstreams and issues they explain. A document is one page however many places it is attached to.

Documents obey the duplication test: they are for what is written once, on purpose. They never mirror a README, an ADR already in a repository, a Delta thread or an issue body. When the text already exists elsewhere, attach a link artifact instead.

---

# 15. Traceability

Grouping Issues into Workstreams must not destroy traceability.

A team should still be able to see which artifacts addressed which problems.

Example:

```text
AUTH-12

BUG-142
└── PR #201

BUG-148
└── PR #204

BUG-153
├── PR #201
└── PR #204
```

The relationship can be many-to-many.

A team should eventually be able to answer:

- Why was this PR created?
- Which Issues did it address?
- Which Workstream did it belong to?
- Where was the implementation discussed?
- Which important decisions were made?
- Was the outcome delivered?

---

# 16. Workstream lifecycle

The Workstream lifecycle should be simpler than the implementation lifecycle.

A reasonable initial model is:

```text
Planned
Active
Review
Completed
Cancelled
```

Potentially:

```text
Paused
```

if real team usage justifies it.

These states describe the organizational state of the outcome.

For example:

```text
Active
```

means:

> The team considers this outcome actively being pursued.

It does **not** mean:

> Delta is currently generating code.

That distinction keeps Trama truthful.

---

# 17. Manual first, automation second

Trama should prefer truthful manual state over fake automation.

Early versions can use:

```text
Workstream state → manual
Delta link → manual
Issue grouping → manual
Decisions → manual
```

while Git integrations automate observable facts such as:

```text
PR discovered
PR opened
CI failing
CI passing
review requested
approved
merged
deployment succeeded
```

Over time, Trama may suggest state changes:

```text
All linked PRs are merged.
Mark Workstream as Completed?
```

Suggestions are often safer than invisible automation.

---

# 18. No fake progress

Trama should not invent software progress percentages.

Avoid:

```text
73% complete
███████░░░
```

unless the percentage represents something explicitly measurable.

Prefer observable facts:

```text
5 Issues linked
3 resolved

2 PRs open
1 merged

CI passing

Review pending
```

Trama should communicate facts, not simulated certainty.

---

# 19. Contributors are not assignees

Issues may continue to have an assignee.

Workstreams need a richer ownership model.

Example:

```text
AUTH-12

Accountable
Alessandro

Owner team
Platform

Contributors
Alessandro
Marco
Sara

Participating teams
Platform
Security
Web
```

Trama should distinguish:

- Issue assignment;
- Workstream accountability;
- participation;
- team ownership.

A Workstream does not need one person who performs every part of the implementation.

---

# 20. Many Issues, one Workstream

This is the most important new workflow.

```text
BUG-142 ─┐
BUG-148 ─┤
BUG-153 ─┼── AUTH-12
BUG-159 ─┤   Stabilize authentication
BUG-166 ─┘
```

This is valuable when:

- several bugs share a root cause;
- several requests require the same architectural change;
- a migration resolves many tasks;
- a performance initiative addresses several complaints;
- a reliability effort spans several incidents.

The Issue remains the unit of demand.

The Workstream becomes the unit of coordinated outcome.

---

# 21. One Issue, multiple Workstreams

This may also be valid in some cases.

Example:

```text
SEC-18
Improve account security
```

could contribute to:

```text
AUTH-12
Authentication stabilization
```

and:

```text
SEC-31
Enterprise security hardening
```

This should be allowed where it reflects reality, but the product should discourage a graph so unconstrained that relationships lose meaning.

Clear semantics matter more than unlimited flexibility.

---

# 22. Workstreams are not Epics

A Workstream may superficially resemble an Epic.

The intended meaning is different.

An Epic is commonly:

> a large container for related Issues.

A Workstream is:

> a concrete coordinated effort toward one outcome, connected to the shared context where that effort is actually being executed.

The execution-context relationship is important.

Workstreams should feel operational rather than purely hierarchical.

---

# 23. Workstreams are not Projects

Projects represent broader initiatives.

Example:

```text
Project
Launch v2
│
├── Workstream
│   Stabilize authentication
│
├── Workstream
│   Rewrite onboarding
│
└── Workstream
    Improve checkout reliability
```

A Project answers:

> What broader initiative are we pursuing?

A Workstream answers:

> What coordinated outcome are we actively trying to produce?

An Issue answers:

> What individual problem, request, or task exists?

---

# 24. Shared workspaces are references, not mirrors

Trama should model shared workspaces generically.

Conceptually:

```text
WorkspaceLink

id
workstreamId
provider
title
url
externalId?
metadata?
createdAt
```

The first important provider is Delta.

Future providers should be possible without redesigning the Workstream model.

---

# 25. Delta-first, not Delta-dependent

Delta is the primary workflow Trama is currently designed around.

This is intentional.

Trama should take advantage of Delta's shared thread model and persistent implementation context.

But:

```text
Trama core != Delta API wrapper
```

Trama should still make sense when:

- a team uses another execution environment;
- some Workstreams are human-only;
- Delta changes;
- another provider becomes important later.

The project should be **Delta-first, not Delta-dependent**.

---

# 26. Typical workflow

Consider five bug reports:

```text
BUG-142
Session expires unexpectedly

BUG-148
OAuth callback loops on Safari

BUG-153
Logout leaves stale cookies

BUG-159
Refresh token occasionally fails

BUG-166
Safari loses session after token rotation
```

Initially, they exist independently.

The team realizes they likely share the same authentication architecture.

A developer creates:

```text
AUTH-12
Stabilize authentication before v2
```

and links the five Issues.

The Workstream becomes:

```text
AUTH-12

Objective
Authentication should remain reliable across refresh,
logout and OAuth flows before the v2 release.

Issues
5 linked

Repositories
api
web
auth-service

Workspace
Delta Thread ↗

Accountable
Alessandro

Contributors
Alessandro
Marco
Sara
```

Inside Delta, the team may:

- investigate the bugs;
- ask the main agent to identify common root causes;
- delegate independent problems to subagents;
- switch branches;
- modify multiple repositories;
- review proposed changes;
- continue the work from another developer's machine.

Trama does not need to understand every internal step.

As outputs appear:

```text
Artifacts

PR #201
Refresh token rotation

PR #204
Safari session handling

ADR-021
Authentication token strategy
```

they are linked to the Workstream.

When the outcome is achieved:

```text
AUTH-12
Completed
```

and the relevant Issues can be resolved.

---

# 27. Workstream page

The Workstream should become the central Trama view for coordinated work.

Conceptually:

```text
AUTH-12
Stabilize authentication before v2

Active · High priority

Objective
Authentication remains reliable across refresh,
logout and OAuth flows before v2.

Owner
Platform

Accountable
Alessandro

Contributors
Alessandro · Marco · Sara

Repositories
api · web · auth-service

────────────────────────────────────────

Issues                                    5

BUG-142   Session expires unexpectedly
BUG-148   OAuth callback loops
BUG-153   Logout leaves stale cookies
BUG-159   Refresh token occasionally fails
BUG-166   Safari loses session after rotation

────────────────────────────────────────

Workspace

△ Delta
Authentication stabilization
Open shared thread ↗

────────────────────────────────────────

Decisions

Token rotation grace period = 30 seconds

────────────────────────────────────────

Artifacts

PR #201   Refresh token rotation        Merged
PR #204   Safari session handling       Review
ADR-021   Authentication strategy

────────────────────────────────────────

Activity

Marco linked PR #204
Alessandro recorded a decision
BUG-142 was resolved
PR #201 was merged
```

The page should answer most organizational questions without opening Delta.

Delta remains one click away when implementation detail is needed.

---

# 28. Issue page

Issues should remain familiar.

Example:

```text
BUG-142
Session expires unexpectedly

Status
In Progress

Priority
High

Assignee
Marco

Project
v2 Launch

Workstreams

AUTH-12
Stabilize authentication before v2
```

The Workstream relationship enriches the Issue without turning the Issue itself into the full execution model.

---

# 29. Issue state and Workstream state differ

An Issue may use:

```text
Backlog
Todo
In Progress
In Review
Done
Canceled
```

A Workstream may use:

```text
Planned
Active
Review
Completed
Cancelled
```

They should not be forced to move together.

Example:

```text
AUTH-12
Active

BUG-142
Done

BUG-148
In Progress

BUG-153
Todo

BUG-159
Done

BUG-166
In Review
```

This is valid.

The Workstream remains Active until the overall outcome is achieved.

---

# 30. Projects

Projects represent larger initiatives.

Example:

```text
Project
Launch v2

Goal
Ship v2 with stable authentication,
new onboarding and improved checkout.

Workstreams

AUTH-12
Stabilize authentication

WEB-8
Rewrite onboarding

PAY-21
Improve checkout reliability
```

Projects should not become duplicates of Workstreams.

---

# 31. Teams

Workstreams can span multiple teams.

This should be normal.

Example:

```text
AUTH-12

Owner team
Platform

Participating teams
Security
Web
Mobile
```

Trama should not require copying the Workstream into four team-specific objects.

Each team should simply be able to see the Workstreams in which it participates.

---

# 32. Repositories

Repositories provide context.

A Workstream may involve:

```text
api
web
auth-service
infra
```

Trama should allow linking repositories to Projects and Workstreams.

Detailed repository state remains owned by Git and the execution environment.

Trama should not become a Git client.

---

# 33. GitHub and GitLab

Git integrations provide reliable automation.

Trama should progressively support:

- repository connections;
- Pull Request discovery;
- Merge Request discovery;
- commit references;
- CI state;
- reviews;
- merges;
- deployments.

A Workstream identifier such as:

```text
AUTH-12
```

may appear in:

```text
branch names
PR titles
PR descriptions
commit messages
```

Trama can use these signals to suggest associations.

Example:

```text
Detected PR #201
"AUTH-12 Fix refresh token rotation"

Attach to AUTH-12?
```

When confidence is uncertain, Trama should suggest rather than silently guess.

---

# 34. External Issue trackers

Long term, Issues do not necessarily have to originate inside Trama.

A Workstream could organize Issues from:

```text
GitHub Issues
GitLab Issues
Linear
Jira
Trama
```

Example:

```text
JIRA AUTH-182 ─┐
JIRA AUTH-191 ─┼── AUTH-12 Workstream
GitHub #882 ───┘
```

This is strategically important because an organization could adopt Trama without replacing its existing tracker on day one.

A realistic path is:

```text
Existing tracker
      +
    Trama
```

before:

```text
Trama as the primary Issue tracker
```

This is a long-term direction, not a V1 requirement.

---

# 35. Compatibility with existing workflows

Trama must support gradual adoption.

Simple:

```text
1 Issue
  ↓
1 Workstream
```

Advanced:

```text
Issue ─┐
Issue ─┼── Workstream
Issue ─┘
```

A team should not need to understand the entire Workstream model before receiving value.

The product should reveal complexity only when necessary.

---

# 36. My Work

Traditional trackers have:

```text
My Issues
```

Trama may evolve toward:

```text
My Issues
My Workstreams
Workstreams I contribute to
Reviews waiting on me
Decisions waiting on me
```

However, Trama should not build a complex attention engine before it has reliable signals.

The early product should remain explicit and predictable.

---

# 37. Search

Global search should eventually understand:

```text
Issues
Workstreams
Projects
People
Teams
Repositories
Artifacts
Decisions
```

Searching:

```text
authentication
```

should help discover:

```text
AUTH-12
BUG-142
PR #201
ADR-021
```

regardless of where each object lives.

---

# 38. Activity

Activity should capture meaningful organizational changes.

Good examples:

```text
BUG-142 added to AUTH-12
Marco joined AUTH-12
Delta workspace linked
Decision added
PR #201 linked
PR #201 merged
Workstream moved to Review
Workstream completed
```

Bad examples:

```text
Agent edited auth.ts
Agent opened file x
Subagent sent a message
Agent switched branch
```

Those belong in the execution environment.

Trama's activity feed should remain useful rather than noisy.

---

# 39. Notifications

Notifications should follow the same boundary.

Useful:

```text
You were added to AUTH-12
A decision requires your review
PR #204 was approved
AUTH-12 moved to Review
```

Not useful in Trama:

```text
Agent edited a file
Agent created a subagent
Agent sent another turn
Agent changed branch
```

The execution environment already owns that detail.

---

# 40. Product principles

## Keep the Issue

The Issue workflow remains useful and widely understood.

Trama extends it instead of replacing it.

## Separate demand from coordinated execution

The object that reports a problem does not have to own the entire solution lifecycle.

## Organize around outcomes

Workstreams represent coherent outcomes, not arbitrary ticket batches.

## Preserve shared context

Modern implementation context may live in a collaborative workspace.

Trama should make that workspace discoverable.

## Do not duplicate execution tools

Trama should not become a worse version of Delta, GitHub, GitLab, or an IDE.

## Minimize bookkeeping

Every manual field has a cost.

Manual information should exist only when its organizational value justifies that cost.

## Automate only reliable facts

Prefer:

```text
PR merged
```

over:

```text
Agent is 84% finished
```

## Be useful without AI

The Workstream model should still work for human-only teams.

## Be agent-native without being agent-dependent

Agents are first-class participants, but Trama should not collapse if one provider changes or disappears.

## Stay self-hostable

Teams should be able to run Trama on infrastructure they control.

---

# 41. What Trama is not

Trama is not:

- a replacement for Delta;
- another coding-agent chat UI;
- a Git client;
- a transcript viewer;
- a prompt-management product;
- an agent telemetry dashboard;
- a system for copying Delta bookmarks;
- a system for tracking every agent action;
- a dashboard full of invented progress percentages;
- a Linear clone with an AI button;
- a mandatory replacement for Jira, Linear, GitHub Issues, or GitLab Issues.

Trama is the layer that connects organizational intent to shared implementation context and delivered artifacts.

---

# 42. Anti-goals

## Do not model every Delta concept

Trama does not need domain equivalents for:

```text
Turn
Subagent
Prompt
Bookmark
Tool call
Worktree internals
```

## Do not require double documentation

Users should not summarize in Trama what already exists naturally in Delta.

## Do not force Workstreams everywhere

A trivial Issue should not require ceremony.

## Do not turn Workstreams into arbitrary folders

Grouping unrelated tickets destroys the model.

## Do not hide uncertainty

If Trama cannot know something, it should not pretend it can.

## Do not optimize dashboards before workflow

The core value is the workflow and domain model.

Analytics can come later.

---

# 43. Conceptual data model

The exact schema will evolve, but the concepts should remain stable.

## Issue

```text
Issue
├── identifier
├── title
├── description
├── status
├── priority
├── team
├── assignee
├── project
├── labels
└── comments
```

## Workstream

```text
Workstream
├── identifier
├── title
├── objective
├── status
├── priority
├── project
├── owner team
├── accountable user
├── contributors
├── participating teams
├── repositories
├── Issues
├── workspace links
├── decisions
└── artifacts
```

## Workspace Link

```text
WorkspaceLink
├── provider
├── external ID
├── title
├── URL
└── metadata
```

## Decision

```text
Decision
├── title
├── description
├── rationale
├── author
└── timestamp
```

## Artifact

```text
Artifact
├── type
├── provider
├── title
├── URL
├── state
└── metadata
```

---

# 44. Relationship model

Conceptually:

```text
Project
   │
   ├───────────────┐
   ▼               ▼
Workstream     Workstream
   │
   ├── Issues
   ├── Workspace Links
   ├── Decisions
   ├── Artifacts
   ├── Contributors
   └── Repositories
```

Issues may exist independently.

Workstreams may belong to Projects.

Artifacts may optionally be related to specific Issues as well as the Workstream.

---

# 45. UX principles

Trama should feel:

- fast;
- compact;
- keyboard-friendly;
- calm;
- information-dense;
- low-friction;
- understandable without documentation.

The default experience should answer:

```text
What is this?
Why are we doing it?
Which problems are included?
Who is involved?
Where is the work happening?
What has been decided?
What has been produced?
What is the current organizational state?
```

The UI should not expose the full complexity of the relationship graph unless the user needs it.

---

# 46. Open in Delta is first-class

For a Delta-backed Workstream:

```text
AUTH-12
Stabilize authentication

[ Open in Delta ↗ ]
```

should be a primary action.

The shared thread should not be hidden inside attachments or comments.

It is part of the Workstream's identity.

---

# 47. Creating a Workstream

Creation should remain lightweight.

Example:

```text
Create Workstream

Title
Stabilize authentication before v2

Objective
Make authentication reliable across refresh,
logout and OAuth before release.

Issues
+ BUG-142
+ BUG-148
+ BUG-153
+ BUG-159
+ BUG-166

Workspace
+ Delta Thread

Owner team
Platform

Accountable
Alessandro
```

Everything else can be added later.

Creating a Workstream should not feel like filling out enterprise project-management paperwork.

---

# 48. Delta integration strategy

The integration can mature progressively.

## Phase 1 — Link

```text
Workstream ↔ Delta Thread URL
```

This alone provides meaningful value.

## Phase 2 — Metadata

If reliable public capabilities support it:

```text
thread title
participants
last updated
repository metadata
```

## Phase 3 — Context exchange

Potentially:

```text
Trama → execution workspace

objective
linked Issues
decisions
repository context
```

## Phase 4 — Events

Only when reliably supported:

```text
execution workspace → Trama

meaningful state signals
```

Trama should not rely on undocumented behavior or scraping for core functionality.

---

# 49. Git integration strategy

GitHub/GitLab can provide reliable automation earlier.

Example:

```text
AUTH-12 appears in PR title
        │
        ▼
GitHub webhook
        │
        ▼
Trama detects PR #201
        │
        ▼
Suggest attachment to AUTH-12
```

Reliable states may include:

```text
PR open
CI failing
CI passing
review requested
approved
merged
deployment succeeded
```

These should enrich the Workstream without pretending to represent the entire implementation process.

---

# 50. Source-of-truth boundaries

Trama should have explicit ownership boundaries.

## Trama owns

```text
Issues created in Trama
Workstreams
organizational ownership
Workstream state
decisions
relationships
project context
```

## Delta owns

```text
implementation conversation
turns
worktrees
subagents
bookmarks
implementation history
```

## GitHub/GitLab owns

```text
repository state
PR/MR state
commits
reviews
CI integration state
```

## Deployment systems own

```text
deployment state
release state
environment state
```

Trama connects these sources without pretending to own all of them.

---

# 51. Adoption strategy

Trama should be adoptable incrementally.

A realistic path:

```text
Step 1
Use Trama for Workstreams.

Step 2
Link Issues from the existing tracker.

Step 3
Connect Delta Threads.

Step 4
Connect GitHub/GitLab.

Step 5
Optionally move Issue management into Trama.
```

The product should deliver value before requiring a company-wide migration.

---

# 52. Self-hosting

Self-hosting is a primary requirement.

The long-term minimal stack should remain close to:

```text
Trama
PostgreSQL
```

Trama should not require an infrastructure zoo for a small team.

Avoid introducing systems such as:

```text
Kafka
Redis
ElasticSearch
Temporal
NATS
```

until real scale or product requirements justify them.

Architecture should favor simplicity, maintainability, and understandable operations.

---

# 53. Security

Trama may handle:

- private repository metadata;
- OAuth credentials;
- GitHub/GitLab tokens;
- organization membership;
- integration credentials;
- project data.

Therefore:

- secrets stay server-side;
- integration credentials must not live in browser storage;
- workspace boundaries must be explicit;
- authorization must be enforced server-side;
- webhooks and external payloads are untrusted input;
- auditability matters;
- integrations should use least privilege.

Security is part of the core architecture.

---

# 54. Source-available philosophy

Trama should be genuinely useful when self-hosted.

The self-hosted edition should not intentionally cripple the core Workstream workflow.

Future hosted or commercial offerings may provide convenience, operations, support, or enterprise capabilities, but the central product model should remain valuable in the public project.

The project should encourage:

- external contributions;
- integration adapters;
- self-hosting;
- community discussion;
- transparent architecture;
- transparent roadmap decisions.

---

# 55. What success looks like

Trama succeeds if a developer can open a Workstream and quickly understand:

```text
What are we trying to achieve?

Which Issues led to this work?

Who is involved?

Where is the implementation happening?

What important decisions were made?

Which PRs or artifacts came out of it?

Was the outcome delivered?
```

without:

- searching several Issue threads;
- reading old Slack conversations;
- asking the previous developer for a summary;
- reconstructing everything from Git history.

It also succeeds when another developer can:

```text
Open Workstream
↓
Understand intent
↓
Open shared Delta Thread
↓
Continue implementation
```

with minimal handoff cost.

---

# 56. What failure looks like

Trama fails if developers experience it as:

> another place I need to update.

It also fails if:

- Workstreams become arbitrary folders;
- the domain model becomes too complex for normal teams;
- Trama copies everything from Delta;
- familiar Issue workflows become unnecessarily difficult;
- users cannot identify the source of truth;
- every action requires manual metadata;
- automation claims certainty it does not have;
- the project becomes inseparable from one external provider.

---

# 57. Decision framework for future features

Before adding a feature, ask:

### Does this belong to organizational context or implementation context?

If implementation-only, it probably belongs in Delta.

### Does this information already exist naturally somewhere else?

If yes, prefer linking or integration over manual duplication.

### Does this help explain an outcome?

If yes, it may belong in Trama.

### Will another developer need it without opening Delta?

If yes, Trama may be the right home.

### Is the state observable and reliable?

If no, do not pretend it is automated.

### Does it make a Workstream easier to understand?

If no, question whether it belongs in the core product.

### Does it keep the product compatible with traditional Issue workflows?

If not, the trade-off should be intentional.

---

# 58. Product language

Trama should use terminology consistently.

## Issue

An individual problem, request, task, or unit of demand.

## Workstream

A coordinated effort toward one coherent outcome.

## Workspace

The external shared implementation context associated with a Workstream.

For Delta, this is typically a shared Delta Thread.

## Artifact

A concrete output produced by the Workstream.

## Decision

Durable organizational knowledge extracted from the work.

## Contributor

A person participating in the Workstream.

## Accountable

The person ultimately responsible for ensuring the Workstream reaches its intended outcome.

---

# 59. Recommended hierarchy

```text
Organization / Workspace
│
├── Teams
│
├── Projects
│   │
│   └── Workstreams
│       │
│       ├── Issues
│       ├── Workspace Links
│       ├── Decisions
│       ├── Artifacts
│       ├── Contributors
│       └── Repositories
│
└── Issues
```

Issues can exist without a Workstream.

Workstreams may exist with one or many Issues.

Projects remain optional for smaller efforts.

---

# 60. Near-term product direction

The first meaningful version of Trama should prove the Workstream model.

The core workflow is:

```text
Create Issue
Create Workstream
Group Issues
Link Delta Thread
Add contributors
Link repositories
Record important decisions
Attach or discover PRs
Complete Workstream
```

If this is useful in real team usage, the core thesis is validated.

Only then should Trama aggressively expand into deeper automation, analytics, or additional execution providers.

---

# 61. Near-term non-priorities

These should not distract from proving the core workflow:

- detailed agent telemetry;
- token-usage dashboards;
- agent performance scoring;
- automatic completion percentages;
- copying Delta history;
- complex execution graphs;
- elaborate sprint analytics;
- large automation builders;
- dozens of provider integrations;
- enterprise administration before basic team workflow works.

---

# 62. Long-term opportunity

If Workstreams prove useful, Trama can become a coordination layer across the modern software toolchain.

```text
             Issues
       Jira / Linear / GitHub
               │
               ▼
             NABLA
           Workstream
               │
      ┌────────┼────────┐
      ▼        ▼        ▼
    Delta    Other     Human
             agents     work
      │        │        │
      └────────┼────────┘
               ▼
         GitHub / GitLab
               │
               ▼
              CI
               │
               ▼
          Deployment
```

Trama should not replace every tool in this diagram.

It connects them around the outcome the team is pursuing.

---

# 63. The Trama test

A healthy Workstream should let a new team member answer, within seconds:

```text
What are we trying to achieve?

Which problems are included?

Who is involved?

Where can I continue the work?

What has already been decided?

What has already been produced?

What remains organizationally unfinished?
```

If the Workstream cannot answer those questions, it is missing important context.

If answering them requires copying the entire Delta Thread into Trama, Trama is storing too much.

The product must maintain that balance.

---

# 64. Final product thesis

Software development is moving away from a world where:

```text
one Issue
→ one developer
→ one branch
→ one PR
```

is always the natural shape of work.

Increasingly, teams may operate like:

```text
many Issues
      │
      ▼
coherent outcome
      │
      ▼
shared human + agent workspace
      │
      ├── multiple contributors
      ├── multiple agents
      ├── multiple branches
      └── multiple repositories
      │
      ▼
multiple artifacts
      │
      ▼
one delivered outcome
```

The Issue remains useful.

Git remains useful.

Pull Requests remain useful.

Shared agent workspaces remain useful.

What is missing is the layer that explains how those things relate to the outcome the team is actually trying to achieve.

That layer is Trama.

---

# In one sentence

**Trama connects the Issues a team needs to solve with the shared workspace where humans and agents solve them together, while preserving the decisions and artifacts that explain what was ultimately delivered.**
