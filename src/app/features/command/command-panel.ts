import { DOCUMENT, NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { Router } from '@angular/router';
import {
  LucideActivity,
  LucideArrowLeftRight,
  LucideBot,
  LucideBuilding2,
  LucideChevronRight,
  LucideCircleDot,
  LucideCircleHelp,
  LucideCopy,
  LucideDynamicIcon,
  LucideEraser,
  LucideFolderGit2,
  LucideGitBranch,
  LucideGitPullRequest,
  LucideHash,
  LucideInbox,
  LucideListChecks,
  LucideKeyRound,
  LucideKeyboard,
  LucideLayers,
  LucideLink,
  LucideLogOut,
  LucideMonitor,
  LucideMoon,
  LucidePanelLeft,
  LucidePlug,
  LucideFilePlus,
  LucideFileText,
  LucidePlus,
  LucideScale,
  LucideBell,
  LucideSearch,
  LucideSlidersHorizontal,
  LucideStar,
  LucideSettings,
  LucideSparkles,
  LucideSun,
  LucideSunMoon,
  LucideUserRound,
  LucideUserRoundCheck,
  LucideUsers,
  LucideWorkflow,
  type LucideIcon,
  LucideBox,
} from '@lucide/angular';
import { BrnCommand, BrnCommandInput } from '@spartan-ng/brain/command';
import { HlmCommandImports } from '@spartan-ng/helm/command';
import type {
  ArtifactKind,
  IssueStatus,
  Project,
  WorkstreamStatus,
} from '../../core/contracts/domain';
import {
  ISSUE_STATUSES,
  ISSUE_STATUS_META,
  WORKSTREAM_STATUSES,
  WORKSTREAM_STATUS_META,
} from '../../core/meta';
import { BranchNames } from '../../core/branch-prefs';
import { Clipboard } from '../../core/notify/notifier';
import { AiActions } from '../ai-actions/ai-actions.service';
import { Documents } from '../documents/documents.service';
import { AssistantStore } from '../../core/ai/assistant.store';
import { SessionStore } from '../../core/session/session.store';
import { CustomerSubscriptionsStore } from '../../core/stores/customer-subscriptions.store';
import { FavoritesStore } from '../../core/stores/favorites.store';
import { NablaStore } from '../../core/stores/nabla.store';
import { UiStore, type CreateKind } from '../../core/stores/ui.store';
import { ThemeService } from '../../core/theme';
import { ALL_NAV } from '../../layout/nav';
import { OnboardingStore } from '../../core/stores/onboarding.store';
import { ActorAvatar } from '../../shared/actor-avatar';
import { ArtifactIcon } from '../../shared/artifact';
import { Kbd } from '../../shared/kbd';
import { ProviderIcon } from '../../shared/provider-icon';
import { ProjectGlyph } from '../projects/project-glyph';
import { StatusIcon, type AnyStatus, type StatusEntity } from '../../shared/status';
import { fuzzyScore } from './fuzzy';
import { RecentItems } from './recent.service';
import {
  HIT_LABEL,
  HIT_ORDER,
  SearchService,
  type HitType,
  type SearchHit,
} from './search.service';

interface Cmd {
  id: string;
  label: string;
  /** Extra words that make the command findable. */
  keywords?: string;
  icon: LucideIcon;
  keys?: string;
  /** AI action: shown in the AI group with the accent sparkle. */
  ai?: boolean;
  /** Right-aligned muted text. */
  hint?: string;
  /** Status glyph instead of the icon (status page). */
  status?: AnyStatus;
  entity?: StatusEntity;
  run: () => void;
}

/** A row in a result group: a search hit, a recent item or a person. */
type ItemType = HitType | 'person';
interface PanelItem {
  type: ItemType;
  id: string;
  key?: string;
  title: string;
  subtitle?: string;
  workstreamKey?: string;
}
interface ItemGroup {
  id: string;
  label: string;
  items: PanelItem[];
}

interface Visual {
  kind: 'status' | 'artifact' | 'avatar' | 'team' | 'repo' | 'project' | 'icon';
  status?: any;
  project?: Project;
  entity?: StatusEntity;
  artifactKind?: ArtifactKind;
  color?: string;
  provider?: string;
}

/** Palette scopes (chips). `all` mixes everything plus Go to / Actions. */
type Scope =
  'all' | 'issue' | 'workstream' | 'project' | 'decision' | 'repository' | 'person' | 'team';

const SCOPES: { id: Scope; label: string; placeholder: string }[] = [
  { id: 'all', label: 'All', placeholder: '' },
  { id: 'issue', label: 'Issues', placeholder: 'Search issues…' },
  { id: 'workstream', label: 'Workstreams', placeholder: 'Search workstreams…' },
  { id: 'project', label: 'Projects', placeholder: 'Search projects…' },
  { id: 'decision', label: 'Decisions', placeholder: 'Search decisions…' },
  { id: 'repository', label: 'Repositories', placeholder: 'Search repositories…' },
  { id: 'person', label: 'People', placeholder: 'Search people…' },
  { id: 'team', label: 'Teams', placeholder: 'Search teams…' },
];

/** Typed prefixes that switch scope ("issue:", "@", …). */
const PREFIXES: Record<string, Scope> = {
  issue: 'issue',
  issues: 'issue',
  is: 'issue',
  bug: 'issue',
  ws: 'workstream',
  workstream: 'workstream',
  workstreams: 'workstream',
  project: 'project',
  projects: 'project',
  decision: 'decision',
  decisions: 'decision',
  adr: 'decision',
  repo: 'repository',
  people: 'person',
  person: 'person',
  user: 'person',
  team: 'team',
  teams: 'team',
};

const HIT_ICON: Record<ItemType, LucideIcon> = {
  workstream: LucideWorkflow,
  project: LucideBox,
  decision: LucideScale,
  issue: LucideInbox,
  customer: LucideBuilding2,
  artifact: LucideGitPullRequest,
  repository: LucideFolderGit2,
  team: LucideUsers,
  person: LucideUserRound,
};

const SETTINGS_SECTIONS: { id: string; label: string; icon: LucideIcon; keywords?: string }[] = [
  { id: 'profile', label: 'Profile', icon: LucideUserRound },
  {
    id: 'preferences',
    label: 'Preferences',
    icon: LucideSlidersHorizontal,
    keywords: 'home font cursor links motion comments enter',
  },
  { id: 'notifications', label: 'Notifications', icon: LucideBell, keywords: 'email alerts inbox' },
  { id: 'appearance', label: 'Appearance', icon: LucideSunMoon, keywords: 'theme dark light' },
  { id: 'workspace', label: 'Workspace', icon: LucideBuilding2 },
  { id: 'members', label: 'Members & roles', icon: LucideUsers, keywords: 'people invite' },
  { id: 'teams', label: 'Teams', icon: LucideUsers },
  { id: 'agents', label: 'Agents', icon: LucideBot, keywords: 'claude codex cursor delta' },
  { id: 'tokens', label: 'API tokens', icon: LucideKeyRound, keywords: 'keys secret mcp' },
  {
    id: 'integrations',
    label: 'Integrations',
    icon: LucidePlug,
    keywords: 'github gitlab delta webhook',
  },
  { id: 'shortcuts', label: 'Keyboard shortcuts', icon: LucideKeyboard },
];

/** Static items are fuzzy-filtered by the command; result items (value starts with \u0001) always show. */
export function commandFilter(value: string, search: string): boolean {
  return value.startsWith('\u0001') || fuzzyScore(value, search) > 0;
}

const byUpdated = <T extends { updatedAt: string }>(a: T, b: T) =>
  a.updatedAt < b.updatedAt ? 1 : -1;

/**
 * Floating command surface. Compact on phones, 40rem on desktop, pinned near the top.
 * Height comes from the panel, which grows with its rows up to a cap.
 */
export const COMMAND_DIALOG_CLASS =
  // Widths use viewport units: the CDK pane shrink-wraps its content, so a `%` width collapses to the content width.
  'w-[min(32rem,calc(100vw-1.5rem))] sm:w-[min(40rem,calc(100vw-2rem))] max-w-none sm:max-w-none top-[min(12vh,5rem)] translate-y-0 gap-0 overflow-hidden rounded-md border border-border-strong p-0 duration-150 data-open:slide-in-from-top-2 data-closed:slide-out-to-top-2';

/**
 * Shared body of the ⌘K palette and the `/` search dialog.
 *  - scope chips (All · Issues · Workstreams · Decisions · Repositories · People · Teams); Tab cycles,
 *    prefixes like `issue:` / `@` switch scope, Backspace on an empty query goes back to All
 *  - `palette`: context actions for the open issue/workstream, recent items, Go to, Actions, live results
 *  - `search`:  recent items and results grouped by type
 * Results come from `GET /search` (debounced) and fall back to a client-side fuzzy search over the store.
 */
@Component({
  selector: 'app-command-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    HlmCommandImports,
    LucideDynamicIcon,
    NgTemplateOutlet,
    StatusIcon,
    ArtifactIcon,
    ActorAvatar,
    ProviderIcon,
    Kbd,
    BrnCommandInput,
    ProjectGlyph,
  ],
  host: { class: 'block', '(keydown)': 'onKeydown($event)' },
  template: `
    <ng-template #glyph let-h>
      @let v = visual(h);
      @switch (v.kind) {
        @case ('status') {
          <app-status-icon [status]="v.status" [entity]="v.entity ?? 'auto'" />
        }
        @case ('artifact') {
          <app-artifact-icon [kind]="v.artifactKind!" [state]="v.status" />
        }
        @case ('avatar') {
          <app-actor-avatar [actor]="{ type: 'user', id: h.id }" [size]="16" />
        }
        @case ('team') {
          <span class="flex size-3.5 shrink-0 items-center justify-center"
            ><span class="size-2.5 rounded-full" [style.background]="v.color"></span
          ></span>
        }
        @case ('repo') {
          <app-provider-icon [provider]="$any(v.provider)" [size]="14" />
        }
        @case ('project') {
          <app-project-glyph [project]="v.project!" [size]="14" />
        }
        @default {
          <svg [lucideIcon]="iconFor(h)" [size]="14" class="text-muted-foreground shrink-0"></svg>
        }
      }
    </ng-template>

    <ng-template #cmdRow let-c>
      @if (c.status) {
        <app-status-icon [status]="c.status" [entity]="c.entity ?? 'auto'" />
      } @else {
        <svg
          [lucideIcon]="c.icon"
          [size]="16"
          class="shrink-0"
          [class]="c.ai ? 'text-primary' : 'text-muted-foreground'"
        ></svg>
      }
      <span class="min-w-0 flex-1 truncate">{{ c.label }}</span>
      @if (c.keys) {
        <hlm-command-shortcut class="max-sm:hidden"
          ><app-kbd [keys]="c.keys" [chord]="isChord(c.keys)"
        /></hlm-command-shortcut>
      } @else if (c.hint) {
        <span class="text-muted-foreground shrink-0 text-xs">{{ c.hint }}</span>
      }
    </ng-template>

    <hlm-command
      class="h-auto max-h-[min(34rem,78svh)] rounded-none p-0"
      [filter]="filter"
      [(search)]="query"
    >
      <div class="border-border shrink-0 border-b">
        <div class="flex h-12 items-center gap-2.5 px-4">
          @if (mode() === 'palette' && context(); as ctx) {
            <button
              type="button"
              class="border-border-strong bg-muted text-muted-foreground hover:text-foreground flex h-6 shrink-0 items-center gap-1.5 rounded-md border px-2 font-mono text-xs transition-colors"
              [attr.aria-label]="page() === 'status' ? 'Back to ' + ctx.key + ' actions' : ctx.key"
              [disabled]="page() === 'root'"
              (mousedown)="$event.preventDefault()"
              (click)="backToRoot()"
            >
              <svg [lucideIcon]="contextIcon()" [size]="12" aria-hidden="true"></svg>
              {{ ctx.key }}
            </button>
            @if (page() === 'status') {
              <svg
                [lucideIcon]="chevron"
                [size]="12"
                aria-hidden="true"
                class="text-muted-foreground -mx-1 shrink-0"
              ></svg>
              <span class="text-foreground shrink-0 text-xs font-medium max-sm:hidden"
                >Change status</span
              >
            }
          } @else {
            <svg
              [lucideIcon]="searchIcon"
              [size]="16"
              aria-hidden="true"
              class="text-muted-foreground shrink-0"
            ></svg>
          }
          <input
            brnCommandInput
            data-slot="command-input"
            class="placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-[15px] outline-hidden"
            [placeholder]="placeholder()"
            [attr.aria-label]="placeholder()"
            (keydown.meta.enter)="askAssistant($event)"
            (keydown.control.enter)="askAssistant($event)"
          />
          @if (canAsk()) {
            <button
              type="button"
              class="text-muted-foreground hover:bg-hover hover:text-foreground -mr-1.5 flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors max-sm:hidden"
              (mousedown)="$event.preventDefault()"
              (click)="askAssistant()"
            >
              <svg
                [lucideIcon]="sparkles"
                [size]="13"
                aria-hidden="true"
                class="text-primary"
              ></svg>
              Ask Trama <app-kbd keys="mod+enter" />
            </button>
          }
        </div>

        @if (showScopes()) {
          <div
            class="scrollbar-none flex items-center gap-1 overflow-x-auto px-3 pb-2"
            role="tablist"
            aria-label="Search scope"
          >
            @for (s of scopes; track s.id) {
              <button
                type="button"
                role="tab"
                class="flex h-6 shrink-0 items-center rounded-md px-2 text-xs transition-colors"
                [class]="
                  scope() === s.id
                    ? 'bg-selected text-foreground font-medium'
                    : 'text-muted-foreground hover:text-foreground hover:bg-hover'
                "
                [attr.aria-selected]="scope() === s.id"
                (mousedown)="$event.preventDefault()"
                (click)="setScope(s.id)"
              >
                {{ s.label }}
              </button>
            }
          </div>
        }
      </div>

      <div
        *hlmCommandEmptyState
        hlmCommandEmpty
        class="text-muted-foreground flex flex-col items-center gap-1 px-6 py-10"
      >
        <svg [lucideIcon]="searchIcon" [size]="18" [strokeWidth]="1.5" class="mb-1"></svg>
        @if (loading()) {
          <p>Searching…</p>
        } @else if (query().trim()) {
          <p class="text-foreground">No results for “{{ query().trim() }}”</p>
          <p class="text-xs">Try another keyword, or press Tab to change the scope.</p>
        } @else {
          <p>Nothing here yet.</p>
        }
      </div>

      <hlm-command-list
        class="max-h-[min(26rem,calc(78svh-7.5rem))] overscroll-contain px-2 pt-1 pb-2 [&_[data-slot=command-group]]:p-0 [&_[data-slot=command-group]]:pb-1 [&_[data-slot=command-group-label]]:px-2 [&_[data-slot=command-group-label]]:pt-3 [&_[data-slot=command-group-label]]:pb-1 [&_[data-slot=command-group-label]]:text-[11px] [&_[data-slot=command-item]]:min-h-9 [&_[data-slot=command-item]]:gap-2.5"
      >
        @if (page() === 'status') {
          <hlm-command-group>
            <hlm-command-group-label>Status</hlm-command-group-label>
            @for (c of statusCommands(); track c.id) {
              <button hlmCommandItem [value]="'status ' + c.label" (selected)="exec(c)">
                <ng-container
                  [ngTemplateOutlet]="cmdRow"
                  [ngTemplateOutletContext]="{ $implicit: c }"
                />
              </button>
            }
          </hlm-command-group>
        } @else {
          @if (contextMain().length) {
            <hlm-command-group>
              <hlm-command-group-label>{{ contextLabel() }}</hlm-command-group-label>
              @for (c of contextMain(); track c.id) {
                <button
                  hlmCommandItem
                  [value]="'context ' + c.label + ' ' + (c.keywords ?? '')"
                  (selected)="exec(c)"
                >
                  <ng-container
                    [ngTemplateOutlet]="cmdRow"
                    [ngTemplateOutletContext]="{ $implicit: c }"
                  />
                </button>
              }
            </hlm-command-group>
          }
          @if (contextAi().length) {
            <hlm-command-group>
              <hlm-command-group-label>AI</hlm-command-group-label>
              @for (c of contextAi(); track c.id) {
                <button
                  hlmCommandItem
                  [value]="'context ai ' + c.label + ' ' + (c.keywords ?? '')"
                  (selected)="exec(c)"
                >
                  <ng-container
                    [ngTemplateOutlet]="cmdRow"
                    [ngTemplateOutletContext]="{ $implicit: c }"
                  />
                </button>
              }
            </hlm-command-group>
          }

          @for (g of groups(); track g.id) {
            <hlm-command-group>
              <hlm-command-group-label>
                <span class="flex items-center justify-between">
                  <span>{{ g.label }}</span>
                </span>
              </hlm-command-group-label>
              @for (h of g.items; track h.type + h.id) {
                <button
                  hlmCommandItem
                  [value]="'\\u0001' + g.id + ':' + h.type + ':' + h.id"
                  (selected)="open(h)"
                >
                  <ng-container
                    [ngTemplateOutlet]="glyph"
                    [ngTemplateOutletContext]="{ $implicit: h }"
                  />
                  @if (h.key) {
                    <span class="text-muted-foreground shrink-0 font-mono text-xs">{{
                      h.key
                    }}</span>
                  }
                  <span class="min-w-0 flex-1 truncate">{{ h.title }}</span>
                  @if (h.type === 'person') {
                    <span
                      class="text-muted-foreground max-w-[45%] shrink-0 truncate text-xs max-sm:hidden"
                      >{{ h.subtitle }}</span
                    >
                    <span
                      class="text-muted-foreground shrink-0 text-[11px] opacity-0 [[data-selected]_&]:opacity-100"
                      >Copy email</span
                    >
                  } @else if (h.workstreamKey || h.subtitle) {
                    <span
                      class="text-muted-foreground max-w-[40%] shrink-0 truncate font-mono text-xs max-sm:hidden"
                      >{{ h.workstreamKey ?? h.subtitle }}</span
                    >
                  }
                </button>
              }
            </hlm-command-group>
          }

          @if (mode() === 'palette' && scope() === 'all') {
            <hlm-command-group>
              <hlm-command-group-label>Actions</hlm-command-group-label>
              @for (c of actionCommands(); track c.id) {
                <button
                  hlmCommandItem
                  [value]="'action ' + c.label + ' ' + (c.keywords ?? '')"
                  (selected)="exec(c)"
                >
                  <ng-container
                    [ngTemplateOutlet]="cmdRow"
                    [ngTemplateOutletContext]="{ $implicit: c }"
                  />
                </button>
              }
            </hlm-command-group>
            <hlm-command-group>
              <hlm-command-group-label>Navigation</hlm-command-group-label>
              @for (c of navCommands(); track c.id) {
                <button
                  hlmCommandItem
                  [value]="'go ' + c.label + ' ' + (c.keywords ?? '')"
                  (selected)="exec(c)"
                >
                  <ng-container
                    [ngTemplateOutlet]="cmdRow"
                    [ngTemplateOutletContext]="{ $implicit: c }"
                  />
                </button>
              }
            </hlm-command-group>
          } @else if (
            mode() === 'search' && scope() === 'all' && !isSearching() && !groups().length
          ) {
            <div
              class="text-muted-foreground flex flex-col items-center gap-2 px-6 py-12 text-center text-sm"
            >
              <svg [lucideIcon]="searchIcon" [size]="18" [strokeWidth]="1.5"></svg>
              <p>Search workstreams, issues, decisions, repositories, people and teams.</p>
              <p class="text-xs">
                Tip: type <span class="font-mono">issue:</span>,
                <span class="font-mono">ws:</span> or <span class="font-mono">&#64;</span> to
                narrow.
              </p>
            </div>
          }
        }
      </hlm-command-list>

      <div
        class="border-border text-muted-foreground flex h-9 shrink-0 items-center gap-4 border-t px-4 text-[11px] max-sm:hidden"
      >
        <span class="flex items-center gap-1.5"><app-kbd keys="up down" /> navigate</span>
        <span class="flex items-center gap-1.5"><app-kbd keys="enter" /> select</span>
        @if (page() === 'root') {
          <span class="flex items-center gap-1.5"><app-kbd keys="tab" /> scope</span>
        } @else {
          <span class="flex items-center gap-1.5"><app-kbd keys="esc" /> back</span>
        }
        @if (loading()) {
          <span class="ml-auto">Searching…</span>
        }
      </div>
    </hlm-command>
  `,
})
export class CommandPanel {
  readonly mode = input<'palette' | 'search'>('palette');

