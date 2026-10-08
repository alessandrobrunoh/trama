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
} from '@lucide/angular';
import { BrnCommand, BrnCommandInput } from '@spartan-ng/brain/command';
import { HlmCommandImports } from '@spartan-ng/helm/command';
import type { ArtifactKind, IssueStatus, WorkstreamStatus } from '../../core/contracts/domain';
import { ISSUE_STATUSES, ISSUE_STATUS_META, WORKSTREAM_STATUSES, WORKSTREAM_STATUS_META } from '../../core/meta';
import { BranchNames } from '../../core/branch-prefs';
import { Clipboard } from '../../core/notify/notifier';
import { AiActions } from '../ai-actions/ai-actions.service';
import { AssistantStore } from '../../core/ai/assistant.store';
import { SessionStore } from '../../core/session/session.store';
import { FavoritesStore } from '../../core/stores/favorites.store';
import { NablaStore } from '../../core/stores/nabla.store';
import { UiStore, type CreateKind } from '../../core/stores/ui.store';
import { ThemeService } from '../../core/theme';
import { MAIN_NAV, PERSONAL_NAV } from '../../layout/nav';
import { ActorAvatar } from '../../shared/actor-avatar';
import { ArtifactIcon } from '../../shared/artifact';
import { Kbd } from '../../shared/kbd';
import { ProviderIcon } from '../../shared/provider-icon';
import { StatusIcon, type AnyStatus, type StatusEntity } from '../../shared/status';
import { fuzzyScore } from './fuzzy';
import { RecentItems } from './recent.service';
import { HIT_LABEL, HIT_ORDER, SearchService, type HitType, type SearchHit } from './search.service';

interface Cmd {
  id: string;
  label: string;
  /** Extra words that make the command findable. */
  keywords?: string;
  icon: LucideIcon;
  keys?: string;
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
  kind: 'status' | 'artifact' | 'avatar' | 'team' | 'repo' | 'icon';
  status?: any;
  entity?: StatusEntity;
  artifactKind?: ArtifactKind;
  color?: string;
  provider?: string;
}

/** Palette scopes (chips). `all` mixes everything plus Go to / Actions. */
type Scope = 'all' | 'issue' | 'workstream' | 'decision' | 'repository' | 'person' | 'team';

const SCOPES: { id: Scope; label: string; placeholder: string }[] = [
  { id: 'all', label: 'All', placeholder: '' },
  { id: 'issue', label: 'Issues', placeholder: 'Search issues…' },
  { id: 'workstream', label: 'Workstreams', placeholder: 'Search workstreams…' },
  { id: 'decision', label: 'Decisions', placeholder: 'Search decisions…' },
  { id: 'repository', label: 'Projects', placeholder: 'Search projects…' },
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
  decision: 'decision',
  decisions: 'decision',
  adr: 'decision',
  project: 'repository',
  projects: 'repository',
  repo: 'repository',
  people: 'person',
  person: 'person',
  user: 'person',
  team: 'team',
  teams: 'team',
};

const HIT_ICON: Record<ItemType, LucideIcon> = {
  workstream: LucideWorkflow,
  decision: LucideScale,
  issue: LucideInbox,
  artifact: LucideGitPullRequest,
  repository: LucideFolderGit2,
  team: LucideUsers,
  person: LucideUserRound,
};

const SETTINGS_SECTIONS: { id: string; label: string; icon: LucideIcon; keywords?: string }[] = [
  { id: 'profile', label: 'Profile', icon: LucideUserRound },
  { id: 'preferences', label: 'Preferences', icon: LucideSlidersHorizontal, keywords: 'home font cursor links motion comments enter' },
  { id: 'notifications', label: 'Notifications', icon: LucideBell, keywords: 'email alerts inbox' },
  { id: 'appearance', label: 'Appearance', icon: LucideSunMoon, keywords: 'theme dark light' },
  { id: 'workspace', label: 'Workspace', icon: LucideBuilding2 },
  { id: 'members', label: 'Members & roles', icon: LucideUsers, keywords: 'people invite' },
  { id: 'teams', label: 'Teams', icon: LucideUsers },
  { id: 'agents', label: 'Agents', icon: LucideBot, keywords: 'claude codex cursor delta' },
  { id: 'tokens', label: 'API tokens', icon: LucideKeyRound, keywords: 'keys secret mcp' },
  { id: 'integrations', label: 'Integrations', icon: LucidePlug, keywords: 'github gitlab delta webhook' },
  { id: 'shortcuts', label: 'Keyboard shortcuts', icon: LucideKeyboard },
];

