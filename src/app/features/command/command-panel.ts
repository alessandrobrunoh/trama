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
  LucideGitBranch,
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
  LucidePlus,
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
  type LucideIcon,
  LucideBox,
} from '@lucide/angular';
import { BrnCommand, BrnCommandInput } from '@spartan-ng/brain/command';
import { HlmCommandImports } from '@spartan-ng/helm/command';
import type {
  IssueStatus,
  Project,
} from '../../core/contracts/domain';
import {
  ISSUE_STATUSES,
  ISSUE_STATUS_META,
} from '../../core/meta';
import { BranchNames } from '../../core/branch-prefs';
import { Clipboard } from '../../core/notify/notifier';
import { AiActions } from '../ai-actions/ai-actions.service';
import { AssistantStore } from '../../core/ai/assistant.store';
import { SessionStore } from '../../core/session/session.store';
import { FavoritesStore } from '../../core/stores/favorites.store';
import { TramaStore } from '../../core/stores/trama.store';
import { UiStore, type CreateKind } from '../../core/stores/ui.store';
import { ThemeService } from '../../core/theme';
import { ALL_NAV, guestMayOpen, navForRole } from '../../layout/nav';
import { guestMayOpenSettings } from '../settings/settings-nav';
import { OnboardingStore } from '../../core/stores/onboarding.store';
import { ActorAvatar } from '../../shared/actor-avatar';
import { Kbd } from '../../shared/kbd';
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
}
interface ItemGroup {
  id: string;
  label: string;
  items: PanelItem[];
}

interface Visual {
  kind: 'status' | 'avatar' | 'project' | 'icon';
  status?: any;
  project?: Project;
  entity?: StatusEntity;
  color?: string;
  provider?: string;
}

/** Palette scopes (chips). `all` mixes everything plus Go to / Actions. */
type Scope = 'all' | 'issue' | 'project' | 'person';

const SCOPES: { id: Scope; label: string; placeholder: string }[] = [
  { id: 'all', label: 'All', placeholder: '' },
  { id: 'issue', label: 'Tasks', placeholder: 'Search tasks…' },
  { id: 'project', label: 'Projects', placeholder: 'Search projects…' },
  { id: 'person', label: 'People', placeholder: 'Search people…' },
];

/** Typed prefixes that switch scope ("issue:", "@", …). */
const PREFIXES: Record<string, Scope> = {
  issue: 'issue',
  issues: 'issue',
  is: 'issue',
  bug: 'issue',
  project: 'project',
  projects: 'project',
  task: 'issue',
  tasks: 'issue',
  people: 'person',
  person: 'person',
  user: 'person',
};