  private readonly ui = inject(UiStore);
  private readonly store = inject(NablaStore);
  private readonly favorites = inject(FavoritesStore);
  private readonly customerSubs = inject(CustomerSubscriptionsStore);
  private readonly session = inject(SessionStore);
  private readonly router = inject(Router);
  private readonly documents = inject(Documents);
  private readonly theme = inject(ThemeService);
  private readonly searchSvc = inject(SearchService);
  private readonly recents = inject(RecentItems);
  private readonly clipboard = inject(Clipboard);
  private readonly ai = inject(AiActions);
  private readonly assistant = inject(AssistantStore);
  private readonly branches = inject(BranchNames);
  private readonly onboarding = inject(OnboardingStore);
  private readonly document = inject(DOCUMENT);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly command = viewChild(BrnCommand);

  protected readonly filter = commandFilter;
  protected readonly scopes = SCOPES;
  protected readonly searchIcon = LucideSearch;
  protected readonly chevron = LucideChevronRight;
  protected readonly sparkles = LucideSparkles;

  protected readonly query = signal('');
  protected readonly scope = signal<Scope>('all');
  protected readonly page = signal<'root' | 'status'>('root');
  protected readonly loading = signal(false);
  private readonly remote = signal<{ q: string; scope: Scope; hits: SearchHit[] } | null>(null);
  private timer: ReturnType<typeof setTimeout> | undefined;
  private gen = 0;

