# Trama — Design (v3)

The source of truth is the **v3** frames of `docs/designs/Trama.pen`, above all `v3 · 01 UI Kit`. This file
writes down what those frames say, with exact values, so the app can be rebuilt screen by screen without
guessing. When this file and a frame disagree, the frame wins; fix this file.

- Exports of every v3 frame: `docs/designs/v3/png/<nodeId>.png` (1x, the frame's own size) and
  `docs/designs/v3/html/<slug>--<nodeId>.html` (Tailwind, with every padding, size and colour). They are local
  reference material, not committed. Re-export them from Pencil when the .pen changes.
- The .pen is encrypted: open it only with the Pencil MCP tools, never read it as text.
- "Done" means pixel-identical at 1440×900 (390×844 on phones) against the PNG: the same text bands, sizes and
  colours, compared on screenshots, not by eye.

## 1. Rules

These come from the UI Kit's "Rules" block and hold everywhere:

1. **Square corners, 1px hairlines.** No border radius anywhere (`--radius: 0`), with no exceptions: status
   dots, markers, avatars and switch knobs are squares too.
2. **Accent = primary action / Trama. Blue = Delta.** The accent (default amber) marks the primary action,
   the current focus and Trama itself. Blue marks anything that comes from a Delta thread.
3. **1 task ⇔ 0..1 thread.** Work starts in Delta with `/trama KEY`; a task never shows more than one thread.
4. **Status is always set by people.** Linking a thread or opening a PR never changes a status on its own; the
   app suggests ("Move to In review") and a person confirms.
5. **No chat, no live agents.** Threads are read-only records synced by the agent (`trama sync`).

Surfaces are flat: no gradients, no shadows except on overlays (dialogs, menus, palette). Separation comes
from 1px `border` lines and the `panel`/`elev` steps, never from cards with shadows.

## 2. Colour tokens

Names are the Pencil variable names (`d-*`). The app maps them to CSS variables in `src/styles.css`
(`:root` = light, `:root.dark` = dark, dark is the default) and to Tailwind classes via `@theme inline`.

| Token | Dark | Light | Use | CSS var / class |
|---|---|---|---|---|
| `d-bg` | `#0F1114` | `#FFFFFF` | page background, inputs | `--background` · `bg-background` |
| `d-bg-deep` | `#0B0C0F` | `#F4F4F5` | behind windows (site, desktop frames) | `--bg-deep` |
| `d-panel` | `#14161A` | `#F7F7F8` | sidebar, cards, thread record, dialogs | `--card` · `bg-card` |
| `d-elev` | `#1B1E23` | `#F1F1F3` | secondary buttons, kbd, source chips, toasts | `--secondary` · `bg-secondary` |
| `d-hover` | `#1F2227` | `#EDEDF0` | row hover | `--hover` · `bg-hover` |
| `d-selected` | `#262A30` | `#E6E6EA` | current nav item, selected row | `--selected` · `bg-selected` |
| `d-border` | `#24272D` | `#E4E4E8` | every hairline | `--border` · `border-border` |
| `d-border-strong` | `#33373E` | `#D4D4D9` | dialog edge, focused-but-not-accent edges | `--border-strong` |
| `d-line` | `#3A3E45` | `#C9CACF` | window lights, canceled dot, empty bars, "opened" bars | `--line` |
| `d-grid` | `#24272D80` | `#E4E4E880` | chart and timeline grid | `--grid` |
| `d-text` | `#DCDDE0` | `#17181C` | primary text | `--foreground` · `text-foreground` |
| `d-text-2` | `#C3C5C9` | `#3A3D44` | long text inside records (summary, decisions) | `--text-2` |
| `d-muted` | `#8C9096` | `#5D6068` | secondary text, nav labels, icons | `--muted-foreground` · `text-muted-foreground` |
| `d-faint` | `#5E6269` | `#989BA3` | keys, captions, counts, placeholders | `--faint` · `text-faint` |
| `d-red` | `#CC4B30` | `#C2412D` | urgent, "today", overdue, running timer, danger | `--red` · `text-red` |
| `d-yellow` | `#E2A93B` | `#B47A12` | in progress, stale record, over estimate | `--yellow` |
| `d-blue` | `#5274E0` | `#3D5BD9` | Delta: lines, dots, marks, in review | `--delta-line` |
| `d-blue-text` | `#8EA4EC` | `#3D5BD9` | Delta: text ("DELTA THREAD", "Thread linked") | `--delta` · `text-delta` |
| `d-green` | `#6FAE73` | `#3E8E55` | done, connected, additions, open PR | `--green` |

### Accent (`primary`)

The accent is a theme axis with nine values; **amber is the one every v3 frame uses** and is the default.
The others exist so a workspace can pick its colour (Settings · General).

| Accent | Dark | Light | Strong (pressed) | Soft (dark / light) | Text on it |
|---|---|---|---|---|---|
| **amber** (default) | `#E2A93B` | `#C98A1E` | `#C68F25` | `#2C2416` / `#FBF2DF` | `#1A1206` |
| vermilion | `#CC4B30` | `#CC4B30` | `#AE3A22` | `#2B1A16` / `#FBE9E5` | `#FFFFFF` |
| terracotta | `#B5583A` | `#B5583A` | `#9A4529` | `#2A1C17` / `#F8EBE6` | `#FFFFFF` |
| violet | `#7C5CC4` | `#7C5CC4` | `#6647AD` | `#221C30` / `#EFEAF9` | `#FFFFFF` |
| cobalt | `#3D5BD9` | `#3D5BD9` | `#2E48B8` | `#181E33` / `#E8EDFC` | `#FFFFFF` |
| crimson | `#E5484D` | `#E5484D` | `#C93338` | `#2E1819` / `#FCE8E9` | `#FFFFFF` |
| orange | `#EE6A2F` | `#E25E22` | `#D2551D` | `#2E1E16` / `#FDEEE6` | `#FFFFFF` |
| moss | `#3F8F5A` | `#3F8F5A` | `#2F7347` | `#17251C` / `#E6F2EA` | `#FFFFFF` |
| teal | `#14918A` | `#14918A` | `#0E756F` | `#13262A` / `#E2F3F2` | `#FFFFFF` |

Alpha steps of the accent: `primary-a10` (`1A`), `primary-a20` (`33`), `primary-a40` (`66`), used for focus
rings, the accent edge of a focused input and soft fills. CSS: `--primary`, `--primary-strong`,
`--primary-soft`, `--primary-foreground`, `--primary-a10/20/40`.

Red is **not** the accent: it stays `d-red` for urgency and danger whatever accent is picked.

### Status colours (the dot of `Status`)

| Status | Dot |
|---|---|
| Backlog | `d-faint` `#5E6269` |
| Todo | `d-muted` `#8C9096` |
| In progress | `d-yellow` `#E2A93B` |
| In review | `d-blue` `#5274E0` |
| Done | `d-green` `#6FAE73` |
| Canceled | `d-line` `#3A3E45` |

Custom workspace statuses take the colour of their type (unstarted / started / completed) from the catalog.

### Avatar colours

Square 22×22, initials in mono 9.5px `#DCE3F7`. The fill is per person (stable hash of the id) from:
`#2B3A5C` (blue), `#4A2C26` (red), `#2E4430` (green), `#3F3552` (violet). The UI Kit tints the initials to
match (`#F3D9D2` on red, `#D8EBD9` on green); the screens use `#DCE3F7` for all, so use that.

## 3. Typography

Three families, loaded from Google Fonts: **Newsreader** (titles), **IBM Plex Sans** (body), **IBM Plex Mono**
(labels, ids, keys, numbers, buttons). Line height is the font's normal unless a value is given.

| Role | Family | Size | Notes |
|---|---|---|---|
| Page greeting / hero title | Newsreader | 34 | tracking −0.5px |
| Page title (settings, project) | Newsreader | 30–32 | |
| Section title (`Working on now`, `Statuses`) | Newsreader | 21 | caption next to it in mono 10.5 faint, baseline-aligned |
| Card / thread title | Newsreader | 22–24 | thread record 22, home card 24 |
| Dialog title, empty-state title | Newsreader | 20 | |
| Sidebar workspace name | Newsreader | 18 | |
| Thread mini title | Newsreader | 17 | |
| Date over a greeting | Newsreader italic | 14 | muted |
| Task title in a row | Plex Sans | 13.5 | text |
| Body, nav item, menu item, input | Plex Sans | 13 | |
| Record body (summary) | Plex Sans | 13.5 | line height 1.55, `d-text-2` |
| User name in sidebar | Plex Sans | 12.5 | |
| Mobile task title | Plex Sans | 15 | |
| Button label | Plex Mono | 12 | |
| Breadcrumb parent | Plex Mono | 11.5 | faint; the current crumb is Plex Sans 13 text |
| Search placeholder | Plex Mono | 11.5 | faint |
| Status, priority, key, date, count | Plex Mono | 11 | |
| Chip text (source, thread link), kbd | Plex Mono | 10.5 | |
| Group label (`PROJECTS`, `SUMMARY`) | Plex Mono | 10 | uppercase, faint |
| Avatar initials, `EST` | Plex Mono | 9.5 | |

Uppercase labels are written uppercase in the template text (they are not `text-transform`ed in the design).

## 4. Atoms (UI Kit · Atoms)

All atoms are rows: `flex items-center`, square, 1px borders drawn inside (outline offset −0.5px in the export
→ use `border` with `box-border`).

**Buttons** — 26px tall, Plex Mono 12, padding `5px 6px 5px 10px` with a kbd chip, `5px 10px` without.
Gap 8 (6 for ghost with icon).

| Variant | Fill | Border | Text | Kbd chip |
|---|---|---|---|---|
| Primary | `primary` | — | `on-primary` | `#FFFFFF26` fill, text `on-primary` |
| Secondary | `d-elev` | `d-border` | `d-text` | `d-bg` fill, text `d-muted` |
| Ghost | — | — | `d-muted`, 13px icon | — |
| Danger | — | `d-red` | `d-red` | `#CC4B3026` fill, text `d-red` |

The kbd chip inside a button is 16px tall, padding `1px 5px`, Plex Mono 10.5, no border.

**Kbd** (standalone) — padding `1px 5px`, `d-elev` fill, `d-border` border, Plex Mono 10.5 `d-muted`.

**Status** — padding `3px 8px`, gap 6, `d-border` border, no fill; 7×7 square dot; label Plex Mono 11 text.
Height 20.

**Priority** — gap 6; three bars 3px wide, 5/8/11px tall, gap 2, bottom-aligned; label Plex Mono 11 muted.
Lit bars `d-text`, unlit `d-faint`. Urgent: all bars and the label `d-red`. High = 2 lit, Medium = 1, Low = 0.

**Source** — padding `2px 7px`, gap 5, `d-elev` fill, 11px icon (GitHub, GitLab, Jira, pen for Trama) muted,
label Plex Mono 10.5 muted (`acme/web#412`, `infra/api!88`, `JIRA OPS-219`, `Trama`).

**Thread link** — padding `2px 7px`, gap 5, 6×6 dot, Plex Mono 10.5:
- linked: border `d-blue`/40%, dot `d-blue`, text `d-blue-text` "Thread linked"
- none: border `d-border`, dot `d-faint`, text `d-faint` "No thread"
- stale: border `d-yellow`/40%, dot `d-yellow`, text `d-yellow` "Record stale · 3d"

**Avatar** — 22×22 square, initials Plex Mono 9.5 (see colours).

**Check** — 14×14 square, 1px `d-faint` border; checked: `d-green` fill with a dark check.

**Timer pill** — padding `2px 4px 2px 8px`, gap 8, height 22. Running: fill `d-red`/12%, border `d-red`/40%,
6×6 red square, key Plex Mono 10.5 muted, time Plex Mono 11 text, 18×18 stop button (`d-red`/20%) with a 7×7
text-coloured square. Idle: `d-elev` fill, `d-border` border, "No timer 0:00" muted.

**Estimate** — padding `2px 6px`, gap 5, `d-border` border; `EST` Plex Mono 9.5 faint, value Plex Mono 11 600
text. Over: border/text `d-yellow` ("3 · 13h of ~10h"). Unset: border `d-line`, "—" faint. Suggested: border
`d-blue`/40%, text `d-blue-text` ("3 suggested").

## 5. Rows & lists

**Task row** — 40px tall, padding `0 16px`, gap 12, bottom hairline. Order: check · priority · key (mono 11
faint) · title (Sans 13.5) · flexible space · subtasks (list-tree 12px + "2/4" mono 11 faint) · thread link ·
source · status · avatar · estimate · date (mono 11 muted). Hover `d-hover`, focus/selected `d-selected`.

**Subtask row** — 38px, padding `0 14px`, gap 10: indent arrow (13px, faint) · check · key (mono 11 faint,
`TRM-128.1`) · title (Sans 13) · space · thread link · estimate · status · avatar.

**Nav item** — 30px (sidebar width minus 16 = 232), padding `0 10px`, gap 10: 15px icon muted · label Sans 13
muted · space · count mono 11 faint. Current: `d-selected` fill, icon and label `d-text`.

**Menu item** — 30px, padding `0 10px`, gap 10: 14px icon muted · label Sans 13 text · space · shortcut mono 11
faint.

## 6. Delta thread record

**Record (linked)** — `d-panel` fill, `d-border` 1px, vertical sections each split by a bottom hairline:

1. *Head* — padding `16px 18px`, gap 10. Top row: 8×8 `d-blue` mark · "DELTA THREAD" mono 10.5 `d-blue-text` ·
   space · "read-only · synced 4m ago" mono 10.5 faint. Title Newsreader 22. Meta row (gap 14): thread id mono 11
   muted, then "by Alessandro", "cloud runner", "38 turns · 6 files" mono 11 faint. Actions (gap 8): secondary
   buttons "Open in Delta ↗ O" and "Copy share link ⇧L".
2. *Summary* — padding `14px 18px`, gap 8. "SUMMARY" mono 10 faint, body Sans 13.5 / 1.55 `d-text-2`.
3. *Decisions* — padding `14px 18px`, gap 7. Each: "→" mono 11 `d-blue` + Sans 13 `d-text-2`, gap 8.
4. *Key events* — padding `14px 18px`, gap 7. Each: date mono 10.5 faint (fixed column) + Sans 13 `d-text-2`,
   gap 12.
5. *Changes vs origin/main* — padding `14px 18px`, gap 6. Header with "+214 −37" mono 10.5 `d-green` on the
   right. Each file: file-code 12px faint · path mono 11 `d-text-2` · space · "+128 −4" mono 10.5 faint.
   Last: PR row (padding-top 8) git-pull-request 13px `d-green` · "acme/web#418 · open · checks passing" mono 11.

**Record (empty)** — `d-border` 1px, no fill, padding 18, gap 10. Top: 8×8 outlined faint mark + "DELTA THREAD"
faint. Title "No thread linked" Newsreader 20. Body Sans 13 / 1.55 muted: "Open a thread in Delta and type
/trama TRM-128 — the agent links it here. One thread per task; need another? Create a subtask." Actions:
secondary "Copy /trama TRM-128 ⇧C" and ghost "+ New subtask".

**Thread mini** (mobile, lists) — `d-panel`, border `d-blue`/33%, padding `12px 14px`, gap 6. Top: "DELTA
THREAD" mono 10 `d-blue-text` · space · "4m ago" mono 10 faint. Title Newsreader 17. Meta mono 10.5 faint
"th_8f2a19 · 38 turns · +214 −37 · PR #418". On Home cards the mini has a 2px `d-blue` left edge instead.

## 7. Forms & feedback

**Input / Select** — label mono 10.5 faint uppercase, gap 6, field 34px: `d-bg` fill, `d-border` border,
padding `0 10px`, Sans 13 (placeholder faint). Focused: border `primary`. Select adds a 14px chevron faint.

**Toggle row** — label Sans 13 · space · switch 30×16, padding 2, square 12×12 white knob; on = `primary`
fill, knob right; off = `d-line` fill, knob left (`d-muted`).

**Segmented** — 22px, `d-border` 1px around each segment, padding `4px 10px`, mono 11; selected `d-elev` fill
and text, others muted.

**Toast** — 37px, padding `10px 12px`, gap 10, `d-elev` fill, `d-border`, 14px icon (blue link / red trash /
yellow warning), Sans 13 text, action mono 11 text on the right ("Undo", "Details"). Stack bottom-right, gap 12.

**Dialog** — `d-panel` fill, `d-border-strong` 1px, shadow `0 24px 60px #000000A0`. Head 48px: padding
`14px 18px`, gap 10, key mono 10.5 faint (optional) · title Newsreader 20 · space · `esc` kbd; bottom hairline.
Body padding 18, gap 14. Foot 50px: padding `12px 18px`, top hairline, hint mono 10.5 faint · space · secondary
"Cancel esc" · primary "Confirm ⌘↵". Scrim `#000000` at 60% over the page.

## 8. Shell

**Desktop** — 1440×900: sidebar 248 (with its 1px right border) · main.

- *Sidebar* (`d-panel`): top row 38px (three 9×9 `d-line` window squares, gap 6, panel-left icon 14px faint on
  the right, padding `14px 14px 10px`) · workspace row (logo 24 · "Trama" Newsreader 18 over "acme · 6 members"
  mono 10 faint · chevrons-up-down 13 faint; padding `4px 14px 12px`) · search (padding `0 12px 10px`; field
  30px, `d-bg`, `d-border`, search 13px faint, "Search or jump…" mono 11.5 faint, `⌘K` kbd) · main group
  (padding `6px 8px`, gap 1: Home, Inbox, My tasks, Tasks, Board, Timeline, Time, Ask) · `PROJECTS` group ·
  `WORKSPACE` group (Settings) · flexible space · connector block (padding `10px 14px`, top hairline: 7×7 green
  square + "Delta · /trama skill" mono 10.5 text, below "last agent sync 4m ago · CLI 1.2" mono 10 faint) · user
  row 42px (avatar, name Sans 12.5, bell 14 faint; top hairline).
- *Header* — 44px incl. its bottom hairline, padding `0 20px`, gap 10: crumbs (parent mono 11.5 faint + " / ",
  current Sans 13 text) · space · actions (gap 8: secondary and primary buttons with kbd).
- *Content* — scrolls; page gutter 40px (`px-10`), top 32px, sections 28–32px apart.
- *Status bar* — 28px, padding `0 16px`, gap 16, top hairline, mono 10.5 faint: green square + "Agent sync 4m
  ago" · "GitHub · GitLab · Jira synced 1m ago" … right: "? shortcuts" · "⌘K command" · timer pill.

**Settings** — the settings sidebar replaces the main one: window squares · "Back to Trama esc" field (32px,
`d-bg`, `d-border`) · "Settings" Newsreader 24 over "acme workspace" mono 10 faint · `WORKSPACE` (General,
Workflow, Estimates, Members, Integrations, Time tracking, Billing) · `ACCOUNT` (Profile, Notifications, API &
MCP) · space · "Danger zone" in `d-red` above a top hairline.

**Logo** — the woven T: two strands, one `d-text`, one `primary` (24px in the sidebar). Sizes 16–128 are
components `Logo 16…128` in the .pen.

## 9. Mobile (390×844)

- *Status bar* 44px (system).
- *Header* — padding `6px 18px 12px`, gap 12: back 20px · titles (kicker mono 10 faint uppercase over title
  Newsreader 22) · more 20px.
- *Tab bar* — 79px, `d-panel`, top hairline, padding `8px 8px 26px`: Home, Tasks, Inbox, Search, Me; 20px icon
  over mono 10 label, current `d-text`, others faint.
- *Task row* — padding `12px 18px`, gap 6, bottom hairline: top (check · key mono 10.5 faint · space · status),
  title Sans 15, meta (thread link · subtasks · space · estimate · date mono 10.5 muted · avatar).
- Sheets slide up over a 60% scrim, square top edge, a 1px top border.

## 10. Screens

Frame → route → where the code lives. ✓ = rebuilt to the frame; ○ = not yet.

| Frame | Node | Route / surface | Status |
|---|---|---|---|
| 02 Home | `kdjLY` | `/:ws/overview` (`features/home`) | ✓ |
| 03 Inbox | `blc9n` | `/:ws/inbox` (`features/inbox`) | ✓ |
| 04 Tasks | `FuEwS` | `/:ws/tasks` | ✓ |
| 05 Board | `XiRmK` | `/:ws/board` | ✓ |
| 06 Task detail | `zkj4G` | `/:ws/tasks/:key` | ✓ |
| 07 Subtask detail | `aRWoY` | `/:ws/tasks/:key` (subtask) | ✓ |
| 08 Project | `b2zsa` | `/:ws/projects/:id` | ✓ |
| 33 Project · Progress | `mOTW9` | project page, Progress tab | ✓ |
| 34 Task detail · Progress | `NuPF6` | task page, Progress | ✓ |
| 09 Timeline | `EclJZ` | `/:ws/timeline` | ✓ |
| 10 Ask | `DlKju` | `/:ws/assistant` → Ask | ✓ |
| 11 Settings · Integrations | `fBrhB` | `/:ws/settings/integrations` | ✓ |
| 12 Settings · API & MCP | `OBY5H` | `/:ws/settings/api` | ✓ |
| 13 Settings (Workflow) | `g2j0Pc` | `/:ws/settings/workflow` | ✓ |
| 26 Settings · Time tracking | `QhLO8` | `/:ws/settings/time` | ✓ |
| 29 Settings · Estimates | `HD9sD` | `/:ws/settings/estimates` | ✓ |
| 23 Time · Timesheet | `D0UiXA` | `/:ws/timer` → Time | ✓ |
| 24 Time · Reports | `oCslP` | Time, Reports tab | ✓ |
| 28 Time · Estimates | `W3f0kj` | Time, Estimates tab | ✓ |
| 14 Command palette | `y79Mt` | ⌘K overlay | ✓ |
| 15 New task | `sQqh6` | create dialog (C) | ✓ |
| 16 Row menu & status | `tag4C` | row context menu | ✓ |
| 17 Assignee picker | `S3hbPD` | assignee picker | ✓ |
| 18 Delete confirm & toasts | `gxGTm` | confirm dialog, toasts | ✓ |
| 25 Log time | `ksks6` | log-time dialog | ✓ |
| 27 Estimate picker | `Q8zHHu` | estimate picker | ✓ |
| 39 / 40 Shared view | `s7FV0`, `O8cGY` | `/shared/:token` | ✓ |
| 41 Views · Share popover | `yPIt3` | views share popover | ✓ |
| 32 Landing page | `BScBt` | `/` | ✓ |
| 35 Changelog | `m60o2E` | `/changelog` | ✓ |
| 36 Roadmap | `suNVb` | `/roadmap` | ✓ |
| 37 Compare | `YWYRc` | `/compare` (new) | ✓ |
| 38 Why Trama | `s115l` | `/why` (new) | ✓ |
| M1–M11 | `XaLV9` … `j2Ado` | phone layouts of the screens above | ○ |
| L04, L32–L39 | `Q66DY`, `BLghT`, `iZ8nS`, `Dgvz4`, `xib1g` | light mode references | ○ |

Reference only (no screen of their own): 00 Flow, 22 /trama skill & CLI (product model), 19–21 Desktop
(optional companion app), 30/31/99 brand and logo.

Pages that exist in the app but have no frame (Stats, Activity, Views list, Projects list, auth, onboarding,
blog) are restyled with the same atoms and shell; ask before removing any of them.

## 11. Implementation notes

- Atoms live in `src/app/shared/v3.ts` (`V3Status`, `V3Priority`, `V3Thread`, `V3Source`, `V3Est`, `V3Check`,
  `V3SectionTitle`); add the rest there (timer pill, avatar, kbd, segmented, toast, dialog frame) rather than
  restyling old components page by page.
- Buttons are `hlmBtn` from `src/app/ui/button`; the default size must match §4 (26px, mono 12, kbd chip).
- Use the tokens, never raw hex, so light mode and the accent switch keep working.
- Verify each screen with a 1440×900 screenshot next to `docs/designs/v3/png/<node>.png`.
