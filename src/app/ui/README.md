# Trama UI kit (Spartan UI + Tailwind v4)

Everything here is the contract for feature screens. Read it before writing a template.

Stack: Angular 22 (zoneless, standalone, signals) · **Spartan UI** (`@spartan-ng/brain` 1.6 + "helm" components generated into `src/app/ui/`, style `nova`) · **Tailwind CSS v4** (`@tailwindcss/postcss`, no `tailwind.config`) · icons `@lucide/angular` · fonts: **IBM Plex Sans** (variable, regular weight almost everywhere) and **IBM Plex Mono** (keys, ids, code), self-hosted in `public/fonts` (from `@fontsource`, SIL OFL; `@font-face` in `src/styles.css`, never a CDN).

Look: a two-pane workspace (sidebar | main). Side panes sit on light gray (`bg-sidebar` = `bg-pane`), the center is white, panes are split by one hairline (`border-border`), rows carry no dividers (flat gray `hover:bg-hover` / `bg-selected`), embedded blocks (code, quoted comments, inspector groups) are cards with a hairline and a 7px radius, the accent is one quiet blue (`primary`: links, focus, unread dots), section labels are sentence-case muted regular text.

## Rules

1. **No native controls in features.** No `<select>`, `<input type="checkbox|radio|range|date">`, `title=""` tooltips, hand-made tabs / switches / popovers / dropdowns / modals. Use the helm components below. Plain `<button>` is allowed only with `hlmBtn` (or inside a helm directive that styles it); text inputs use `hlmInput` / `hlmTextarea`.
2. **Colors only through tokens**: `bg-background`, `text-muted-foreground`, `border-border`, `text-status-working`, … Never raw hex, never Tailwind palette colors (`bg-red-500`), never `dark:` color overrides for things a token already covers. Tokens flip with `html.dark`, so tokenized UI is automatically dark-mode safe.
3. **Density**: 13px body (`text-sm`), 12px meta (`text-xs` / `text-meta`), list rows 32px (`min-h-8`), buttons/inputs 32px (`h-8`; `size="sm"` = 28px), page gutters `px-4 sm:px-6`, gaps in multiples of 4 (`gap-1.5` / `gap-2` / `gap-3`). **Hairlines only between panes and around embedded blocks**: pane dividers and the slim pane header rows (`pane-header`, 44px) use `border-border` (translucent 8%); embedded content blocks are `<div hlmCard>`-style cards (`bg-card border border-border rounded-lg`); form controls keep their `border-input` edge. Everything else is separated with spacing and tints (`bg-muted`, `bg-secondary`, `hover:bg-hover`, `bg-selected`): no dividers between list rows or table rows. Radius: rows 4px (`rounded-sm`), controls 5-6px (`rounded-md`), cards 7px (`rounded-lg`). No shadows on cards; shadows only on overlays (menus, popovers, dialogs, the floating right pane below 1024px).
4. **Monospace (`font-mono`) only for** keys (`AUTH-42`), shortcuts, hashes, code. Use `<app-key-chip>` / `<app-kbd>` / `font-mono`. Never use a serif.
5. **Mobile (390px)**: no horizontal page overflow (`min-w-0` + `truncate` in flex rows, wrap toolbars with `flex-wrap`), tap targets >= 36px on touch (use `size="icon"`/default buttons, not `xs`), the shell scroll container is `#main-content`; do not add `h-screen`, use `h-full` / `min-h-0`.
6. Icons: `@lucide/angular` (`<svg lucideX [size]="14"></svg>` or `<svg [lucideIcon]="icon">` with `LucideDynamicIcon`). `@lucide/angular` resolves to the generated `ui/icons/lucide.ts` (plain icon data, one shared template; see `scripts/generate-lucide-icons.mjs`): run `npm run icons` after importing a new icon, and `npm run size` after a build to print the initial bundle size. Helm internals use `@ng-icons/lucide` (`<ng-icon name="lucideX" />` with `provideIcons`), which is fine inside helm-style code but prefer `@lucide/angular` in features.
7. Don't edit helm files for one-off tweaks; add classes at the usage site (`class="..."` is merged with `tailwind-merge`). Edit a helm file only for a kit-wide change.
8. Toasts: `import { toast } from '@spartan-ng/brain/sonner'; toast.success('Saved')`, or inject `Notifier` from core. `<hlm-toaster />` is already mounted in `App`.
9. Dates: Spartan calendars/date pickers use JS `Date` (native adapter). Convert ISO strings with `new Date(iso)` and back with `.toISOString()`.