const HIT_ICON: Record<ItemType, LucideIcon> = {
  project: LucideBox,
  issue: LucideInbox,
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
  { id: 'agents', label: 'Agents', icon: LucideBot, keywords: 'claude codex cursor delta' },
  { id: 'tokens', label: 'API tokens', icon: LucideKeyRound, keywords: 'keys secret mcp' },
  {
    id: 'integrations',
    label: 'Integrations',
    icon: LucidePlug,
    keywords: 'github gitlab delta webhook',
  },
  {
    id: 'my-integrations',
    label: 'My integrations',
    icon: LucidePlug,
    keywords: 'personal accounts connections github gitlab',
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
 * Floating command surface (v3 · 14): 640px on desktop, its top edge at ~15.5% of the viewport (140px at 900).
 * Height comes from the panel, which grows with its rows up to a cap.
 */
export const COMMAND_DIALOG_CLASS =
  // Widths use viewport units: the CDK pane shrink-wraps its content, so a `%` width collapses to the content width.
  // Pinned to the viewport (frame 01: top 140 of 900) so the panel stays put while the list grows.
  'fixed top-[min(12vh,5rem)] sm:top-[15.5svh] left-[max(0.75rem,calc(50vw-16rem))] sm:left-[max(1rem,calc(50vw-320px))] w-[min(32rem,calc(100vw-1.5rem))] sm:w-[min(640px,calc(100vw-2rem))] max-w-none sm:max-w-none mx-0 translate-y-0 gap-0 overflow-hidden rounded-lg p-0 duration-150 data-open:slide-in-from-top-2 data-closed:slide-out-to-top-2';

/**
 * Shared body of the ⌘K palette and the `/` search dialog.
 *  - scope chips (All · Issues · Projects · People); Tab cycles,
 *    prefixes like `issue:` / `@` switch scope, Backspace on an empty query goes back to All
 *  - `palette`: context actions for the open issue, recent items, Go to, Actions, live results
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
    ActorAvatar,
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
        @case ('avatar') {
          <app-actor-avatar [actor]="{ type: 'user', id: h.id }" [size]="16" />
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
          [size]="14"
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
        <span class="text-faint shrink-0 font-mono text-[10.5px]">{{ c.hint }}</span>
      }
    </ng-template>

    <hlm-command
      class="h-auto max-h-[min(34rem,78svh)]"
      [filter]="filter"
      [(search)]="query"
    >
      <div class="shrink-0">
        <div class="border-border flex h-[51.5px] items-center gap-3 border-b px-[18px] max-md:h-14">
          @if (mode() === 'palette' && context(); as ctx) {
            <button
              type="button"
              class="bg-secondary border-border text-muted-foreground hover:text-foreground flex h-6 shrink-0 items-center gap-1.5 border px-2 font-mono text-[11px] transition-colors"
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
            class="placeholder:text-faint caret-primary min-w-0 flex-1 bg-transparent text-[16px] outline-hidden"
            [placeholder]="placeholder()"
            [attr.aria-label]="placeholder()"
            enterkeyhint="search"
            autocomplete="off"
            autocapitalize="off"
            autocorrect="off"
            spellcheck="false"
            (keydown.meta.enter)="askAssistant($event)"
            (keydown.control.enter)="askAssistant($event)"
          />
          <button
            type="button"
            class="text-primary -mr-2 flex h-11 shrink-0 items-center px-3 text-base md:hidden"
            (mousedown)="$event.preventDefault()"
            (click)="ui.closeModal()"
          >
            Cancel
          </button>
          @if (canAsk()) {
            <button
              type="button"
              class="text-muted-foreground hover:bg-hover hover:text-foreground flex shrink-0 items-center gap-1.5 px-2 py-1 font-mono text-[11px] transition-colors max-sm:hidden"
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
          <button
            type="button"
            class="bg-secondary border-border text-muted-foreground hover:text-foreground shrink-0 border px-[5px] py-px font-mono text-[10.5px] leading-[14px] max-md:hidden"
            aria-label="Close"
            (mousedown)="$event.preventDefault()"
            (click)="ui.closeModal()"
          >
            esc
          </button>
        </div>

        @if (showScopes()) {
          <div
            class="scrollbar-none border-border flex items-center gap-1.5 overflow-x-auto border-b px-[18px] py-2"
            role="tablist"
            aria-label="Search scope"
          >
            @for (s of scopes; track s.id) {
              <button
                type="button"
                role="tab"
                class="flex h-[22px] shrink-0 items-center border px-2.5 font-mono text-[11px] transition-colors"
                [class]="
                  scope() === s.id
                    ? 'bg-secondary border-border text-foreground'
                    : 'text-muted-foreground hover:text-foreground border-transparent'
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
        class="max-h-[min(26rem,calc(78svh-7.5rem))] overscroll-contain [&_[data-slot=command-item][data-selected]]:bg-hover [&_[data-slot=command-item][data-selected]]:shadow-[inset_2px_0_0_var(--primary)]"
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
                  <!-- v3: title, then its key right after it, hints on the right -->
                  <span class="min-w-0 truncate">{{ h.title }}</span>
                  @if (h.key) {
                    <span class="text-faint shrink-0 font-mono text-[10.5px]">{{ h.key }}</span>
                  }
                  <span class="min-w-0 flex-1"></span>
                  @if (h.type === 'person') {
                    <span
                      class="text-faint max-w-[45%] shrink-0 truncate font-mono text-[10.5px] max-sm:hidden"
                      >{{ h.subtitle }}</span
                    >
                    <span
                      class="text-faint shrink-0 font-mono text-[10.5px] opacity-0 [[data-selected]_&]:opacity-100"
                      >Copy email</span
                    >
                  } @else {
                    @if (h.subtitle) {
                      <span
                        class="text-faint max-w-[40%] shrink-0 truncate font-mono text-[10.5px] max-sm:hidden"
                        >{{ h.subtitle }}</span
                      >
                    }
                    <span
                      class="text-faint shrink-0 font-mono text-[10.5px] opacity-0 max-sm:hidden [[data-selected]_&]:opacity-100"
                      aria-hidden="true"
                      >↵</span
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
              <p>Search tasks, projects and people.</p>
              <p class="text-xs">
                Tip: type <span class="font-mono">task:</span>,
                <span class="font-mono">ws:</span> or <span class="font-mono">&#64;</span> to
                narrow.
              </p>
            </div>
          }
        }
      </hlm-command-list>

      <!-- v3 foot: 33px, hints in mono 10.5 faint (↑↓ navigate · ↵ open …), what is searched on the right -->
      <div
        class="border-border text-faint flex h-[33.5px] shrink-0 items-center gap-4 border-t px-[18px] font-mono text-[10.5px] max-sm:hidden"
      >
        <span>↑↓ navigate</span>
        <span>↵ open</span>
        @if (page() === 'root') {
          <span>tab scope</span>
        } @else {
          <span>esc back</span>
        }
        <span class="flex-1"></span>
        <span>{{ loading() ? 'Searching…' : 'Searches tasks, projects and people' }}</span>
      </div>
    </hlm-command>
  `,
})
export class CommandPanel {
  readonly mode = input<'palette' | 'search'>('palette');

  protected readonly ui = inject(UiStore);
  private readonly store = inject(TramaStore);
  private readonly favorites = inject(FavoritesStore);
  private readonly session = inject(SessionStore);
  private readonly router = inject(Router);
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
      : 'Search tasks and projects…';
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
    switch (this.scope()) {
      case 'issue':
        return [...s.issues()]
          .sort(byUpdated)
          .slice(0, 50)
          .map((i) => ({ type: 'issue', id: i.id, key: i.key, title: i.title }));
      case 'project':
        return [...s.projects()]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((p) => ({ type: 'project', id: p.id, title: p.name, subtitle: p.summary }));
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

  // ─────────────────────────── context (open issue) ───────────────────────────

  /** The issue whose page is open, from the router URL. */
  protected readonly context = computed(() => {
    const path = this.router.url.split(/[?#]/)[0].split('/').filter(Boolean);
    if (path.length < 3) return null;
    const key = decodeURIComponent(path[2]);
    if (path[1] === 'tasks' || path[1] === 'issues') {
      const issue = this.store.getIssue(key);
      return issue
        ? { type: 'issue' as const, id: issue.id, key: issue.key, issue }
        : null;
    }
    return null;
  });

  protected readonly contextLabel = computed(() => {
    const c = this.context();
    return c ? 'Task actions' : '';
  });

  protected readonly contextIcon = computed(() => HIT_ICON.issue);

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
      const ask = (kind: 'summarize' | 'triage' | 'improve') => () =>
        this.ai.request(kind, c.id);
      if (c.issue) {
        out.push({
          id: 'ctx:ai-summarize',
          label: 'Summarize this task',
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
              keywords: 'ai triage priority estimate type',
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
      }
    }
    out.push(
      {
        id: 'ctx:copy-key',
        label: `Copy ${c.type} key`,
        keywords: 'id',
        icon: LucideHash,
        hint: c.key,
        keys: c.issue ? 'mod+shift+k' : undefined,
        run: () => void this.clipboard.copy(c.key, 'Key copied'),
      },
      {
        id: 'ctx:copy-branch',
        label: 'Copy git branch name',
        keywords: 'git branch checkout',
        icon: LucideGitBranch,
        keys: 'mod+shift+g',
        run: () => void this.branches.copy(c.key, c.issue.title),
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
    return [];
  });

  // ─────────────────────────── static commands ───────────────────────────

  protected readonly navCommands = computed<Cmd[]>(() => {
    const slug = this.slug();
    const go =
      (...path: string[]) =>
      () =>
        void this.router.navigate(['/', slug, ...path]);
    const guest = this.store.isGuest();
    const nav = navForRole(ALL_NAV, guest);
    const out: Cmd[] = nav.map((n) => ({
      id: 'nav:' + n.segment,
      label: n.label,
      keywords:
        'go to ' + (n.keywords ?? ''),
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
      ['views', 'Views', LucideLayers, 'g v'],
      ['activity', 'Activity', LucideActivity, 'g e'],
    ];
    for (const [segment, label, icon, keys] of extra) {
      if (guest && !guestMayOpen(segment)) continue;
      if (!nav.some((n) => n.segment === segment))
        out.push({ id: 'nav:' + segment, label, keywords: 'go to', icon, keys, run: go(segment) });
    }
    if (!guest)
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
      if (guest && !guestMayOpenSettings(s.id)) continue;
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
        label: 'Create task',
        keywords: 'new bug feature incident report',
        icon: LucidePlus,
        run: create('issue'),
      });
    if (this.store.can('member') && !this.store.isGuest())
      out.push({
        id: 'new:project',
        label: 'Create project',
        keywords: 'new project',
        icon: LucidePlus,
        run: create('project'),
      });
    const page = this.favorites.current();
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
        id: 'ask-trama',
        label: 'Ask Trama',
        keywords: 'assistant ai question chat records',
        icon: LucideSparkles,
        keys: 'mod+j',
        run: () => this.ui.askOpen.set(true),
      },
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
        keys: 'mod+shift+l',
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
          void this.router.navigate(['/', this.slug(), 'inbox']);
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
    // A guest has no assistant and no setup checklist (both are about the whole workspace).
    return this.store.isGuest() ? out.filter((c) => c.id !== 'ask-trama' && c.id !== 'onboarding:show') : out;
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
      case 'issue': {
        const i = s.issueById().get(h.id);
        if (i) return { kind: 'status', status: i.status, entity: 'issue' };
        break;
      }
      case 'person':
        return { kind: 'avatar' };
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
    };
    this.recents.push(hit);
    this.ui.closeModal();
    void this.router.navigate(['/', slug, ...this.searchSvc.path(hit)], {
      queryParams: this.searchSvc.queryParams(hit),
    });
  }
}
