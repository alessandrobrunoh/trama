# North (Linear clone) — Angular rebuild task list

Source of truth: the React/TanStack Start app in `../src`. This file is a complete feature inventory so the
rebuild can be done without reading the React code. Paths in `code` are original source files for extra detail.
Visual styling for the rebuild comes from `DESIGN.md` (Delta style); this file covers behaviour only.

Target: **Angular 22, client-only SPA, all data in `localStorage`, no backend.**

---

## 1. Overview

- [ ] App name **North**, workspace name **Aperture**, current user `u_alessandro` (Alessandro Ricci). Constants in `src/lib/meta.ts`.
- [ ] Keyboard-first, Linear-style issue tracker: issues (list + board), projects, cycles, teams, saved views, inbox, roadmaps, settings, Git sync, AI copilot, link attachments.
- [ ] Desktop: left sidebar + top bar + main outlet. Mobile (<768px): drawer sidebar, bottom tab bar, issue detail as full-screen right drawer.
- [ ] Theme: dark (default) / light / system; persisted.

### Routes

| URL | Page | Notes |
|---|---|---|
| `/` | redirect → `/issues` | |
| `/issues` | Issue list/board for the **active team** | Title: `"<Team name> · Issues"` |
| `/issues/:issueId` | Issue list + issue detail side panel | `:issueId` is the identifier (`ENG-142`, case-insensitive) or the internal id |
| `/my-issues` | My issues (sections) | |
| `/inbox` | Inbox notifications | |
| `/projects` | Project list | |
| `/projects/:projectId` | Project detail (tabs) | `:projectId` = internal id (`p_auth`) |
| `/cycles` | Cycle list for the active team | |
| `/cycles/:cycleId` | Cycle detail (grouped by status) | `cyc_32` |
| `/teams` | Teams index | Not in sidebar; reachable via `G T` |
| `/teams/:teamId` | Team detail (tabs) | `t_eng` |
| `/views` | Saved views list | |
| `/views/:viewId` | Saved view → issue list across all teams | |
| `/roadmaps` | Project timeline cards | |
| `/settings` | Settings (section nav) | |
| `/git` | Git forge connections + repo sync | |

- [ ] Unknown issue / project / cycle / team / view ids show an empty state ("Issue not found — It may have been deleted.", "Project not found", etc.).

---

## 2. Data model (`src/types/domain.ts`)

Persist the whole DB as one JSON object under localStorage key `north.db.v2` (`AppDatabase`, `version: 2`). On first load
(or parse failure) create the seed; keep an in-memory copy and write it back after every mutation; swallow quota errors.

### Enums
- `IssueStatus`: `backlog | todo | in_progress | in_review | done | canceled` (labels: Backlog, Todo, In Progress, In Review, Done, Canceled; sort order is that list).
- `IssuePriority`: `none | urgent | high | medium | low` (labels Urgent, High, Medium, Low, "No priority"; rank urgent=0 … none=4; menu order urgent, high, medium, low, none).
- `ProjectStatus`: `planned | in_progress | completed | canceled`.
- `RelationType`: `blocks | blocked_by | related | duplicate` (inverse: blocks↔blocked_by, related↔related, duplicate↔duplicate; label for duplicate = "Duplicate of").
- `InboxKind`: `assignment | mention | comment | project | system`.
- `Density`: `compact | default | comfortable` (row heights 28/32/36px). `BoardOrList`: `list | board`.
- `SortField`: `priority | status | createdAt | updatedAt | dueDate | estimate | assignee | identifier`.
- `FilterField`: `status | priority | assignee | project | cycle | label | team`; `FilterOperator`: `equals | not_equals | contains`.
- Estimate options: `1, 2, 3, 5, 8, 13`.