/** Static items are fuzzy-filtered by the command; result items (value starts with \u0001) always show. */
export function commandFilter(value: string, search: string): boolean {
  return value.startsWith('\u0001') || fuzzyScore(value, search) > 0;
}

const byUpdated = <T extends { updatedAt: string }>(a: T, b: T) => (a.updatedAt < b.updatedAt ? 1 : -1);

/**
 * Shared body of the ⌘K palette and the `/` search dialog (Linear-style).
 *  - scope chips (All · Issues · Workstreams · Decisions · Projects · People · Teams); Tab cycles,
 *    prefixes like `issue:` / `@` switch scope, Backspace on an empty query goes back to All
 *  - `palette`: context actions for the open issue/workstream, recent items, Go to, Actions, live results
 *  - `search`:  recent items and results grouped by type
 * Results come from `GET /search` (debounced) and fall back to a client-side fuzzy search over the store.
 */
@Component({
  selector: 'app-command-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmCommandImports, LucideDynamicIcon, NgTemplateOutlet, StatusIcon, ArtifactIcon, ActorAvatar, ProviderIcon, Kbd, BrnCommandInput],
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
          <span class="flex size-3.5 shrink-0 items-center justify-center"><span class="size-2.5 rounded-full" [style.background]="v.color"></span></span>
        }
        @case ('repo') {
          <app-provider-icon [provider]="$any(v.provider)" [size]="14" />
        }
        @default {
          <svg [lucideIcon]="iconFor(h)" [size]="14" class="text-muted-foreground shrink-0"></svg>
        }
      }
    </ng-template>

    <hlm-command class="h-[min(40rem,78svh)]" [filter]="filter" [(search)]="query">
      <div class="flex shrink-0 items-center gap-3 px-5 pt-4.5 pb-3">
        <input
          brnCommandInput
          data-slot="command-input"
          class="placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-base outline-hidden"
          [placeholder]="placeholder()"
          [attr.aria-label]="placeholder()"
          (keydown.meta.enter)="askAssistant($event)"
          (keydown.control.enter)="askAssistant($event)"
        />
        @if (canAsk()) {
          <button
            type="button"
            class="text-muted-foreground hover:text-foreground flex shrink-0 items-center gap-2 text-[13px] max-sm:hidden"
            (mousedown)="$event.preventDefault()"
            (click)="askAssistant()"
          >
            Ask Trama <app-kbd keys="mod+enter" />
          </button>
        }
      </div>

      @if (showScopes()) {
      <div class="scrollbar-none flex shrink-0 items-center gap-1 overflow-x-auto px-3 pb-1.5" role="tablist" aria-label="Search scope">
        @if (page() === 'status' && context(); as ctx) {
          <button type="button" class="text-muted-foreground hover:text-foreground flex h-6 shrink-0 items-center gap-1 rounded-md border px-2 text-xs" (click)="backToRoot()">
            <span class="font-mono">{{ ctx.key }}</span>
          </button>
          <svg [lucideIcon]="chevron" [size]="12" class="text-muted-foreground shrink-0"></svg>
          <span class="bg-accent flex h-6 shrink-0 items-center rounded-md px-2 text-xs font-medium">Change status</span>
        } @else {
          @for (s of scopes; track s.id) {
            <button
              type="button"
              role="tab"
              class="flex h-6 shrink-0 items-center rounded-md border px-2 text-xs transition-colors"
              [class]="scope() === s.id ? 'bg-accent text-foreground border-border-strong' : 'text-muted-foreground hover:text-foreground hover:bg-accent/60 border-transparent'"
              [attr.aria-selected]="scope() === s.id"
              (mousedown)="$event.preventDefault()"
              (click)="setScope(s.id)"
            >{{ s.label }}</button>
          }
        }
      </div>
      }

      <div *hlmCommandEmptyState hlmCommandEmpty>
        @if (loading()) {
          Searching…
        } @else if (query().trim()) {
          No results for “{{ query().trim() }}”.
        } @else {
          Nothing here yet.
        }
      </div>

      <hlm-command-list
        class="max-h-none flex-1 px-1 pb-1 [&_[data-slot=command-group-label]]:px-3.5 [&_[data-slot=command-group-label]]:pt-3 [&_[data-slot=command-group-label]]:pb-1.5 [&_[data-slot=command-group-label]]:text-[13px] [&_[data-slot=command-item]]:min-h-11 [&_[data-slot=command-item]]:gap-3 [&_[data-slot=command-item]]:px-3.5 [&_[data-slot=command-item]]:text-[15px]"
      >
        @if (page() === 'status') {
          <hlm-command-group>
            <hlm-command-group-label>Status</hlm-command-group-label>
            @for (c of statusCommands(); track c.id) {
              <button hlmCommandItem [value]="'status ' + c.label" (selected)="exec(c)">
                @if (c.status) {
                  <app-status-icon [status]="c.status" [entity]="c.entity ?? 'auto'" />
                } @else {
                  <svg [lucideIcon]="c.icon" [size]="14" class="text-muted-foreground shrink-0"></svg>
                }
                <span class="min-w-0 flex-1 truncate">{{ c.label }}</span>
                @if (c.hint) {
                  <span class="text-muted-foreground shrink-0 text-xs">{{ c.hint }}</span>
                }
              </button>
            }
          </hlm-command-group>
        } @else {
          @if (contextCommands().length) {
            <hlm-command-group>
              <hlm-command-group-label>{{ contextLabel() }}</hlm-command-group-label>
              @for (c of contextCommands(); track c.id) {
                <button hlmCommandItem [value]="'context ' + c.label + ' ' + (c.keywords ?? '')" (selected)="exec(c)">
                  <svg [lucideIcon]="c.icon" [size]="14" class="text-muted-foreground shrink-0"></svg>
                  <span class="min-w-0 flex-1 truncate">{{ c.label }}</span>
                  @if (c.hint) {
                    <span class="text-muted-foreground shrink-0 font-mono text-xs">{{ c.hint }}</span>
                  }
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
                <button hlmCommandItem [value]="'\\u0001' + g.id + ':' + h.type + ':' + h.id" (selected)="open(h)">
                  <ng-container [ngTemplateOutlet]="glyph" [ngTemplateOutletContext]="{ $implicit: h }" />
                  @if (h.key) {
                    <span class="text-muted-foreground shrink-0 font-mono text-xs">{{ h.key }}</span>
                  }
                  <span class="min-w-0 flex-1 truncate">{{ h.title }}</span>
                  @if (h.type === 'person') {
                    <span class="text-muted-foreground max-w-[45%] shrink-0 truncate text-xs max-sm:hidden">{{ h.subtitle }}</span>
                    <span class="text-muted-foreground shrink-0 text-[11px] opacity-0 [[data-selected]_&]:opacity-100">Copy email</span>
                  } @else if (h.workstreamKey || h.subtitle) {
                    <span class="text-muted-foreground max-w-[40%] shrink-0 truncate font-mono text-xs max-sm:hidden">{{
                      h.workstreamKey ?? h.subtitle
                    }}</span>
                  }
                </button>
              }
            </hlm-command-group>
          }

          @if (mode() === 'palette' && scope() === 'all') {
            <hlm-command-group>
              <hlm-command-group-label>Actions</hlm-command-group-label>
              @for (c of actionCommands(); track c.id) {
                <button hlmCommandItem [value]="'action ' + c.label + ' ' + (c.keywords ?? '')" (selected)="exec(c)">
                  <svg [lucideIcon]="c.icon" [size]="14" class="text-muted-foreground shrink-0"></svg>
                  <span class="min-w-0 flex-1 truncate">{{ c.label }}</span>
                  @if (c.keys) {
                    <hlm-command-shortcut><app-kbd [keys]="c.keys" [chord]="isChord(c.keys)" /></hlm-command-shortcut>
                  }
                </button>
              }
            </hlm-command-group>
            <hlm-command-group>
              <hlm-command-group-label>Go to</hlm-command-group-label>
              @for (c of navCommands(); track c.id) {
                <button hlmCommandItem [value]="'go ' + c.label + ' ' + (c.keywords ?? '')" (selected)="exec(c)">
                  <svg [lucideIcon]="c.icon" [size]="14" class="text-muted-foreground shrink-0"></svg>
                  <span class="min-w-0 flex-1 truncate">{{ c.label }}</span>
                  @if (c.keys) {
                    <hlm-command-shortcut><app-kbd [keys]="c.keys" [chord]="isChord(c.keys)" /></hlm-command-shortcut>
                  }
                </button>
              }
            </hlm-command-group>
          } @else if (mode() === 'search' && scope() === 'all' && !isSearching() && !groups().length) {
            <div class="text-muted-foreground flex flex-col items-center gap-2 px-6 py-12 text-center text-sm">
              <svg [lucideIcon]="searchIcon" [size]="18" [strokeWidth]="1.5"></svg>
              <p>Search workstreams, issues, decisions, projects, people and teams.</p>
              <p class="text-xs">Tip: type <span class="font-mono">issue:</span>, <span class="font-mono">ws:</span> or <span class="font-mono">&#64;</span> to narrow.</p>
            </div>
          }
        }
      </hlm-command-list>

      <div class="text-muted-foreground flex h-8 shrink-0 items-center gap-3 border-t px-2.5 text-xs max-sm:hidden">
        <span class="flex items-center gap-1"><app-kbd keys="up down" /> navigate</span>
        <span class="flex items-center gap-1"><app-kbd keys="enter" /> open</span>
        @if (page() === 'root') {
          <span class="flex items-center gap-1"><app-kbd keys="tab" /> scope</span>
          <span class="flex items-center gap-1"><app-kbd keys="esc" /> close</span>
        } @else {
          <span class="flex items-center gap-1"><app-kbd keys="esc" /> back</span>
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
  private readonly session = inject(SessionStore);
  private readonly router = inject(Router);
  private readonly theme = inject(ThemeService);
  private readonly searchSvc = inject(SearchService);
  private readonly recents = inject(RecentItems);
  private readonly clipboard = inject(Clipboard);
  private readonly ai = inject(AiActions);
  private readonly assistant = inject(AssistantStore);
  private readonly branches = inject(BranchNames);
  private readonly document = inject(DOCUMENT);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly command = viewChild(BrnCommand);

  protected readonly filter = commandFilter;
  protected readonly scopes = SCOPES;
  protected readonly searchIcon = LucideSearch;
  protected readonly chevron = LucideChevronRight;

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
    return this.mode() === 'palette' ? 'Type a command or search…' : 'Search workstreams, issues, decisions…';
  });
  protected readonly isSearching = computed(() => this.query().trim().length > 0);
  /** The scope chips stay out of the way until you search or narrow the scope (the `/` dialog always shows them). */
  protected readonly showScopes = computed(
    () => this.mode() === 'search' || this.page() !== 'root' || this.isSearching() || this.scope() !== 'all',
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
        return [...s.issues()].sort(byUpdated).slice(0, 50).map((i) => ({ type: 'issue', id: i.id, key: i.key, title: i.title }));
      case 'workstream':
        return [...s.workstreams()]
          .sort(byUpdated)
          .slice(0, 50)
          .map((w) => ({ type: 'workstream', id: w.id, key: w.key, title: w.title }));
      case 'decision':
        return [...s.decisions()]
          .sort(byUpdated)
          .slice(0, 50)
          .map((d) => ({ type: 'decision', id: d.id, key: d.key, title: d.title, workstreamKey: d.originWorkstreamId ? wsKey(d.originWorkstreamId) : undefined }));
      case 'repository':
        return [...s.repositories()]
          .sort((a, b) => a.fullName.localeCompare(b.fullName))
          .map((r) => ({ type: 'repository', id: r.id, title: r.fullName, subtitle: r.defaultBranch }));
      case 'team':
        return [...s.teams()].sort((a, b) => a.name.localeCompare(b.name)).map((t) => ({ type: 'team', id: t.id, key: t.key, title: t.name }));
      default:
        return [];
    }
  });

  protected readonly groups = computed<ItemGroup[]>(() => {
    const scope = this.scope();
    const searching = this.isSearching();
    if (!searching) {
      if (scope === 'all') {
        const recent = this.recents.list().slice(0, 5);
        return recent.length ? [{ id: 'recent', label: 'Recent', items: recent }] : [];
      }
      const items = scope === 'person' ? this.people() : this.browse();
      const label = SCOPES.find((x) => x.id === scope)?.label ?? '';
      return items.length ? [{ id: 'browse', label, items }] : [];
    }
    const by = new Map<ItemType, PanelItem[]>();
    for (const h of this.hits()) by.set(h.type, [...(by.get(h.type) ?? []), h]);
    const out: ItemGroup[] = HIT_ORDER.filter((t) => by.has(t)).map((t) => ({ id: t, label: HIT_LABEL[t], items: by.get(t)! }));
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
      return issue ? { type: 'issue' as const, id: issue.id, key: issue.key, issue, ws: null } : null;
    }
    if (path[1] === 'workstreams') {
      const ws = this.store.getWorkstream(key);
      return ws ? { type: 'workstream' as const, id: ws.id, key: ws.key, issue: null, ws } : null;
    }
    return null;
  });

  protected readonly contextLabel = computed(() => {
    const c = this.context();
    return c ? `${c.type === 'issue' ? 'Issue' : 'Workstream'} ${c.key}` : '';
  });

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
        run: () => this.openStatusPage(),
      });
      const me = this.store.me()?.id;
      if (c.issue && me && c.issue.assigneeId !== me) {
        out.push({
          id: 'ctx:assign-me',
          label: 'Assign to me',
          keywords: 'assignee take',
          icon: LucideUserRoundCheck,
          run: () => void this.store.updateIssue(c.id, { assigneeId: me }),
        });
      }
    }
    if (this.ai.available()) {
      const ask = (kind: 'summarize' | 'triage' | 'improve' | 'update' | 'breakdown') => () => this.ai.request(kind, c.id);
      if (c.issue) {
        out.push({ id: 'ctx:ai-summarize', label: 'AI: Summarize this issue', keywords: 'ai tldr summary explain', icon: LucideSparkles, run: ask('summarize') });
        if (this.ai.canEditIssue(c.issue)) {
          out.push(
            { id: 'ctx:ai-triage', label: 'AI: Suggest properties', keywords: 'ai triage priority estimate type workstream', icon: LucideSparkles, run: ask('triage') },
            { id: 'ctx:ai-improve', label: 'AI: Improve description', keywords: 'ai rewrite clearer title', icon: LucideSparkles, run: ask('improve') },
          );
        }
      } else if (c.ws) {
        out.push({ id: 'ctx:ai-update', label: 'AI: Draft status update', keywords: 'ai report stakeholder summary', icon: LucideSparkles, run: ask('update') });
        if (this.ai.canEditWorkstream(c.ws)) {
          out.push({ id: 'ctx:ai-breakdown', label: 'AI: Break down into issues', keywords: 'ai plan split tasks', icon: LucideSparkles, run: ask('breakdown') });
        }
      }
    }
    out.push(
      { id: 'ctx:copy-key', label: `Copy ${c.type} key`, keywords: 'id', icon: LucideHash, hint: c.key, run: () => void this.clipboard.copy(c.key, 'Key copied') },
      {
        id: 'ctx:copy-branch',
        label: 'Copy git branch name',
        keywords: 'git branch checkout',
        icon: LucideGitBranch,
        run: () => void this.branches.copy(c.key, (c.issue ?? c.ws)!.title),
      },
      {
        id: 'ctx:copy-link',
        label: `Copy ${c.type} link`,
        keywords: 'url share',
        icon: LucideLink,
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
    const go = (...path: string[]) => () => void this.router.navigate(['/', slug, ...path]);
    const nav = [...PERSONAL_NAV, ...MAIN_NAV];
    const out: Cmd[] = nav.map((n) => ({
      id: 'nav:' + n.segment,
      label: `Go to ${n.label}`,
      keywords: n.segment === 'projects' ? 'repository repositories repo git' : undefined,
      icon: n.icon,
      keys: n.keys,
      run: go(n.segment),
    }));
    const extra: [string, string, LucideIcon, string][] = [
      ['teams', 'Teams', LucideUsers, 'g t'],
      ['views', 'Views', LucideLayers, 'g v'],
      ['activity', 'Activity', LucideActivity, 'g e'],
    ];
    for (const [segment, label, icon, keys] of extra) {
      if (!nav.some((n) => n.segment === segment)) out.push({ id: 'nav:' + segment, label: `Go to ${label}`, icon, keys, run: go(segment) });
    }
    for (const t of this.store.teams()) {
      out.push({ id: 'team:' + t.id, label: `Go to team ${t.name}`, keywords: t.key, icon: LucideUsers, run: go('teams', t.key) });
    }
    for (const v of this.store.views()) {
      out.push({ id: 'view:' + v.id, label: `Go to view ${v.name}`, icon: LucideLayers, run: go('views', v.id) });
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
      out.push({ id: 'new:issue', label: 'Create issue', keywords: 'new bug feature incident report', icon: LucidePlus, run: create('issue') });
    if (this.store.allowed('createWorkstreams'))
      out.push({ id: 'new:workstream', label: 'Create workstream', keywords: 'new', icon: LucidePlus, keys: 'c', run: create('workstream') });
    if (this.store.can('member'))
      out.push({ id: 'new:decision', label: 'Create decision', keywords: 'new adr', icon: LucidePlus, run: create('decision') });
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
      { id: 'search', label: 'Search everything', icon: LucideSearch, keys: '/', run: () => this.ui.openModal('search') },
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
      { id: 'theme:light', label: 'Theme: Light', keywords: 'appearance', icon: LucideSun, run: () => this.theme.set('light') },
      { id: 'theme:dark', label: 'Theme: Dark', keywords: 'appearance', icon: LucideMoon, run: () => this.theme.set('dark') },
      { id: 'theme:system', label: 'Theme: Match system', keywords: 'appearance auto', icon: LucideMonitor, run: () => this.theme.set('system') },
      { id: 'sidebar', label: 'Toggle sidebar', icon: LucidePanelLeft, keys: 'mod+b', run: () => this.ui.toggleSidebar() },
      { id: 'shortcuts', label: 'Keyboard shortcuts', keywords: 'help keys', icon: LucideCircleHelp, keys: '?', run: () => this.ui.openModal('shortcuts') },
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
      { id: 'ws:new', label: 'Create workspace', icon: LucideBuilding2, run: () => void this.router.navigate(['/new-workspace']) },
      { id: 'logout', label: 'Log out', keywords: 'sign out', icon: LucideLogOut, run: () => void this.session.logout() },
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
    const hit: SearchHit = { type: h.type, id: h.id, key: h.key, title: h.title, workstreamKey: h.workstreamKey };
    this.recents.push(hit);
    this.ui.closeModal();
    void this.router.navigate(['/', slug, ...this.searchSvc.path(hit)], { queryParams: this.searchSvc.queryParams(hit) });
  }
}
