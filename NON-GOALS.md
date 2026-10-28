# Non-goals and scope freeze

> **Status: approved direction.** The product owner approved an Issue-first model. This file records scope boundaries; implementation is in progress.

Trama reduces the work required to manage development. Issues stay granular; optional Plans, Human input, and Artifacts preserve context without a second work-tracking entity.

## What Trama will not do

1. **Store execution history.** No transcripts, prompts, turns, tool calls, file-edit lists, subagent trees or agent "activity logs". Link to the tool that ran the work.
2. **Run agents.** Trama coordinates agents; it is not an agent runtime, a coding chat UI or a prompt-management product.
3. **Be a Git host, Git client, code-review UI or CI system.** It reads PR, CI and review state from the providers and links to them.
4. **Be a CRM.** Customer feedback may be linked to issues as a source of demand. Accounts, pipelines, contacts and revenue belong elsewhere.
5. **Be a BI or analytics suite.** No configurable dashboards, agent performance scoring, token-usage leaderboards or velocity analytics. A few factual counts on a project or Issue are fine.
6. **Bill time.** No timesheets, rates, invoices, or time reports. A person may start, stop, and manually add their own timer entries against a project or issue. Those hours stay in Trama and are not sent to LunaGest or anywhere else.
7. **Be a chat or messaging tool.** Comments on work are enough; no channels or DMs.
8. **Be a general wiki or document store.** Only documents that are artifacts or decisions of a piece of work.
9. **Plan sprints.** No cycles, burndown or velocity.
10. **Build automations.** No visual rule or workflow builder.
11. **Invent certainty.** No progress percentages or "agent is 84% done". Show facts.
12. **Require migration.** Trama must stay usable beside an existing tracker; it never forces replacing one.
13. **Grow enterprise administration ahead of need.** SSO, SCIM and audit exports wait for a real customer, after the core workflow is proven.
14. **Host the marketing site.** Landing, blog and brand pages are not product (see the freeze table).

## Scope freeze

Rule from now on: **core** surfaces may evolve; **frozen** surfaces get bug fixes and security fixes only, and a new feature needs a recorded decision (ADR) first; **candidate** surfaces are proposed for removal, or for merging into a core surface, and get no work meanwhile.

| Surface | Verdict | Reason |
|---|---|---|
| Issues, including an optional Goal | Core | The only required unit of work. |
| Plans | Optional | Describe how to solve an Issue, close to implementation time. |
| Human input: Question or Decision | Core | One Issue-level feature; questions unblock work and decisions preserve meaningful choices. |
| Artifacts and Git integrations (GitHub, GitLab, Bitbucket) | Core | Evidence of what work produced. |
| Attention | Core | Surfaces where a person is needed without creating a parallel Issue status. |
| Agent surface: MCP, CLI, skills, scoped tokens | Core | How agents actually reach Trama. Keep the tool set small and task-oriented. |
| Search and command palette | Core | Navigation for a dense tool. |
| Auth, roles, token permissions, SSE live updates | Core | Needed for safe multi-actor use; the permission matrix itself is frozen. |
| Projects, milestones, project updates | Keep, frozen | Optional planning context for Issues; must not grow into a PM suite. A project may bind one LunaGest project. |
| Timer | Core | One running timer per person. No billing and no sync to LunaGest. |
| Teams | Keep, frozen | Ownership context only. |
| Repositories | Keep, frozen | Context for projects and Issues; could become a settings or project tab. |
| My Work | Keep, frozen | Personal entry point; could fold into one inbox with Attention. |
| Views (saved filters) | Keep, frozen | Fine as saved filters; no new layouts. |
| Workstreams, dependency graph, and derived lifecycle | Removed | Duplicate Issue status and a second execution model add administration without helping the work. |
| Customers and customer intake | Keep, frozen | Source of demand linked to issues; stops short of CRM. Remove if unused after the owner reviews adoption. |
| Estimates | Keep, frozen | Optional workspace setting. |
| Outgoing webhooks, PWA and push | Keep, frozen | Integration plumbing; no expansion. |
| Overview | Candidate to merge | A dashboard; fold into the inbox or the project page. |
| Notifications | Candidate to merge | Overlaps Attention; one queue is simpler. |
| Activity feed | Candidate to merge | Better as a tab on an Issue or project than a global page. |
| Timeline | Candidate to remove | Linear-style planning view that duplicates Projects and Views. |
| Statistics (about 4,900 lines) | Candidate to remove | Analytics suite; contradicts the non-goals. Keep at most a handful of factual counts. |
| Built-in assistant and AI actions | Candidate to remove or reduce | Agents already reach Trama through MCP and the CLI; an in-app chat duplicates them. It is optional and off by default. |
| Public product roadmap page | Candidate to remove | Marketing content, not product. |
| Landing, blog, changelog, brand pages inside the app | Candidate to remove | Move to a separate static site; they weigh down the app bundle. |

## Gaps that matter more than any freeze item

These are promised by the vision and not built: **linking or importing issues from existing trackers** (GitHub Issues, Linear, Jira) and **guided onboarding** for a first Issue. Prefer spending effort here over any frozen surface.

## How to change this file

Record product decisions that affect scope, then update this file alongside the first implementation change.