### Entities (fields)
- **User**: id, name, email, avatarHue (0–360, avatar bg `hsl(h 32% 38%)` + initials), role.
- **Team**: id, name, identifier (issue prefix), icon (`cpu|pen|compass`), color, defaultStatus, defaultPriority.
- **Label**: id, name, color (hex), teamId?.
- **Project**: id, name, description?, status, leadId?, memberIds[], teamIds[], startDate?, targetDate?, progress (stored 0–100, NOT computed), iconHue.
- **Cycle**: id, name (`Cycle N`), number, teamId, startsAt, endsAt, issueIds[] (kept in sync with issue.cycleId).
- **Issue**: id, identifier (`ENG-142`), number, title, description? (markdown-ish text), status, priority, teamId, projectId?, cycleId?, assigneeId?, labelIds[], estimate?, createdAt, updatedAt, dueDate?, parentIssueId?, subIssueIds[], commentsCount, linksCount, rank.
- **Comment**: id, issueId, authorId, body, createdAt, updatedAt.
- **Activity**: id, issueId, actorId, createdAt, kind (`created|status|priority|assignee|label_added|label_removed|project|cycle|title|comment|link|ai`), from?, to?.
- **IssueRelation**: id, fromIssueId, toIssueId, type.
- **IssueLink**: id, issueId, url, title, kind (`ai_session|git_pr|git_mr|git_issue|git_commit|design|docs|generic`), provider (xai, openai, anthropic, google, groq, mistral, cursor, chatgpt, claude, grok, delta, github, gitlab, figma, notion, linear, perplexity, other), subtitle?, createdAt, createdById, gitState?, gitNumber?, threadId?.
- **InboxItem**: id, kind, title, body, issueId?, projectId?, actorId?, createdAt, read.
- **SavedView**: id, name, teamId?, filters[] (`{id, field, operator, value}`), sortField, sortDirection, layout.
- **GitConnection**: id, forge (`github|gitlab`), name, baseUrl (API), webUrl, token?, username?, connected, lastSyncAt?, lastError?, lastSyncSummary?.
- **GitRepository**: id, connectionId, externalId, fullName, url, defaultBranch, teamId?, projectId?, enabled.
- **AiProviderConnection**: id, provider (`xai|openai|anthropic|google|groq|mistral|openai_compatible`), name, enabled, apiKey?, baseUrl?, model, usesPlatformKey?.
- **AiThread**: id, issueId?, providerId, title, createdAt, updatedAt, messages[] (`{id, role: user|assistant|system, content, createdAt}`), attachedAsLinkId?.
- **AppDatabase**: version, currentUserId, users, teams, labels, projects, cycles, issues, comments, activities, relations, inbox, views, links, gitConnections, gitRepositories, aiProviders, aiThreads.