## Import paths

Alias: `@spartan-ng/helm/<name>` -> `src/app/ui/<name>/src/index.ts` (declared in `tsconfig.json` `paths`). Each barrel exports the directives/components and an `Hlm…Imports` array to drop into `imports: [...]`:

```ts
import { HlmButtonImports } from '@spartan-ng/helm/button';
@Component({ imports: [HlmButtonImports], template: `<button hlmBtn size="sm">Save</button>` })
```

| path | `imports` constant | notes |
|---|---|---|
| `button` | `HlmButtonImports` | `hlmBtn` on `button`/`a`; `variant`: default / secondary / outline / ghost / destructive / link; `size`: default / xs / sm / lg / icon / icon-xs / icon-sm / icon-lg |
| `button-group` | `HlmButtonGroupImports` | joined buttons |
| `input` / `textarea` | `HlmInputImports` / `HlmTextareaImports` | `<input hlmInput>`, `<textarea hlmTextarea>` |
| `input-group` | `HlmInputGroupImports` | input with leading/trailing addons (`hlm-input-group`, `hlm-input-group-addon`, `input[hlmInputGroupInput]`) |
| `label` | `HlmLabelImports` | `<label hlmLabel>` |
| `field` | `HlmFieldImports` | form-field replacement: `hlm-field`, `hlmFieldLabel`, `hlmFieldDescription`, `hlm-field-error`, `hlmFieldGroup` |
| `select` | `HlmSelectImports` | see below |
| `checkbox` | `HlmCheckboxImports` | `<hlm-checkbox [(checked)]="x" />` (also `ngModel` / `formControl`) |
| `switch` | `HlmSwitchImports` | `<hlm-switch [(checked)]="x" />` |
| `radio-group` | `HlmRadioGroupImports` | `hlm-radio-group` > `hlm-radio value="a"` |
| `slider` | `HlmSliderImports` | `<hlm-slider [(value)]>` |
| `toggle` / `toggle-group` | `HlmToggleImports` / `HlmToggleGroupImports` | segmented controls, view-layout switchers |
| `calendar` | `HlmCalendarImports` | `hlm-calendar`, `-range`, `-multi` |
| `date-picker` | `HlmDatePickerImports` | `<hlm-date-picker [(date)]="d"><hlm-date-picker-trigger>Pick a date</hlm-date-picker-trigger></hlm-date-picker>`; the trigger's content is the placeholder. Also `-range`, `-multi`, `-input` |
| `combobox` / `autocomplete` | `HlmComboboxImports` / `HlmAutocompleteImports` | searchable pickers (assignee, labels…) |
| `command` | `HlmCommandImports` | `hlm-command`, `hlm-command-input`, `hlm-command-list`, `hlmCommandItem`; also `hlm-command-dialog`; the shell's palette is in `layout/command-palette.ts` |
| `dropdown-menu` | `HlmDropdownMenuImports` | see below |
| `context-menu` | `HlmContextMenuImports` | `[hlmContextMenuTrigger]="tpl"`; the menu body reuses `hlm-dropdown-menu` parts |
| `menubar` | `HlmMenubarImports` | desktop menubars |
| `popover` | `HlmPopoverImports` | `hlm-popover` + `hlmPopoverTrigger` + `<hlm-popover-content *hlmPopoverPortal>` |
| `hover-card` | `HlmHoverCardImports` | previews on hover |
| `tooltip` | `HlmTooltip` | `<button hlmTooltip="Copy link" position="bottom">`; replaces `title=` |
| `dialog` | `HlmDialogImports` | `hlm-dialog [state]` + `<hlm-dialog-content *hlmDialogPortal>`; or `HlmDialogService` for programmatic dialogs |
| `alert-dialog` | `HlmAlertDialogImports` | destructive confirmations (global one: `ui.setConfirmDelete()`) |
| `sheet` | `HlmSheetImports` | side panels (mobile filters, quick create) |
| `sidebar` | `HlmSidebarImports` | used by the shell only |
| `tabs` | `HlmTabsImports` | `<hlm-tabs [tab]="t"><hlm-tabs-list variant="line"><button hlmTabsTrigger="a">…</button></hlm-tabs-list><div hlmTabsContent="a">`; prefer `variant="line"` (underline tabs); `variant="pane"` gives the right-pane header look (flat full-height tabs, the active one white with hairlines). Bind `(tabActivated)` to sync the `?tab=` query param |
| `accordion` / `collapsible` | `HlmAccordionImports` / `HlmCollapsibleImports` | |
| `table` | `HlmTableImports` | `table[hlmTable]`, `thead[hlmTHead]`, `tr[hlmTr]`, `th[hlmTh]`, `td[hlmTd]` (use for tabular data; use list rows for entity lists) |
| `pagination` | `HlmPaginationImports` | |
| `resizable` | `HlmResizableImports` | split panes |
| `scroll-area` | `HlmScrollAreaImports` | `ng-scrollbar hlm`; only where native scroll is not enough |
| `avatar` | `HlmAvatarImports` | prefer `<app-actor-avatar>` |
| `badge` | `HlmBadgeImports` | `hlmBadge variant=…`; prefer `<app-status-badge>` for statuses |
| `card` | `HlmCardImports` | rarely needed; the app is flat (borders, not cards) |
| `alert` | `HlmAlertImports` | inline notices |
| `progress` / `skeleton` / `spinner` | `HlmProgressImports` / `HlmSkeletonImports` / `HlmSpinnerImports` | `skeleton` for loading rows |
| `separator` | `HlmSeparatorImports` | |
| `breadcrumb` | `HlmBreadcrumbImports` | the shell already renders the breadcrumb; see `usePageCrumbs` |
| `empty` | `HlmEmptyImports` | prefer `<app-empty-state>` |
| `kbd` | `HlmKbdImports` | prefer `<app-kbd>` |
| `item` / `typography` | `HlmItemImports` / `HlmTypographyImports` | |
| `sonner` | `HlmToasterImports` | mounted once in `App` |
| `utils` | `hlm()`, `classes()`, `provideSpartanHlm()` | `hlm('a', cond && 'b')` = clsx + tailwind-merge |

