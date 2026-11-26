# Proposal: workspaces, project guests and personal integrations

> **Status:** draft for discussion. Nothing here is built yet. Where this proposal conflicts with
> [`NON-GOALS.md`](../../NON-GOALS.md), the conflict is called out and needs an explicit decision.

## Summary

Keep the workspace as the owner of people, settings and permissions, but make it disappear when you
don't need it:

1. Every account gets a **personal workspace** automatically.
2. People can be invited to a **whole workspace** (all projects or some) or to **a single project**
   (as a guest). Both create the same kind of membership.
3. A project shared with you shows up under **Shared with me**, and you can **show it in** any of your
   workspaces as a link. The project never moves.
4. Integrations can belong to **a person** or to **a workspace**, with several accounts per provider.
5. **Routing rules** on a project decide which external source (repo, GitLab group, Jira project…)
   sends tasks there, and through which connection.

Trama becomes the place a developer connects all their external tools to, and from which they decide
where each source's work lands, while companies keep a normal workspace with controlled access.

## The two ways people use Trama

**A company** creates a workspace, invites people, and gives each of them access to every project or to
some. Integrations are installed once, at workspace level, and keep working when people leave.

**A developer** works in their personal workspace. They create a project and invite one person (a
client, a freelancer, a PM) to that project only. That person doesn't see anything else in the
workspace.

Both are the same model seen from two different entry points.

## What exists today

- `Account → Workspace → Projects → Tasks`. Everything shared (statuses, labels, roles, integrations,
  API tokens, saved views, time tracking, key counters) is stored on the workspace.
- A membership already has `access?: MemberAccess` with `projects: { all, projectIds }` and
  `includeUnassigned`, and `WorkspaceInvite` carries the same `access`. **Limiting a person to some
  projects is already supported by the data model.**
- `IntegrationConnection` has only `workspaceId`. There is no notion of a personal connection, and no
  way to say "issues from this repo go to that project". A project has a single optional
  `repository` string.
- `ImportCredential` is also per workspace, separate from connections.

## 1. Personal workspace

- Created on sign-up, named after the person, with a reserved, non-transferable flag (`personal: true`).
- It cannot be left or deleted while the account exists. It can be renamed.
- People who only work alone never need to know that workspaces exist: the switcher stays hidden until
  they have a second workspace or a shared project.

## 2. Inviting people: two entry points, one model

| Entry point | Where | What it creates |
| --- | --- | --- |
| **Invite to workspace** | Settings · Members | Membership with a role and access to all projects or a list of them |
| **Invite to project** | Project page · Share | Membership with the `guest` role and `access.projects = [that project]` |

- Inviting someone who is already a guest to another project just adds that project to their
  `access.projects`.
- Promoting a guest to a full member is a role change. Nothing is copied.
- New default roles alongside the existing ones (roles stay fully configurable):
  - **Guest**: sees only the projects in their access list, and can create and update tasks and
    comments there. No workspace settings, no member list beyond the people on their projects.
  - **Organizer / PM**: manages projects, milestones and tasks; no workspace settings or integrations.
    This covers the case where tasks are created by people who aren't developers.
- What a guest sees: their projects, the people on those projects, and the workspace's statuses and
  labels (read-only). They don't see other projects, the member list, integrations, tokens or billing.

### Leaving and ownership

- A project's owner is its workspace, not a person, so nothing leaves with the person who created it.
- Moving a project to another workspace is an explicit **transfer** (owner or admin only). Statuses and
  labels are mapped to the target workspace's, issue keys are kept, guests are carried over.
- An account cannot be deleted while it is the primary owner of a shared workspace (as today with
  `primaryOwnerId`).

### Managing many people

A team of 8 on 15 projects shouldn't mean 120 invitations. Inside a workspace, "access to all
projects" already covers it. For "these 8 people on these 15 projects", a saved access preset
(a role with a project scope) is enough. We don't add teams or groups: a group of people with access to
a set of projects is already what a workspace is.

## 3. Shared with me, and "show in"

The project always lives in exactly one workspace, with that workspace's settings and permissions.
Moving a shared project into someone else's workspace would mean two homes, colliding issue keys and
conflicting permissions, so it's not allowed.

Instead:

- Projects you're a guest on appear in a **Shared with me** section of the sidebar.
- From there you can choose **Show in → <one of your workspaces>**. The project appears in that
  workspace's sidebar with a small "shared" marker. Opening it opens the original project.
- This is a personal placement only. It gives **no access** to anyone else in the workspace you
  placed it in.
- Its tasks appear in your personal views (My tasks, Inbox), because they are yours.
- Cross-project views (workspace Tasks, Board) that include a linked project group by **status type**
  (to do, in progress, done, canceled), which every workspace shares, rather than by status name.

Data: a per-user `project_placements (userId, projectId, workspaceId, position)` table. Nothing is
stored on the project itself.

## 4. Connections: personal and workspace

| | **Personal** | **Workspace** |
| --- | --- | --- |
| Created by | the person | a workspace admin (integrations permission) |
| Examples | personal GitHub, a client's GitLab, a work GitHub login | GitHub App on the org, company Jira |
| Who can use it in rules | its owner, on projects they can write to | anyone in the workspace with permission |
| When the owner leaves | stops | keeps working |
| Good for | freelance, hobby, multiple accounts | teams, sync that must outlive people |