### Seed data (`src/mock/seed.ts` — copy the arrays verbatim)
- [ ] **5 users** (emails `@aperture.dev`): Alessandro Ricci (Engineering, current user), Marco Bianchi (Engineering), Giulia Conti (Design), Andrea Rossi (Product), Elena Vargas (Engineering).
- [ ] **3 teams**: Engineering `ENG` (`t_eng`, cpu, default todo), Design `DES` (`t_des`, pen, default todo), Product `PRO` (`t_pro`, compass, default backlog). All default priority none.
- [ ] **10 labels** (workspace-wide): Bug, Feature, Improvement, Documentation, Security, Performance, Design, Backend, Frontend, Infra (ids `l_bug`… with fixed hex colours).
- [ ] **5 projects**: Authentication Platform (`p_auth`, in progress, 64%), Workspace Experience (`p_dash`, in progress, 42%), Notification Center (`p_notify`, planned, 18%), Mobile Shell (`p_mobile`, in progress, 35%), Observability (`p_obs`, planned, 12%) — each with lead, members, teams, start/target dates.
- [ ] **8 cycles**: Cycle 25–32, all Engineering, 14 days each, back-to-back; Cycle 32 is the current one.
- [ ] **61 issues**: 52 hand-written rows (ENG-107…109, ENG-110…145, DES-12…18, PRO-06…11) + 9 generated ENG-92…100. Status mix ≈ 16 todo / 11 done / 10 in progress / 8 backlog / 6 in review / 1 canceled (hand-written). ENG-142 "Implement OAuth authentication" is the showcase issue with sub-issues ENG-143/144/145.
- [ ] **5 comments** (ENG-142 ×2, ENG-139, ENG-141, ENG-130), **6 activities** (mostly ENG-142), **3 relations** (ENG-130 blocks ENG-142; ENG-142 related ENG-120; ENG-139 related DES-16).
- [ ] **5 inbox items** (2 unread: mention on ENG-142, assignment of ENG-139; read: comment, project progress, "Cycle 32 started").
- [ ] **4 saved views**: My Bugs (label=Bug AND status≠done, sort priority asc), High Priority (priority=high, updated desc), Unassigned (assignee=`__none__`, created desc), Recently Updated (no filters, updated desc).
- [ ] **9 links** (GitHub PR #88, Claude/Grok/Delta sessions on ENG-142; GitHub issue #41 + Cursor agent on ENG-107; GitLab MR !204 on ENG-141; ChatGPT on ENG-139; Figma on DES-18).
- [ ] **1 AI provider**: default xAI Grok (`ai_xai`, model `grok-4.5`, usesPlatformKey). No git connections, no AI threads.
- [ ] Seed timestamps are relative to a fixed `now = 2026-09-08T08:00Z`. **Rebuild: compute relative to `Date.now()` at seed time** so "current cycle", due dates and relative times stay meaningful.
- [ ] Derived on seed: parent.subIssueIds, cycle.issueIds, issue.commentsCount, issue.linksCount; rank strings from index.

### Repository behaviours (port as Angular services; `src/lib/repo/*`)
- [ ] `createIssue`: identifier = team prefix + (max number in team + 1); status/priority fall back to team defaults; push into parent.subIssueIds and cycle.issueIds; prepend; log `created` activity.
- [ ] `updateIssue`: log activity per changed field — title, status (from/to labels), priority, project, cycle (also move between cycle.issueIds), assignee, label_added/label_removed per label (label names); estimate, dueDate, rank, teamId, description, parent change silently (maintaining parent.subIssueIds). Always bump updatedAt. `null` clears an optional field.
- [ ] `deleteIssue`: detach from parent, orphan sub-issues, cascade-delete comments, activities, relations, inbox items, links, AI threads; remove from cycles.
- [ ] `createComment`: increments commentsCount, bumps issue.updatedAt, logs `comment` activity (first 80 chars); parses `@word` mentions, matching user **first name** (case-insensitive); for each matched user ≠ current user, prepend an unread `mention` inbox item ("<me> mentioned you").
- [ ] `deleteComment` decrements commentsCount. (`updateComment` exists but no UI.)
- [ ] Labels: create / delete (delete strips from all issues). Projects: create (progress 0, random iconHue, members default [lead]), delete clears issue.projectId. Cycles: create (number = max in team + 1). Teams: update defaults. Views: create / delete (no delete UI). Inbox: mark read / mark all read. Profile: update name/email. Workspace reset → re-seed.

---

## 3. Layout, sidebar, top bar (`components/layout/*`)

- [ ] App shell: sidebar (desktop) | column(top bar, main outlet, mobile bottom nav). Mount global modals once: create issue/project/cycle, command palette, search, shortcuts, confirm-delete, toasts.
- [ ] Sidebar header: square "N" logo + "Aperture / Workspace".
- [ ] Sidebar width 220px; collapsed 48px (icons only, labels in right-side tooltips; section headings hidden; Views section hidden).
- [ ] Section **Workspace**: Inbox (unread count badge), My issues, Views, Projects, Cycles, Roadmaps, Git. Active state via path prefix.
- [ ] Section **Team**: one item per team (team icon) → sets active team and navigates to `/issues`; active when on `/issues` and team is active.
- [ ] Section **Views**: one item per saved view → `/views/:id`.
- [ ] Footer: Settings link, Help button (opens shortcuts modal), current user avatar + name → `/settings`.
- [ ] Clicking any sidebar item closes the mobile drawer.
- [ ] Top bar (44px): mobile hamburger (opens drawer sidebar), desktop sidebar toggle, breadcrumb `<Active team name> / <Section>` (Inbox, My issues, Projects, Cycles, Views, Settings, Teams, Roadmaps, Git, else Issues), "Search ⌘K" button (opens command palette, ≥sm), search icon on mobile (opens search modal), avatar → `/settings`.
- [ ] Mobile bottom nav (<768px): Issues, Inbox, Projects, Cycles, Settings, with safe-area padding.
- [ ] Persist UI state under `north.ui.v1`: sidebarCollapsed, theme, activeTeamId (default `t_eng`). Apply theme class before first paint (inline script reading localStorage) to avoid flash.
- [ ] Toast notifications (success/error/info) for almost every mutation (see per-feature).
- [ ] Shared components: Avatar (xs/sm/md, dashed empty circle when unassigned), StatusIcon (dashed circle, circle, dot, half, check, x — colour per status), PriorityIcon (alert / signal-high/medium/low / minus), LabelBadge (dot + name on 18% tinted bg), EmptyState (title, description, optional action), LoadingRows skeleton, RichText.
- [ ] RichText renderer (comments, AI messages): `**bold**`, `*italic*`, `` `code` ``, `@mention` chips, auto-linked `http(s)` URLs (new tab), newlines → `<br>`. No full markdown.

## 4. Command palette (⌘K) and search (`/`)

- [ ] **Command palette** (dialog, fuzzy filter input "Search commands and issues…", "No results"):
  - Navigation: All issues (G I), Go to projects (G P), Go to cycles (G C), Inbox (G N), My issues (G M), Open settings (G S), Git sync (G R) — show shortcut hints.
  - Actions: Create issue (C), AI providers (→ /settings), Search issues (/) → opens search modal, Create project, Toggle sidebar (⌘B), Toggle theme (⌘J; sun/moon icon by current theme).
  - Issues: first 8 issues (`identifier title`, searchable) → open issue.
  - Projects: all → project detail. Teams: all → set active team + go to /issues.
  - ⌘K toggles open/closed; selecting an item closes it.
- [ ] **Search modal** ("Search issues, projects, people…", custom filtering, case-insensitive substring):
  - Issues (title/identifier/description, max 8) → issue detail; Projects (name, max 5) → project; People (name, max 5) → `/my-issues` (quirk: not filtered by that person); Labels (max 5) → just closes.
  - Empty query shows the first N of each group. Groups hidden when empty. Query resets on close.

## 5. Keyboard shortcuts (`hooks/use-keyboard.ts`, `modals/shortcuts-modal.tsx`)

Global `keydown` listener. "Typing" = focus in input/textarea/select/contenteditable/`[role=textbox]`.
- [ ] `Esc` — close open modal; otherwise if on `/issues/:id`, go back to `/issues`.
- [ ] `⌘/Ctrl+K` — toggle command palette (works while typing).
- [ ] `⌘/Ctrl+B` — toggle sidebar collapse (works while typing).
- [ ] `⌘/Ctrl+J` — toggle dark/light theme (works while typing).
- [ ] (not typing) `/` — open search modal.
- [ ] `?` — open keyboard shortcuts modal.
- [ ] `C` or `N` — open create-issue modal.
- [ ] `G` then (within 800ms): `I` /issues, `P` /projects, `C` /cycles, `N` /inbox, `M` /my-issues, `S` /settings, `V` /views, `T` /teams, `R` /git.
- [ ] List navigation (operates on rendered rows `[data-issue-id]` in DOM order): `↓`/`j` focus next, `↑`/`k` focus previous (scroll into view), `Enter` or `e` open focused issue, `Space` toggle selection of focused, `Delete`/`Backspace` with selection → confirm "Delete N issue(s)?" then delete all and clear selection.
- [ ] In create-issue modal: `Enter` in title submits, `⌘Enter` submits from anywhere in the modal. In AI panel: `⌘Enter` sends.
- [ ] **Shortcuts modal** (two-column groups): General — Open command palette ⌘K, Search /, Toggle sidebar ⌘B, Toggle theme ⌘J, Keyboard shortcuts ?, Close Esc. Go to — Issues G I, Projects G P, Cycles G C, Inbox G N, My issues G M, Settings G S, Git G R. Issues — Create issue C, Open focused Enter, Select Space, Move selection ↑ ↓, Edit focused E, Delete selected Del. (Add G V / G T to the modal in the rebuild — they work but are undocumented.)

## 6. Create modals (`components/modals/*`)

- [ ] **Create issue** ("New issue — Create a compact issue. Press ⌘Enter to save."):
  - Title input (autofocus), description textarea, "Draft with AI" button (see §13), property row: Team `<select>` (identifiers), Status, Priority, Assignee, Project, Cycle (only cycles of the selected team), Labels (multi), Estimate pickers.
  - Opening accepts defaults (`teamId, status, priority, assigneeId, projectId, cycleId, labelIds, estimate, description, parentIssueId`); fields reset on every open. Defaults: active team, status `todo`, priority `none`.
  - Submit disabled until title non-empty; on success toast "Issue created", close, navigate to the new issue. Error toast "Could not create issue".
- [ ] **Create project**: name (autofocus), description, team `<select>`, lead `<select>` (defaults first user). Creates with `teamIds:[team]`; toast "Project created"; navigate to project.
- [ ] **Create cycle**: team `<select>`, start date (today) and end date (+14 days) inputs. Toast "Cycle created"; navigate to cycle.
- [ ] **Confirm delete** (alert dialog): dynamic title/description, Cancel / Delete; runs callback, toasts "Deleted".

## 7. Issue list (`issues/issue-list.tsx`, `issue-row.tsx`)

- [ ] Data pipeline: all issues → scope (team unless `teamId="all"`; optional project/cycle/assignee scope) → toolbar filters (AND) → (unused free-text query) → sort (+ tie-break by identifier). Flat list — **no grouping** in the original list view (grouping by status exists only on board and cycle detail).
- [ ] Empty state "No issues": description "Try changing your filters." if scope non-empty else "Create your first issue to get started."; action "Create issue".
- [ ] Row (height by density, bottom border; selected = accent tint; focused = hover bg; canceled rows 60% opacity; done/canceled titles muted + strikethrough). Left→right:
  - checkbox (toggle selection), identifier (mono, if visible), status picker (icon only, if visible), title (truncate), up to 2 label badges (if visible, ≥md), comment count icon (if >0), link count paperclip (if >0), project name (if visible, ≥lg), cycle name (if visible, ≥xl), estimate (if visible), due date short format (Today/Yesterday/Tomorrow/`MMM d`, if visible), priority picker (icon) or static icon, assignee picker (avatar) or static avatar, trailing "…" button (hover-visible; opens issue).
  - Inline pickers must not trigger row navigation.
- [ ] Row click → set focused + open `/issues/:identifier`. `Shift+click` → range select from last selected. `⌘/Ctrl+click` → toggle select.
- [ ] Right-click **context menu** (fine pointer): Open; Status ▸ (all statuses); Priority ▸ (all priorities); Assign to me; — ; Delete (danger, confirm, then navigate to /issues).
- [ ] Touch devices (coarse pointer): no context menu; trailing "…" dropdown with Open / Assign to me / Delete.
- [ ] **Swipe row** (coarse pointer only): drag right >72px (or fast flick) → mark done + toast "`ENG-x` marked done"; drag left >96px (or fast flick) → delete with confirm; partial left drag (>48px) snaps open a red "Delete" action (88px) — tap it to delete, tap row to close. Green "Done" and red "Delete" backgrounds revealed underneath. Vertical scroll still works.
- [ ] **Bulk bar** (shown when ≥1 selected): "N selected", set status (backlog / todo / in progress / in review), Assign to me, priority urgent / high, Delete (confirm "Delete N issues?"), Clear. Bulk apply → toast "Issues updated" and clear selection.
- [ ] Selection, focus and last-selected id are global UI state (not persisted).

## 8. Issue board (`issues/issue-board.tsx`)

- [ ] Columns per status in order backlog, todo, in progress, in review, done; canceled column only if it has issues. Column header: colour dot, label, count. Columns 256px, horizontal scroll.
- [ ] Card: identifier (mono), title (2-line clamp), priority icon, first label badge, assignee avatar (right). Click → open issue.
- [ ] Drag-and-drop (mouse: 8px distance threshold; touch: 220ms long-press): drop on a column or on a card in another column → update status. Drag overlay shows identifier + title. Highlight column on hover. Order within a column is NOT persisted (optional improvement: persist `rank`).

## 9. Issue toolbar (`issues/issue-toolbar.tsx`)

- [ ] Left: title + issue count. Middle: filter pills + "Filter" button. Right: Sort, Display, List/Board segmented toggle (≥sm), "New issue" button, "Save view" (only when filters exist).
- [ ] **Filter**: popover listing fields Status, Priority, Assignee, Project, Cycle, Label, Team → adds a filter with default value (status=in_progress, priority=high, assignee=`__none__`, else empty); "Clear filters" when any.
- [ ] **Filter pill**: `Field = value` / `Field ≠ value`, click to edit (toggle "is" / "is not", choose value from list), × to remove. Options: status list, priority list, assignee ("Unassigned" + users), label list, project list. (Cycle/Team have no option list in the original — add them in the rebuild.)
- [ ] Filter semantics: assignee `__none__` = unassigned; label = issue has label (not_equals = lacks); `contains` = case-insensitive substring; equals/not_equals exact.
- [ ] **Sort** menu: Priority, Status, Created, Updated, Due date, Estimate, Assignee, Identifier; current shows direction. Re-selecting same field flips direction; new field defaults asc for priority/status, desc otherwise. Missing due date/estimate/assignee sort last.
- [ ] **Display** menu: Density (Compact / Default / Comfortable), View (List / Board), Properties checkboxes: Priority, Assignee, Labels, Project, Cycle, Estimate, Due date, Status, ID. Defaults: priority, assignee, labels, project, status, identifier on; cycle, estimate, dueDate off.
- [ ] **Save view**: prompt for a name, saves current filters + sort + layout; toast "View saved". (Original uses `window.prompt` — use a small dialog.)
- [ ] Persist display prefs under `north.display.v1`: density, layout, sortField (default updatedAt), sortDirection (desc), visible properties. Filters are session-only and **global** (shared across all list instances).

## 10. Property menus (`issues/property-menus.tsx`)

Reusable dropdown pickers used in rows, create modal and issue detail sidebar; `compact` mode = icon only.
- [ ] **Status**: icon + label; menu of all 6 statuses.
- [ ] **Priority**: icon + label ("Priority" when none); menu urgent→none.
- [ ] **Assignee**: avatar + first name ("Assignee" when empty); "No assignee", separator, users with avatars.
- [ ] **Labels** (multi-select, menu stays open on toggle): tag icon + up to 2 badges + "+N"; each item shows colour dot and "On" marker.
- [ ] **Project**: name or "Project"; "No project", projects with hue square and status label.
- [ ] **Cycle**: name or "Cycle"; "No cycle" + cycles (filtered to the issue's team by callers).
- [ ] **Estimate**: value or "Estimate"; None, 1, 2, 3, 5, 8, 13.
- [ ] **Due date**: calendar icon + `YYYY-MM-DD` or "Due date"; native date input; clearing sets null.

## 11. Issue detail (`issues/issue-detail.tsx`, route `issues/$issueId.tsx`)

- [ ] Desktop: right side panel (≈min(640px, 52%)) next to the list, slide-in animation. Mobile: list hidden, detail shown in full-width right drawer; closing navigates to `/issues`.
- [ ] Loading text, "Issue not found" empty state.
- [ ] Header: identifier, team name, "Ask AI" toggle (opens AI drawer), previous/next arrows (navigate through same-team top-level issues in storage order; disabled at ends), close ×.
- [ ] Title: inline input, saved on blur if changed and non-empty (toast "Issue updated" — all property patches toast this).
- [ ] Description: borderless auto textarea "Add description…", saved on blur if changed. (Plain text; optional: render RichText when not editing.)
- [ ] **Sub-issues** section: header "Sub-issues · X / N completed"; rows (identifier, title, status label) → navigate; inline "Add sub-issue" input creates issue in same team + project with parent set (toast "Sub-issue created").
- [ ] **Links** section (§18): "Links · N", "Attach" toggle; helper text when empty; link cards; URL input + Add.
- [ ] **Relations** section: list "Blocks / Blocked by / Related / Duplicate of" (inverse when this issue is the target) + identifier + title; "No relations"; "+ Add" opens a search box (title substring, max 6 results) → adds a `related` relation. (Rebuild: also allow choosing type and removing.)
- [ ] **Activity** feed (newest first): avatar, actor first name, sentence, relative time. Copy: created the issue; changed status from X → Y; changed priority from X → Y; assigned / unassigned the issue; added label "X"; removed label "X"; moved project; moved cycle; renamed the issue; commented; attached <title>; ran an AI action.
- [ ] **Comments** (oldest first): avatar, name, relative time, hover "Delete", RichText body. Composer textarea "Write a comment… use @Name to mention" + Comment button (toast "Comment added").
- [ ] **Properties sidebar** (right on lg, below on smaller): Status, Priority, Assignee, Labels, Project, Cycle (team's cycles), Estimate, Due.
- [ ] "Push to <repo>" button when any Git repo is enabled (external — §17).
- [ ] Relative time format: "just now" (<45s), else "N minutes ago" style.

## 12. My issues, Inbox

- [ ] **My issues** (`/my-issues`, header "My issues"): issues assigned to current user, in sections with counts — Today (due today and not done/canceled, plus all in progress/in review), Upcoming (has due date, not today, not done/canceled), Backlog (no due date, backlog/todo), Completed (done, max 12). Row: status icon, identifier, title → open. "Nothing here" per empty section. Empty state "No issues assigned" with "Create issue" (prefills assignee = me).
- [ ] **Inbox** (`/inbox`): header + "Mark all read". Items newest first: actor avatar, title, unread dot, body (1 line), relative time; unread rows tinted. Click → mark read and open the issue (by identifier) or the project. Empty state "Inbox zero". Sidebar badge = unread count.

## 13. AI (external — optional) (`issues/ai-panel.tsx`, `lib/ai/*`, `settings/ai-settings.tsx`)

Original: server function proxies chat calls (xAI uses a server-side `XAI_API_KEY`; others use the user's key passed through). Client-only rebuild: call providers directly from the browser with a user-supplied key stored in localStorage (OpenAI-compatible, Anthropic with `anthropic-dangerous-direct-browser-access: true`, Gemini `?key=`), and/or an **offline stub provider** that returns canned, clearly labelled responses so the UI is demoable without a key. Drop the "platform key" concept for xAI (treat xAI as a normal key-based OpenAI-compatible provider).
- [ ] Provider catalog: xAI Grok (`https://api.x.ai/v1`, grok-4.5), OpenAI (gpt-4.1), Anthropic (claude-sonnet-4-5), Google Gemini (gemini-2.0-flash), Groq (llama-3.3-70b-versatile), Mistral (mistral-large-latest), OpenAI-compatible (Ollama default `http://localhost:11434/v1`). Each has hint text, default model/base URL, model list, docs URL. Request: max 16 non-system messages + 1 system, max tokens clamped 64–1600, temperature 0.3.
- [ ] Default provider = first enabled xAI, else first enabled.
- [ ] **AI settings** (Settings → AI): provider cards with name, hint, enabled switch, API key (password, masked `abcd••••wxyz` when saved), model, base URL (OpenAI / Groq / Mistral / compatible), Save, Test (sends "Reply with the single word pong." → toast "Provider responded" or error), Remove (not for xAI: "Grok stays available as the default"). "Add a provider" buttons for catalog entries not yet added (OpenAI-compatible can be added repeatedly).
- [ ] **Issue AI panel** (right drawer from "Ask AI"): provider `<select>` (disabled ones marked "(off)"); action buttons:
  - Summarize → 4–6 bullet summary appended to thread.
  - Draft → asks for JSON `{title, description, priority, labels}`; applies title/description/priority to the issue (toast "Description drafted").
  - Sub-issues → JSON array of 3–6 titles; creates up to 6 sub-issues (toast "Created N sub-issues").
  - Labels → JSON `{priority, labels[], reason}` restricted to existing label names; applies (toast = reason).
  - Free chat textarea "Ask about this issue…" (⌘Enter / Send), with a system prompt containing issue context (identifier, title, status, priority, labels, description).
  - Messages shown as "You" / provider name with RichText; "Thinking…" while busy.
  - Threads persisted per issue (`aiThreads`); thread title becomes `<identifier> · <provider>` on first message.
  - "Attach session" → adds a link `north://session/<threadId>` (kind ai_session) to the issue.
  - JSON parsing tolerant of ``` fences and leading text.
- [ ] **Draft with AI** in create-issue modal: sends title+description, fills title/description/priority from JSON.
- [ ] Missing key / provider → toast "Connect a provider in Settings → AI" (or provider-specific error).

## 14. Projects, Roadmaps

- [ ] **Project list**: header + "New project". Rows: hue square, name, "<Status> · N issues", progress bar + % (≥sm), target date (≥md), lead avatar → detail. Empty state with create action.
- [ ] **Project detail**: header (hue square, name, "Status · progress% · Target date · Lead name"). Tabs:
  - Overview: description, progress bar, stats cards Total / Completed (done) / In progress (in progress + in review) / Backlog (backlog + todo).
  - Issues: full issue list view scoped to the project across all teams (with toolbar).
  - Cycles: up to 8 cycles of the project's teams, name + date range → cycle detail.
  - Members: avatar, name, role per member; "Teams: …".
  - Activity: placeholder text "Recent issue updates in this project appear on each issue. N issues tracked." (Rebuild may aggregate activities of project issues.)
- [ ] **Roadmaps**: projects sorted by target date; card with hue square, name, status, progress bar, start / target (or "No start" / "No target") → project.

## 15. Cycles, Teams, Views

- [ ] **Cycle list** (active team only, newest number first): name + "Current" badge when now ∈ [start, end], "<Team> · <Mmm d – d>", progress bar done/total and "X / N". "New cycle" button; empty state.
- [ ] **Cycle detail**: name, date range, "X / N issues completed", progress bar; sections for Todo, In Progress, In Review (hidden when empty), Done — each with status icon + count and rows (identifier, title → open); "None" when empty. (Backlog/canceled issues in a cycle are not shown — fix optional.)
- [ ] **Teams index**: team name + identifier rows; click sets active team and opens detail.
- [ ] **Team detail**: header name + identifier; tabs Issues (issue list scoped to team), Projects (projects including team), Cycles (up to 8), Members (all users — original doesn't filter; name · email), Settings (shows default status/priority, "Set as active team" button).
- [ ] **Views index**: rows name + "N filter(s)"; empty state "No saved views — Filter issues and choose Save view."
- [ ] **View detail**: loads view, **replaces** global filters/sort/layout with the view's, renders issue list across all teams titled with the view name. (Add a delete-view action in the rebuild.)

## 16. Settings (`settings/settings-page.tsx`)

- [ ] Left nav (select dropdown on mobile); default section **Appearance**. Sections:
  - General: "Workspace name is Aperture. Data lives on this device." + "Reset demo data" (re-seed, toast "Demo data reset").
  - Profile: name + email inputs, Save (toast "Profile updated").
  - Appearance: Dark / Light / System buttons (System follows OS `prefers-color-scheme`).
  - Notifications: switches Assignments (on), Mentions (on), Daily digest (off) — local state only in original; persist in rebuild.
  - AI: §13.
  - Git: explanation + "Open Git" → `/git`.
  - Teams: per team, default status and default priority selects (saved immediately).
  - Labels: list (colour dot, name, Delete) + add form (name, colour picker default `#6b93e8`, Add). Toasts created/deleted.
  - Keyboard shortcuts: "Press ? anywhere…" + "Open shortcuts".

## 17. Git page (external — optional) (`git/git-page.tsx`, `hooks/use-integrations.ts`, `lib/git/proxy.ts`)

Original: server-side proxy to GitHub / GitLab REST (whoami, listRepos, listIssues, listPulls, createIssue) with a personal access token. Client-only rebuild: GitHub and gitlab.com REST APIs allow CORS with a token, so calls can go **directly from the browser** (token kept in localStorage, warn the user); self-hosted GitLab may fail on CORS — show the error. Alternatively ship a clearly labelled mock forge.
- [ ] Header "Git" + "Sync now" (disabled until a repo is enabled; spinner while running; toast "Imported X, linked Y").
- [ ] Intro copy; three connect cards: GitHub (api.github.com), GitLab.com (`/api/v4`), GitLab self-hosted (instance URL field). Card shows "Connected as <user> · <masked token>" or "Not connected", token input (placeholders `ghp_…` / `glpat-…`), scope hint, Connect/Reconnect, Disconnect (removes connection + its repos).
- [ ] Connect: verify identity (whoami), store connection, list repos (GitHub: 50 most recently updated; GitLab: membership) → stored disabled.
- [ ] Repositories table: enable switch, full name, forge + username, Team select, Project select (mapping for imports).
- [ ] Sync: for each enabled repo fetch open issues (40) + open PRs/MRs (30); skip URLs already linked; if the title/body mentions an identifier (`/\b[A-Z]{2,5}-\d+\b/`) matching an issue → attach link; else create a new issue in the mapped team (default ENG) / project — title as-is for issues (status todo) or `Review: <title>` for PRs (status in_review), description = body + "Imported from <url>" — and attach the link. Store lastSyncAt + "Imported X, linked Y". Show "Last sync …" line.
- [ ] Issue detail "Push to <repo>": creates a remote issue titled `<identifier> <title>` with the description; attaches returned URL as link; toast "Opened on <repo>".

## 18. Links / integrations detection (`lib/links/detect.ts`, `issues/issue-links.tsx`)

Pure client-side — must be ported.
- [ ] Normalize URL (add `https://` if no scheme; keep `north://`). Invalid → toast "Enter a valid URL".
- [ ] `north://session/<id>` → AI session "North AI session", provider xai, threadId.
- [ ] GitHub `/owner/repo/(pull|issues|commit)/id` → git_pr / git_issue / git_commit, title `owner/repo#N` or `owner/repo @ sha7`.
- [ ] GitLab `/-/merge_requests/N`, `/-/issues/N`, `/-/commit/sha` → git_mr `project!N`, git_issue `project#N`, git_commit.
- [ ] Figma → design (title from last path segment, dashes → spaces); Notion → docs "Notion page"; linear.app → generic.
- [ ] AI hosts → ai_session: chatgpt.com/chat.openai.com (ChatGPT), claude.ai (Claude), grok.com/grok.x.ai (Grok), cursor.com/cursor.sh (Cursor), delta.dev/delta.new (Delta), gemini/aistudio.google.com (Gemini), chat.mistral.ai (Mistral), perplexity.ai (Perplexity); `x.com/i/grok` → Grok. Title = readable last slug (if short and not a hex id) else "<Label> session".
- [ ] Fallback generic: title `host + path`, provider other.
- [ ] Adding a link: dedupe per issue+URL, increments linksCount, bumps updatedAt, logs `link` activity; toast "Link attached". Remove (hover ×) decrements linksCount.
- [ ] Link card: tinted provider icon (sparkles for AI, link for git, paperclip otherwise), title as external link (none for `north://`), subtitle "Provider · Kind · subtitle". Provider tints table in `LINK_PROVIDER_META`.

## 19. Multiplayer (external — optional, recommend skipping)

- [ ] `src/lib/multiplayer/p2p.ts` is a generic full-mesh WebRTC room (`P2PRoom`, "perfect negotiation", polling an `/api/rtc` signaling relay). It is **not imported anywhere** and no `/api/rtc` route exists — dead template code; the app has no live collaboration.
- [ ] If wanted later: client-only equivalent = cross-tab sync via `BroadcastChannel` + the `storage` event (re-read `north.db.v2` when another tab writes). Optional.

## 20. Server/DB (external — not needed)

- [ ] `src/lib/db.ts` (Neon/PGLite Postgres) is only used by the platform auth middleware; the app's data layer is entirely localStorage. Replace TanStack Query cache with Angular signals/services over the in-memory DB.

---

## 21. Known quirks in the original (decide: replicate or fix)

- [ ] Create-issue modal always sends status `todo`, so team default status is effectively ignored from the modal.
- [ ] `issueQuery` free-text filter exists in the display store but nothing sets it (no list search box). Optional: add a search input to the toolbar.
- [ ] Opening a saved view overwrites the global filters used by every list.
- [ ] Inbox is single-user: mentions of other users still land in the current user's inbox.
- [ ] Project progress is static; consider deriving from done/total issues.
- [ ] Board drag doesn't persist intra-column order; `reorderIssues` / `lexorankBetween` are unused.
- [ ] No UI for: editing comments, editing labels, deleting views/projects, removing relations, choosing relation type.
- [ ] Notification settings aren't persisted.

## 22. Out of scope for the rebuild

- [ ] Auth gate / Better Auth / sign-in (`src/lib/auth`, `src/routes/api/auth`), viewer data connectors (`src/lib/app-data`).
- [ ] Grok platform chrome: "Created with Grok / Remix" pill, `extensions.js` injector, `PreviewHostBridge` / `preview-host-bridge.ts`, `preview-embedder-origin.ts`.
- [ ] PWA plumbing (`public/__grok/`, `scripts/grok-pwa-*`, manifest/icons), OG/brand card (`src/lib/og`).
- [ ] `server/` middleware, Nitro/Vercel deploy config, `startup.sh`, `.grok/` skills, `routeTree.gen.ts`, `env.server.ts`, error-component styling of the framework.
- [ ] Postgres (Neon / PGLite) and migrations; server functions (replaced by browser calls or stubs per §13/§17).
- [ ] WebRTC multiplayer signaling relay (§19).
- [ ] shadcn/Radix/vaul/sonner/dnd-kit/use-gesture specifics — use Angular equivalents (CDK overlay/menu/dialog/drag-drop, own swipe handling).