### Select (replaces `<select>`)

```html
<hlm-select [(value)]="status" [itemToString]="statusLabel">   <!-- itemToString: value -> shown text -->
  <hlm-select-trigger class="w-44"><hlm-select-value placeholder="Status" /></hlm-select-trigger>
  <hlm-select-content *hlmSelectPortal>
    @for (s of statuses; track s) { <hlm-select-item [value]="s">{{ label(s) }}</hlm-select-item> }
  </hlm-select-content>
</hlm-select>
```
`value` may be any type (use `[isItemEqualToValue]` for objects). Forms: works with `ngModel`/`formControl` via `hlm-select` directive host inputs; otherwise use the `value`/`valueChange` signal pair. Multi: `hlm-select-multiple`.

### Dropdown menu (replaces custom menus)

```html
<button hlmBtn variant="ghost" size="icon-sm" [hlmDropdownMenuTrigger]="menu" aria-label="More">…</button>
<ng-template #menu>
  <hlm-dropdown-menu class="w-56">
    <hlm-dropdown-menu-label>Status</hlm-dropdown-menu-label>
    <hlm-dropdown-menu-group>
      <button hlmDropdownMenuItem (triggered)="set('working')">
        <app-status-icon status="working" /> Working
        <hlm-dropdown-menu-shortcut><app-kbd keys="s" /></hlm-dropdown-menu-shortcut>   <!-- right-aligned hint -->
      </button>
      <button hlmDropdownMenuRadio [checked]="x === 'a'" (triggered)="x = 'a'">A <hlm-dropdown-menu-radio-indicator /></button>
    </hlm-dropdown-menu-group>
    <hlm-dropdown-menu-separator />
    <button hlmDropdownMenuItem variant="destructive">Delete</button>
  </hlm-dropdown-menu>
</ng-template>
```
Sub menus: `[hlmDropdownMenuSubTrigger]="sub"` on an item + `<ng-template #sub><hlm-dropdown-menu-sub>…`. Checkbox items: `hlmDropdownMenuCheckbox`.