- **Several accounts per provider** are allowed, each with a display name ("GitHub · personal",
  "GitHub · Acme").
- A personal connection used on a shared project **never exposes its token**. Other members see
  "receives from GitHub via Alessandro's connection".
- Removing or revoking a connection puts its rules in a visible error state on the project
  ("reconnect, or switch to a workspace connection"). Nothing stops silently.
- For organizations we prefer an installed app or org webhook over a personal token, so sync doesn't
  depend on one person.

## 5. Routing rules

A rule belongs to a project and says where work from a source goes:

```text
github  acme/shop                 label = bug   → project "Acme · Shop"   via GitHub · Acme (workspace)
gitlab  client-group/*                          → project "Client X"      via GitLab · client (personal)
jira    CORE                                    → project "Work"          via Jira · company (workspace)
```

- **Source:** provider, host, and a repository, group or tracker project; optional filters (labels,
  milestone).
- **Direction:** inbound only, or two-way (closing the task closes the external issue, and the other
  way round).
- **Connection:** which connection the rule reads through. When both a personal and a workspace
  connection can see the source, the UI suggests the workspace one.
- **One source, one destination.** A source is identified by provider + host + full path, regardless of
  which connection reaches it. A second rule for the same source (with overlapping filters) is
  rejected, otherwise tasks would arrive twice.
- **Guests and rules:** a guest can add a rule to a shared project only if their role allows creating
  tasks there, so nobody can flood someone else's project.
- Artifacts (PRs, commits, CI) keep matching tasks by key as today; a rule additionally tells an
  unmatched PR or issue which project it belongs to.

## 6. External identities

With several GitHub or GitLab accounts, all of them must count as the same person: assigned issues,
requested reviews and activity. An account keeps a list of **external identities**
(`provider, host, login`), filled in automatically when a personal connection is added and editable by
hand. Assignee mapping, Inbox and My tasks use it.

## Data model changes

| Change | Notes |
| --- | --- |
| `workspaces.personal boolean` | One per user, created on sign-up and backfilled for existing users |
| `guest` and `organizer` default roles | Added to `resolveWorkspaceSettings` defaults; existing roles untouched |
| `project_placements` | Per-user "show in" links |
| `integration_connections.ownerType` (`workspace` \| `user`), `ownerUserId`, `label` | `workspaceId` becomes nullable for personal connections |
| `routing_rules` | `projectId`, `connectionId`, `provider`, `host`, `sourcePath`, `filters jsonb`, `direction`, unique on the normalized source |
| `external_identities` | `userId`, `provider`, `host`, `login`, unique on (`provider`, `host`, `login`) |
| `ImportCredential` | Folded into connections over time, so imports and sync share one credential list |

Contracts change in `contracts/domain.ts` (`IntegrationConnection`, new `RoutingRule`,
`ExternalIdentity`, `ProjectPlacement`) and are synced with the existing tooling.

## Migration

- Existing connections become workspace connections. Nothing breaks.
- A project with a `repository` string gets an inbound rule for that repository through the
  workspace's matching connection, if there is one. The `repository` field stays readable for older
  clients until it's removed.
- Every existing user gets a personal workspace. Their current workspaces are untouched.
- Existing `access.projects` memberships keep working as they are; they simply show up as guests or
  limited members in the new UI.

## Screens

- **Account · Integrations** (new): personal connections, several per provider, and external
  identities.
- **Settings · Integrations** (existing): workspace connections only.
- **Project · Sources** (new tab or rail section): the project's routing rules, the connection each
  uses, its health, and "Add source".
- **Project · Share**: invite to this project, list of guests, access level.
- **Sidebar**: Shared with me, plus a "shared" marker on placed projects; the workspace switcher only
  when there is more than one workspace.

## Order of work

Each step ships on its own.

1. **Project guests.** Guest role, "Invite to project", guest view of the app. Builds on
   `MemberAccess` and invites, which already exist.
2. **Personal workspace** and **Shared with me / Show in**.
3. **Connection ownership**: personal connections, several per provider, labels.
4. **Routing rules** and the Sources UI, with migration from `project.repository`.
5. **External identities** in assignment, Inbox and My tasks.
6. **Two-way sync** per rule.

## Conflicts with NON-GOALS

- **#15, "no repository registry. A project has one optional `repository` string."** Routing rules are
  a list of sources per project, which is close to a registry. The argument for it: it is per project,
  not a workspace-wide catalogue, and it replaces manual entry with integrations
  (`VISION.md` principle 4, "Automation over administration"). Needs an explicit decision, and an
  update to `NON-GOALS.md` if accepted.
- **"No teams"** is kept: this proposal deliberately adds no groups or teams.

## Open questions

1. Are project guests mostly external (clients, freelancers) or colleagues? This decides how much of
   the workspace a guest should see by default.
2. Do we need one view of tasks across workspaces ("all my tasks everywhere"), or is per-workspace
   My tasks enough with Shared with me?
3. Billing, if any: per workspace, per seat, and do guests count?
4. Should two-way sync be on by default for a new rule, or opt-in?