  private readonly slug = computed(() => this.store.slug() ?? '');

  protected readonly placeholder = computed(() => {
    if (this.page() === 'status') return 'Change status to…';
    const s = SCOPES.find((x) => x.id === this.scope());
    if (s?.placeholder) return s.placeholder;
    return this.mode() === 'palette'
      ? 'Type a command or search…'
      : 'Search workstreams, issues, decisions…';
  });
  protected readonly isSearching = computed(() => this.query().trim().length > 0);
  /** The scope chips stay out of the way until you search or narrow the scope (the `/` dialog always shows them). */
  protected readonly showScopes = computed(
    () =>
      this.page() === 'root' &&
      (this.mode() === 'search' || this.isSearching() || this.scope() !== 'all'),
  );
  protected readonly canAsk = computed(
    () => this.mode() === 'palette' && this.page() === 'root' && this.assistant.ready(),
  );

  // ─────────────────────────── results ───────────────────────────

  private readonly hits = computed<SearchHit[]>(() => {
    const q = this.query().trim();
    const scope = this.scope();
    if (!q || scope === 'person') return [];
    const only = scope === 'all' ? undefined : (scope as HitType);
    const r = this.remote();
    if (r && r.q === q && r.scope === scope && r.hits.length) {
      return only ? r.hits.filter((h) => h.type === only) : r.hits;
    }
    // Remote still pending / failed / empty: show what the snapshot knows right now.
    return this.searchSvc.local(q, only ? 40 : 6, only);
  });