### Dialog

```html
<hlm-dialog [state]="open() ? 'open' : 'closed'" (closed)="open.set(false)">
  <hlm-dialog-content *hlmDialogPortal="let ctx" class="sm:max-w-lg">
    <hlm-dialog-header><h2 hlmDialogTitle>New issue</h2><p hlmDialogDescription>…</p></hlm-dialog-header>
    …form…
    <hlm-dialog-footer><button hlmBtn variant="outline" hlmDialogClose>Cancel</button><button hlmBtn>Create</button></hlm-dialog-footer>
  </hlm-dialog-content>
</hlm-dialog>
```

## Theme tokens (`src/styles.css`)

Light is `:root`, dark is `:root.dark` (class set by `ThemeService`). All are usable as Tailwind colors (`bg-*`, `text-*`, `border-*`, `ring-*`, with `/opacity`).

- Surfaces: `background`, `foreground`, `card`, `card-foreground`, `popover`, `popover-foreground`, `muted`, `muted-foreground`, `accent`, `accent-foreground`, `secondary`, `secondary-foreground`
- Actions: `primary` (the single accent blue), `primary-foreground`, `destructive`
- Lines: `border`, `input`, `ring`
- Sidebar: `sidebar`, `sidebar-foreground`, `sidebar-accent`, `sidebar-accent-foreground`, `sidebar-border`, `sidebar-primary`, `sidebar-ring`
- Charts: `chart-1` … `chart-5`
- Tones (palette behind statuses): `tone-neutral|slate|blue|amber|orange|violet|red|teal|green`
- **Status colors** (muted, same meaning in both modes: neutral = not started, blue = active, amber = waiting on a human, violet = review, red = broken, teal = ready, green = done):
  - ExecutionState extras: `status-queued|running|failed|completed`
  - IssueStatus (tasks): `status-backlog|todo|in-progress|in-review|done|canceled`
  - Artifact/CI: `status-passing|failing|pending|healthy|degraded`
  - Priority: `priority-urgent|high|medium|low|none`
  - Usage: `text-status-blocked`, `bg-status-working/10`, `border-status-shipped/25`, or in CSS `var(--status-needs-input)` (matches core `statusVar()`).
- Helpers: `text-meta` (12px muted), `row-h` (32px), `pb-safe` (bottom safe-area), `scrollbar-none`, `shadow-menu`.
- Brand / diff / comment: `brand` (terracotta, logo only), `diff-add` / `diff-add-bg` / `diff-del` / `diff-del-bg` (soft green / red rows and "+6 −4" counters), `comment-bar` (purple left bar of a quoted reply), `pane` (side-pane surface).
- Helpers also: `truncate-fade` (one line that fades out instead of an ellipsis), `pane-header` (slim 44px header row).
- Fonts: `font-sans` (IBM Plex Sans), `font-mono` (IBM Plex Mono). `font-medium` is 400, `font-semibold` 500, `font-bold` 600 (hierarchy comes from near-black vs muted, not weight). Sizes: `text-xs` 12px, `text-sm`/`text-base` 13px, `text-lg` 16px, `text-xl` 18px, `text-2xl` 20px.

## Shared primitives (`src/app/shared`, `import { … } from '../../shared'`)

All standalone, OnPush, signal inputs, no raw HTML.

| selector | class | inputs |
|---|---|---|
| `<app-status-icon>` | `StatusIcon` | `status` (any Task/Artifact/CI state), `size=14` |
| `<app-status-badge>` | `StatusBadge` | `status`, `label?`, `iconOnly?` — tinted pill |
| `<app-status-label>` | `StatusLabel` | `status`, `label?` — icon + text, no pill |
| `<app-priority-icon>` | `PriorityIcon` | `priority`, `showLabel?` |
| `<app-provider-icon>` | `ProviderIcon` | `provider` (human/delta/claude_code/codex/cursor/other/github/gitlab/…), `size`, `showLabel?` |
| `<app-actor-avatar>` | `ActorAvatar` | `actor` (`ActorRef` or `ResolvedActor`), `size=20`. user = round initials, **agent = rounded square + provider glyph + blue pip** |
| `<app-actor>` | `ActorLabel` | `actor`, `size` — avatar + name |
| `<app-avatar-stack>` | `AvatarStack` | `actors[]`, `max=3`, `size` |
| `<app-key-chip>` | `KeyChip` | `value` or projected text — mono `AUTH-42` |
| `<app-kbd>` | `Kbd` | `keys` (`"mod+k"`, `"g i"`; `mod` = ⌘ on macOS) |
| `<app-empty-state>` | `EmptyState` | `title`, `description?`, `icon` (a `LucideIcon`); buttons as content |
| `<app-page-header>` | `PageHeader` | `title`, `description?`; slots `[leading]`, `[meta]`, `[actions]`, default (tabs/filters row) |
| `<app-property-row>` | `PropertyRow` | `label`; value as content |
| `<app-markdown>` | `Markdown` | `source` — headings, lists, task lists, code, quotes, links; raw HTML is shown as text |
| `<app-artifact-icon>` | `ArtifactIcon` | `kind`, `state?` |
| `<app-ci-chip>` / `<app-review-chip>` / `<app-conflict-chip>` | | `ci` / `review` / — |
| `<app-issue-kind>` | `IssueKindLabel` | `kind`, `showLabel?` |
| pipes | `relativeTime`, `shortDate`, `fullDate` | `{{ iso | relativeTime }}` |

Status labels also available as `statusLabel(status)`, providers as `providerLabel()`. Enum labels/ordering for pickers come from `core/meta.ts`.

## Layout hooks (`src/app/layout`)

- `AppShell` (`layout/app-shell.ts`) is the router parent of `/:workspaceSlug` and lays out two panes: **sidebar** (`layout/sidebar.ts`: icon row, workspace switcher, Inbox/Tasks, Pinned, the Projects tree in `layout/sidebar-tree.ts`, Views, More, user menu) and **main** (top bar, scrolling content, status bar). Also the command palette (⌘K), shortcuts dialog (`?`), confirm-delete dialog (`ui.setConfirmDelete`). Pages render *inside* the scroll area; page root should be a plain block (`min-h-full`) or `flex h-full min-h-0 flex-col` for full-height layouts.
- **Properties**: there is no preview pane. List rows are plain `routerLink`s to the full page; the task page and the project page render their own property column (`<app-task-inspector>`, `<app-project-properties>`).
- **Status bar**: drop `<app-status-bar>…<span end>…</span></app-status-bar>` anywhere in a page (import `StatusBar` from `layout/status-bar`); the shell pins it under the scroll area as one muted 12px row (left content, `end`-tagged items right). Hidden on phones.
- **Top bar actions**: `<ng-template appTopBarActions><button hlmBtn variant="ghost" size="sm">Share</button></ng-template>` inside a page (import `TopBarActions` from `layout/page-chrome`). In the header, `outline`/`secondary` buttons render as plain text + icon; only the primary filled button keeps its fill.
- **Header avatars**: `<app-page-header title="…" [actors]="[assignee, reporter]">` shows a stacked `<app-avatar-stack>` after the title.
- **Breadcrumbs**: derived from the URL. Override in a page: `usePageCrumbs(() => [{ label: 'Issues', link: ['/', slug(), 'issues'] }, { label: issue()?.key ?? '', mono: true }])`.
- **Global overlays still to build by the feature layer** (the shell does NOT mount them): the *create dialog* (`ui.modal() === 'create'`, `ui.createKind()`, `ui.createDefaults()`) and the `/` search dialog* (`ui.modal() === 'search'`). Add their components to `AppShell`'s `imports` + template (one-line additive change).
- Theme: `inject(ThemeService)` → `mode()`, `resolved()`, `isDark()`, `set('light'|'dark'|'system')`, `toggle()`. ⌘⇧L works through core's `ThemeToggle` (flipping `html.dark`), which `ThemeService` adopts.