  private readonly people = computed<PanelItem[]>(() => {
    const scope = this.scope();
    if (scope !== 'all' && scope !== 'person') return [];
    const q = this.query().trim();
    if (scope === 'all' && !q) return [];
    const rows = this.store.members().map((m) => ({
      item: { type: 'person' as const, id: m.user.id, title: m.user.name, subtitle: m.user.email },
      score: q ? Math.max(fuzzyScore(m.user.name, q), fuzzyScore(m.user.email, q) * 0.8) : 1,
    }));
    return rows
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, scope === 'all' ? 4 : 100)
      .map((r) => r.item);
  });

  /** Scope set, empty query: browse that type straight from the store. */
  private readonly browse = computed<PanelItem[]>(() => {
    const s = this.store;
    const wsKey = (id: string) => s.workstreamById().get(id)?.key;
    switch (this.scope()) {
      case 'issue':
        return [...s.issues()]
          .sort(byUpdated)
          .slice(0, 50)
          .map((i) => ({ type: 'issue', id: i.id, key: i.key, title: i.title }));
      case 'workstream':
        return [...s.workstreams()]
          .sort(byUpdated)
          .slice(0, 50)
          .map((w) => ({ type: 'workstream', id: w.id, key: w.key, title: w.title }));
      case 'project':
        return [...s.projects()]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((p) => ({ type: 'project', id: p.id, title: p.name, subtitle: p.summary }));
      case 'decision':
        return [...s.decisions()]
          .sort(byUpdated)
          .slice(0, 50)
          .map((d) => ({
            type: 'decision',
            id: d.id,
            key: d.key,
            title: d.title,
            workstreamKey: d.originWorkstreamId ? wsKey(d.originWorkstreamId) : undefined,
          }));
      case 'repository':
        return [...s.repositories()]
          .sort((a, b) => a.fullName.localeCompare(b.fullName))
          .map((r) => ({
            type: 'repository',
            id: r.id,
            title: r.fullName,
            subtitle: r.defaultBranch,
          }));
      case 'team':
        return [...s.teams()]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((t) => ({ type: 'team', id: t.id, key: t.key, title: t.name }));
      default:
        return [];
    }
  });

  protected readonly groups = computed<ItemGroup[]>(() => {
    const scope = this.scope();
    const searching = this.isSearching();
    if (!searching) {
      if (scope === 'all') {
        const here = this.recents.current();
        const recent = this.recents
          .list()
          .filter((r) => !(here && r.type === here.type && r.id === here.id))
          .slice(0, 8);
        return recent.length ? [{ id: 'recent', label: 'Recently viewed', items: recent }] : [];
      }
      const items = scope === 'person' ? this.people() : this.browse();
      const label = SCOPES.find((x) => x.id === scope)?.label ?? '';
      return items.length ? [{ id: 'browse', label, items }] : [];
    }
    const by = new Map<ItemType, PanelItem[]>();
    for (const h of this.hits()) by.set(h.type, [...(by.get(h.type) ?? []), h]);
    const out: ItemGroup[] = HIT_ORDER.filter((t) => by.has(t)).map((t) => ({
      id: t,
      label: HIT_LABEL[t],
      items: by.get(t)!,
    }));
    const people = this.people();
    if (people.length) out.push({ id: 'person', label: 'People', items: people });
    return out;
  });

  // ─────────────────────────── context (open issue / workstream) ───────────────────────────

  /** The issue or workstream whose page is open, from the router URL. */
  protected readonly context = computed(() => {
    const path = this.router.url.split(/[?#]/)[0].split('/').filter(Boolean);
    if (path.length < 3) return null;
    const key = decodeURIComponent(path[2]);
    if (path[1] === 'issues') {
      const issue = this.store.getIssue(key);
      return issue
        ? { type: 'issue' as const, id: issue.id, key: issue.key, issue, ws: null }
        : null;
    }
    if (path[1] === 'workstreams') {
      const ws = this.store.getWorkstream(key);
      return ws ? { type: 'workstream' as const, id: ws.id, key: ws.key, issue: null, ws } : null;
    }
    return null;
  });

  protected readonly contextLabel = computed(() => {
    const c = this.context();
    return c ? `${c.type === 'issue' ? 'Issue' : 'Workstream'} actions` : '';
  });

  protected readonly contextIcon = computed(() =>
    this.context()?.type === 'workstream' ? HIT_ICON.workstream : HIT_ICON.issue,
  );

  protected readonly contextMain = computed(() => this.contextCommands().filter((c) => !c.ai));
  protected readonly contextAi = computed(() => this.contextCommands().filter((c) => c.ai));

  protected readonly contextCommands = computed<Cmd[]>(() => {
    const c = this.context();
    if (!c || this.mode() !== 'palette' || this.scope() !== 'all') return [];
    const canWrite = this.store.can('member');
    const out: Cmd[] = [];
    if (canWrite) {
      out.push({
        id: 'ctx:status',
        label: 'Change status…',
        keywords: 'state move',
        icon: LucideCircleDot,
        keys: c.issue ? 's' : undefined,
        run: () => this.openStatusPage(),
      });
      const me = this.store.me()?.id;
      if (c.issue && me && c.issue.assigneeId !== me) {
        out.push({
          id: 'ctx:assign-me',
          label: 'Assign to me',
          keywords: 'assignee take',
          icon: LucideUserRoundCheck,
          keys: 'i',
          run: () => void this.store.updateIssue(c.id, { assigneeId: me }),
        });
      }
    }
    if (this.ai.available()) {
      const ask = (kind: 'summarize' | 'triage' | 'improve' | 'update' | 'breakdown') => () =>
        this.ai.request(kind, c.id);
      if (c.issue) {
        out.push({
          id: 'ctx:ai-summarize',
          label: 'Summarize this issue',
          keywords: 'ai tldr summary explain',
          icon: LucideSparkles,
          ai: true,
          run: ask('summarize'),
        });
        if (this.ai.canEditIssue(c.issue)) {
          out.push(
            {
              id: 'ctx:ai-triage',
              label: 'Suggest properties',
              keywords: 'ai triage priority estimate type workstream',
              icon: LucideSparkles,
              ai: true,
              run: ask('triage'),
            },
            {
              id: 'ctx:ai-improve',
              label: 'Improve description',
              keywords: 'ai rewrite clearer title',
              icon: LucideSparkles,
              ai: true,
              run: ask('improve'),
            },
          );
        }
      } else if (c.ws) {
        out.push({
          id: 'ctx:ai-update',
          label: 'Draft status update',
          keywords: 'ai report stakeholder summary',
          icon: LucideSparkles,
          ai: true,
          run: ask('update'),
        });
        if (this.ai.canEditWorkstream(c.ws)) {
          out.push({
            id: 'ctx:ai-breakdown',
            label: 'Break down into issues',
            keywords: 'ai plan split tasks',
            icon: LucideSparkles,
            ai: true,
            run: ask('breakdown'),
          });
        }
      }
    }
    out.push(
      {
        id: 'ctx:copy-key',
        label: `Copy ${c.type} key`,
        keywords: 'id',
        icon: LucideHash,
        hint: c.key,
        keys: c.issue ? 'mod+.' : undefined,
        run: () => void this.clipboard.copy(c.key, 'Key copied'),
      },
      {
        id: 'ctx:copy-branch',
        label: 'Copy git branch name',
        keywords: 'git branch checkout',
        icon: LucideGitBranch,
        keys: 'mod+shift+g',
        run: () => void this.branches.copy(c.key, (c.issue ?? c.ws)!.title),
      },
      {
        id: 'ctx:copy-link',
        label: `Copy ${c.type} link`,
        keywords: 'url share',
        icon: LucideLink,
        keys: c.issue ? 'mod+shift+l' : undefined,
        run: () => void this.clipboard.copy(this.document.location.href, 'Link copied'),
      },
    );
    return out;
  });

  protected readonly statusCommands = computed<Cmd[]>(() => {
    const c = this.context();
    if (!c) return [];
    const done = () => this.ui.closeModal();
    if (c.issue) {
      const current = c.issue.status;
      return ISSUE_STATUSES.map((s: IssueStatus) => ({
        id: 'st:' + s,
        label: ISSUE_STATUS_META[s].label,
        icon: LucideCircleDot,
        status: s as AnyStatus,
        entity: 'issue' as StatusEntity,
        hint: s === current ? 'Current' : undefined,
        run: () => {
          if (s !== current) void this.store.updateIssue(c.id, { status: s });
          done();
        },
      }));
    }
    const ws = c.ws!;
    const out: Cmd[] = WORKSTREAM_STATUSES.map((s: WorkstreamStatus) => ({
      id: 'st:' + s,
      label: WORKSTREAM_STATUS_META[s].label,
      icon: LucideCircleDot,
      status: s as AnyStatus,
      entity: 'workstream' as StatusEntity,
      hint: s === ws.status ? (ws.statusOverride ? 'Pinned' : 'Current') : undefined,
      run: () => {
        if (s !== ws.statusOverride) void this.store.updateWorkstream(ws.id, { statusOverride: s });
        done();
      },
    }));
    if (ws.statusOverride) {
      out.unshift({
        id: 'st:clear',
        label: 'Clear override (use derived status)',
        icon: LucideEraser,
        hint: WORKSTREAM_STATUS_META[ws.derivedStatus]?.label,
        run: () => {
          void this.store.updateWorkstream(ws.id, { statusOverride: null });
          done();
        },
      });
    }
    return out;
  });

  // ─────────────────────────── static commands ───────────────────────────

  protected readonly navCommands = computed<Cmd[]>(() => {
    const slug = this.slug();
    const go =
      (...path: string[]) =>
      () =>
        void this.router.navigate(['/', slug, ...path]);
    const nav = ALL_NAV;
    const out: Cmd[] = nav.map((n) => ({
      id: 'nav:' + n.segment,
      label: n.label,
      keywords:
        'go to ' + (n.segment === 'repositories' ? 'repository repositories repo git ' : '') + (n.keywords ?? ''),
      icon: n.icon,
      keys: n.keys,
      run: go(n.segment),
    }));
    // Inbox tabs, and the old names of the two pages it replaced.
    const inboxTabs: [string, string, string, string][] = [
      ['needs-you', 'Inbox: needs you', 'attention questions reviews blockers', 'g a'],
      ['updates', 'Inbox: updates', 'notifications unread mentions comments assigned', 'g n'],
      ['later', 'Inbox: snoozed and dismissed', 'attention snoozed dismissed later', ''],
    ];
    for (const [tab, label, keywords, keys] of inboxTabs)
      out.push({
        id: 'nav:inbox:' + tab,
        label,
        keywords: 'go to ' + keywords,
        icon: LucideInbox,
        keys,
        run: () => void this.router.navigate(['/', slug, 'inbox'], { queryParams: { tab } }),
      });
    const extra: [string, string, LucideIcon, string][] = [
      ['teams', 'Teams', LucideUsers, 'g t'],
      ['views', 'Views', LucideLayers, 'g v'],
      ['activity', 'Activity', LucideActivity, 'g e'],
    ];
    for (const [segment, label, icon, keys] of extra) {
      if (!nav.some((n) => n.segment === segment))
        out.push({ id: 'nav:' + segment, label, keywords: 'go to', icon, keys, run: go(segment) });
    }
    for (const t of this.store.teams()) {
      out.push({
        id: 'team:' + t.id,
        label: `Team ${t.name}`,
        keywords: `go to ${t.key}`,
        icon: LucideUsers,
        run: go('teams', t.key),
      });
    }
    for (const v of this.store.views()) {
      out.push({
        id: 'view:' + v.id,
        label: `View ${v.name}`,
        keywords: 'go to',
        icon: LucideLayers,
        run: go('views', v.id),
      });
    }
    for (const s of SETTINGS_SECTIONS) {
      out.push({
        id: 'settings:' + s.id,
        label: `Settings › ${s.label}`,
        keywords: `preferences ${s.keywords ?? ''}`,
        icon: s.id === 'profile' ? LucideSettings : s.icon,
        keys: s.id === 'profile' ? 'g s' : undefined,
        run: go('settings', s.id),
      });
    }
    return out;
  });

  protected readonly actionCommands = computed<Cmd[]>(() => {
    const create = (kind: CreateKind) => () => this.ui.openCreate(kind);
    const out: Cmd[] = [];
    if (this.store.allowed('createIssues'))
      out.push({
        id: 'new:issue',
        label: 'Create issue',
        keywords: 'new bug feature incident report',
        icon: LucidePlus,
        run: create('issue'),
      });
    if (this.store.allowed('createWorkstreams'))
      out.push({
        id: 'new:workstream',
        label: 'Create workstream',
        keywords: 'new',
        icon: LucidePlus,
        keys: 'c',
        run: create('workstream'),
      });
    if (this.store.can('member'))
      out.push({
        id: 'new:decision',
        label: 'Create decision',
        keywords: 'new adr',
        icon: LucidePlus,
        run: create('decision'),
      });
    if (this.store.can('member'))
      out.push({
        id: 'new:document',
        label: 'Create document',
        keywords: 'new doc write note spec plan markdown page',
        icon: LucideFilePlus,
        run: () => void this.documents.createAndOpen(),
      });
    out.push({
      id: 'docs:search',
      label: 'Search documents',
      keywords: 'find docs notes specs plans text',
      icon: LucideFileText,
      run: () => void this.router.navigate(['/', this.slug(), 'documents'], { queryParams: { focus: 'search' } }),
    });
    if (this.store.allowed('manageCustomers')) {
      const here = this.favorites.current();
      out.push(
        {
          id: 'new:customer',
          label: 'Create customer',
          keywords: 'new company account add',
          icon: LucideBuilding2,
          run: () => this.ui.openCustomerDialog({ kind: 'customer' }),
        },
        {
          id: 'new:customer-request',
          label: here?.type === 'issue' ? 'Add customer request to this issue' : here?.type === 'project' ? 'Add customer request to this project' : 'Add customer request',
          keywords: 'new customer asked feedback need demand',
          icon: LucideBuilding2,
          run: () =>
            this.ui.openCustomerDialog({
              kind: 'request',
              ...(here?.type === 'issue' ? { issueId: here.id } : {}),
              ...(here?.type === 'project' ? { projectId: here.id } : {}),
              ...(here?.type === 'customer' ? { customerId: here.id } : {}),
            }),
        },
      );
    }
    const page = this.favorites.current();
    if (page?.type === 'customer') {
      const following = this.customerSubs.isFollowing(page.id);
      out.push({
        id: 'customer:follow',
        label: following ? 'Stop following this customer' : 'Follow this customer',
        keywords: 'subscribe notifications bell',
        icon: LucideBell,
        run: () => void this.customerSubs.toggle(page.id),
      });
    }
    if (page) {
      const pinned = this.favorites.has(page.type, page.id);
      out.push({
        id: 'favorite:toggle',
        label: pinned ? 'Remove from favorites' : 'Add to favorites',
        keywords: 'star pin bookmark favourite',
        icon: LucideStar,
        run: () => void this.favorites.toggle(page.type, page.id),
      });
    }
    out.push(
      {
        id: 'search',
        label: 'Search everything',
        icon: LucideSearch,
        keys: '/',
        run: () => this.ui.openModal('search'),
      },
      {
        id: 'copy-url',
        label: 'Copy current URL',
        keywords: 'link share',
        icon: LucideCopy,
        run: () => void this.clipboard.copy(this.document.location.href, 'Link copied'),
      },
      {
        id: 'theme:toggle',
        label: 'Toggle theme',
        keywords: 'dark light mode appearance',
        icon: this.theme.isDark() ? LucideSun : LucideMoon,
        keys: 'mod+j',
        run: () => this.theme.toggle(),
      },
      {
        id: 'theme:light',
        label: 'Theme: Light',
        keywords: 'appearance',
        icon: LucideSun,
        run: () => this.theme.set('light'),
      },
      {
        id: 'theme:dark',
        label: 'Theme: Dark',
        keywords: 'appearance',
        icon: LucideMoon,
        run: () => this.theme.set('dark'),
      },
      {
        id: 'theme:system',
        label: 'Theme: Match system',
        keywords: 'appearance auto',
        icon: LucideMonitor,
        run: () => this.theme.set('system'),
      },
      {
        id: 'sidebar',
        label: 'Toggle sidebar',
        icon: LucidePanelLeft,
        keys: 'mod+b',
        run: () => this.ui.toggleSidebar(),
      },
      {
        id: 'shortcuts',
        label: 'Keyboard shortcuts',
        keywords: 'help keys',
        icon: LucideCircleHelp,
        keys: '?',
        run: () => this.ui.openModal('shortcuts'),
      },
    );
    for (const w of this.session.workspaces()) {
      if (w.slug === this.slug()) continue;
      out.push({
        id: 'ws:' + w.slug,
        label: `Switch workspace to ${w.name}`,
        keywords: w.slug,
        icon: LucideArrowLeftRight,
        run: () => void this.session.switchWorkspace(w.slug),
      });
    }
    out.push(
      {
        id: 'onboarding:show',
        label: 'Show setup checklist',
        keywords: 'get started onboarding first steps guide',
        icon: LucideListChecks,
        run: () => {
          this.onboarding.restore();
          void this.router.navigate(['/', this.slug(), 'overview']);
        },
      },
      {
        id: 'ws:new',
        label: 'Create workspace',
        icon: LucideBuilding2,
        run: () => void this.router.navigate(['/new-workspace']),
      },
      {
        id: 'logout',
        label: 'Log out',
        keywords: 'sign out',
        icon: LucideLogOut,
        run: () => void this.session.logout(),
      },
    );
    return out;
  });

  constructor() {
    effect(() => {
      const q = this.query();
      const scope = this.scope();
      untracked(() => {
        if (this.applyPrefix(q)) return;
        this.schedule(q.trim(), scope);
      });
    });
  }

  // ─────────────────────────── scope & keyboard ───────────────────────────

  /** `issue: foo` / `@maya` → switch scope and strip the prefix. Returns true when handled. */
  private applyPrefix(raw: string): boolean {
    if (this.page() !== 'root') return false;
    let next: Scope | undefined;
    let rest = '';
    if (raw.startsWith('@')) {
      next = 'person';
      rest = raw.slice(1);
    } else {
      const m = /^([a-z]+):\s*(.*)$/i.exec(raw);
      if (m) {
        next = PREFIXES[m[1].toLowerCase()];
        rest = m[2];
      }
    }
    if (!next) return false;
    this.scope.set(next);
    this.setQuery(rest);
    return true;
  }

  private setQuery(value: string): void {
    this.query.set(value);
    // The command's `search` is a model; push the value so the input reflects it immediately.
    this.command()?.search.set(value);
  }

  protected setScope(s: Scope): void {
    this.scope.set(s);
    this.focusInput();
  }

  /** "a then b" keys are a chord, "mod+k" is one combination. */
  protected isChord(keys: string): boolean {
    return /\s/.test(keys) && !keys.includes('+');
  }

  /** Opens the assistant with what you typed as the draft (nothing is sent until you press send). */
  protected askAssistant(event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();
    if (!this.canAsk()) return;
    const text = this.query().trim();
    if (!this.assistant.busy()) this.assistant.newChat();
    if (text) this.assistant.draft.set(text);
    this.assistant.open.set(true);
    this.ui.closeModal();
  }

  protected onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Tab') {
      e.preventDefault();
      if (this.page() !== 'root') return;
      const i = SCOPES.findIndex((s) => s.id === this.scope());
      const n = SCOPES.length;
      this.scope.set(SCOPES[(i + (e.shiftKey ? -1 : 1) + n) % n].id);
      return;
    }
    if (e.key === 'Backspace' && !this.query()) {
      if (this.page() !== 'root') {
        e.preventDefault();
        this.backToRoot();
      } else if (this.scope() !== 'all') {
        e.preventDefault();
        this.scope.set('all');
      }
      return;
    }
    if (e.key === 'Escape' && this.page() !== 'root') {
      // Keep the palette open: go back to the root page instead of closing.
      e.preventDefault();
      e.stopPropagation();
      this.backToRoot();
    }
  }

  private openStatusPage(): void {
    this.page.set('status');
    this.setQuery('');
    this.focusInput();
  }

  protected backToRoot(): void {
    this.page.set('root');
    this.setQuery('');
    this.focusInput();
  }

  private focusInput(): void {
    queueMicrotask(() => this.host.nativeElement.querySelector<HTMLInputElement>('input')?.focus());
  }

  private schedule(q: string, scope: Scope): void {
    clearTimeout(this.timer);
    const gen = ++this.gen;
    if (q.length < 2 || scope === 'person' || this.page() !== 'root') {
      this.remote.set(null);
      this.loading.set(false);
      return;
    }
    this.loading.set(true);
    this.timer = setTimeout(async () => {
      try {
        const types = scope === 'all' ? undefined : [scope as HitType];
        const hits = await this.searchSvc.remote(q, scope === 'all' ? 24 : 40, types);
        if (gen === this.gen) this.remote.set({ q, scope, hits });
      } catch {
        if (gen === this.gen) this.remote.set(null); // offline / endpoint missing: local results stay
      } finally {
        if (gen === this.gen) this.loading.set(false);
      }
    }, 180);
  }

  // ─────────────────────────── rendering helpers ───────────────────────────

  protected iconFor(h: PanelItem): LucideIcon {
    return HIT_ICON[h.type];
  }

  protected visual(h: PanelItem): Visual {
    const s = this.store;
    switch (h.type) {
      case 'workstream': {
        const w = s.workstreamById().get(h.id);
        if (w) return { kind: 'status', status: w.status, entity: 'workstream' };
        break;
      }
      case 'decision': {
        const d = s.decisionById().get(h.id);
        if (d) return { kind: 'status', status: d.status };
        break;
      }
      case 'issue': {
        const i = s.issueById().get(h.id);
        if (i) return { kind: 'status', status: i.status, entity: 'issue' };
        break;
      }
      case 'customer':
        break;
      case 'artifact': {
        const a = s.artifactById().get(h.id);
        if (a) return { kind: 'artifact', status: a.state, artifactKind: a.kind };
        break;
      }
      case 'person':
        return { kind: 'avatar' };
      case 'team': {
        const t = s.teamById().get(h.id);
        if (t) return { kind: 'team', color: t.color };
        break;
      }
      case 'repository': {
        const r = s.getRepository(h.id);
        if (r) return { kind: 'repo', provider: r.provider };
        break;
      }
      case 'project': {
        const p = s.getProject(h.id);
        if (p) return { kind: 'project', project: p };
        break;
      }
    }
    return { kind: 'icon' };
  }

  protected exec(c: Cmd): void {
    const before = this.ui.modal();
    const page = this.page();
    c.run();
    // Nested pages and create / search / shortcuts manage the modal themselves; otherwise close.
    if (this.page() !== page) return;
    if (this.ui.modal() === before) this.ui.closeModal();
  }

  protected open(h: PanelItem): void {
    if (h.type === 'person') {
      if (h.subtitle) void this.clipboard.copy(h.subtitle, 'Email copied');
      this.ui.closeModal();
      return;
    }
    const slug = this.slug();
    if (!slug) return;
    const hit: SearchHit = {
      type: h.type,
      id: h.id,
      key: h.key,
      title: h.title,
      workstreamKey: h.workstreamKey,
    };
    this.recents.push(hit);
    this.ui.closeModal();
    void this.router.navigate(['/', slug, ...this.searchSvc.path(hit)], {
      queryParams: this.searchSvc.queryParams(hit),
    });
  }
}
