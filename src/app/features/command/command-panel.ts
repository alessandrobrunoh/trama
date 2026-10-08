import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { Router } from '@angular/router';
import {
  LucideArrowLeftRight,
  LucideBot,
  LucideBuilding2,
  LucideCircleHelp,
  LucideDynamicIcon,
  LucideFolderGit2,
  LucideGitPullRequest,
  LucideInbox,
  LucideKeyRound,
  LucideKeyboard,
  LucideLayers,
  LucideLogOut,
  LucideMonitor,
  LucideMoon,
  LucidePanelLeft,
  LucidePlug,
  LucidePlus,
  LucideScale,
  LucideSearch,
  LucideSettings,
  LucideSun,
  LucideSunMoon,
  LucideTerminal,
  LucideUserRound,
  LucideUsers,
  LucideWorkflow,
  type LucideIcon,
} from '@lucide/angular';
import { HlmCommandImports } from '@spartan-ng/helm/command';
import { NablaStore } from '../../core/stores/nabla.store';
import { UiStore, type CreateKind } from '../../core/stores/ui.store';
import { SessionStore } from '../../core/session/session.store';
import { ThemeService } from '../../core/theme';
import { MAIN_NAV } from '../../layout/nav';
import { Kbd } from '../../shared/kbd';
import { StatusIcon } from '../../shared/status';
import { ArtifactIcon } from '../../shared/artifact';
import type { ArtifactKind } from '../../core/contracts/domain';
import { fuzzyScore } from './fuzzy';
import { RecentItems, type RecentItem } from './recent.service';
import { HIT_LABEL, HIT_ORDER, SearchService, type HitType, type SearchHit } from './search.service';

interface Cmd {
  id: string;
  label: string;
  /** Extra words that make the command findable. */
  keywords?: string;
  icon: LucideIcon;
  keys?: string;
  run: () => void;
}

interface Visual {
  kind: 'status' | 'artifact' | 'icon';
  status?: any;
  artifactKind?: ArtifactKind;
}

const HIT_ICON: Record<HitType, LucideIcon> = {
  workstream: LucideWorkflow,
  decision: LucideScale,
  issue: LucideInbox,
  artifact: LucideGitPullRequest,
  repository: LucideFolderGit2,
  team: LucideUsers,
};

const SETTINGS_SECTIONS: { id: string; label: string; icon: LucideIcon; keywords?: string }[] = [
  { id: 'profile', label: 'Profile', icon: LucideUserRound },
  { id: 'appearance', label: 'Appearance', icon: LucideSunMoon, keywords: 'theme dark light' },
  { id: 'workspace', label: 'Workspace', icon: LucideBuilding2 },
  { id: 'members', label: 'Members & roles', icon: LucideUsers, keywords: 'people invite' },
  { id: 'teams', label: 'Teams', icon: LucideUsers },
  { id: 'agents', label: 'Agents', icon: LucideBot, keywords: 'claude codex cursor delta' },
  { id: 'tokens', label: 'API tokens', icon: LucideKeyRound, keywords: 'keys secret mcp' },
  { id: 'integrations', label: 'Integrations', icon: LucidePlug, keywords: 'github gitlab delta webhook' },
  { id: 'shortcuts', label: 'Keyboard shortcuts', icon: LucideKeyboard },
];

/** Static items are fuzzy-filtered by the command; search results (value starts with \u0001) always show. */
export function commandFilter(value: string, search: string): boolean {
  return value.startsWith('\u0001') || fuzzyScore(value, search) > 0;
}

/**
 * Shared body of the ⌘K palette and the `/` search dialog.
 *  - `palette`: recent items, Go to (every screen, team, view, settings section), Actions, plus live search results
 *  - `search`:  recent items and search results grouped by type
 * Results come from `GET /search` (debounced) and fall back to a client-side fuzzy search over the store.
 */
@Component({
  selector: 'app-command-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmCommandImports, LucideDynamicIcon, StatusIcon, ArtifactIcon, Kbd],
  host: { class: 'block' },
  template: `
    <hlm-command class="h-[min(32rem,74svh)]" [filter]="filter" [(search)]="query">
      <hlm-command-input [placeholder]="placeholder()" />
      <div *hlmCommandEmptyState hlmCommandEmpty>
        @if (loading()) {
          Searching…
        } @else {
          No results for "{{ query().trim() }}".
        }
      </div>
      <hlm-command-list class="max-h-none flex-1">
        @if (isSearching()) {
          @for (g of resultGroups(); track g.type) {
            <hlm-command-group>
              <hlm-command-group-label>{{ g.label }}</hlm-command-group-label>
              @for (h of g.hits; track h.id) {
                <button hlmCommandItem [value]="'\\u0001' + h.type + h.id" (selected)="openHit(h)">
                  @switch (visual(h).kind) {
                    @case ('status') {
                      <app-status-icon [status]="visual(h).status!" />
                    }
                    @case ('artifact') {
                      <app-artifact-icon [kind]="visual(h).artifactKind!" [state]="visual(h).status" />
                    }
                    @default {
                      <svg [lucideIcon]="icons[h.type]" [size]="14" class="text-muted-foreground shrink-0"></svg>
                    }
                  }
                  @if (h.key) {
                    <span class="text-muted-foreground shrink-0 font-mono text-xs">{{ h.key }}</span>
                  }
                  <span class="min-w-0 flex-1 truncate">{{ h.title }}</span>
                  @if (h.workstreamKey || h.subtitle) {
                    <span class="text-muted-foreground max-w-[40%] shrink-0 truncate font-mono text-xs max-sm:hidden">{{
                      h.workstreamKey ?? h.subtitle
                    }}</span>
                  }
                </button>
              }
            </hlm-command-group>
          }
        } @else if (recent().length) {
          <hlm-command-group>
            <hlm-command-group-label>Recent</hlm-command-group-label>
            @for (r of recent(); track r.type + r.id) {
              <button hlmCommandItem [value]="'\\u0001recent' + r.type + r.id" (selected)="openHit(r)">
                @switch (visual(r).kind) {
                  @case ('status') {
                    <app-status-icon [status]="visual(r).status!" />
                  }
                  @case ('artifact') {
                    <app-artifact-icon [kind]="visual(r).artifactKind!" [state]="visual(r).status" />
                  }
                  @default {
                    <svg [lucideIcon]="icons[r.type]" [size]="14" class="text-muted-foreground shrink-0"></svg>
                  }
                }
                @if (r.key) {
                  <span class="text-muted-foreground shrink-0 font-mono text-xs">{{ r.key }}</span>
                }
                <span class="min-w-0 flex-1 truncate">{{ r.title }}</span>
              </button>
            }
          </hlm-command-group>
        }

        @if (mode() === 'palette') {
          <hlm-command-group>
            <hlm-command-group-label>Go to</hlm-command-group-label>
            @for (c of navCommands(); track c.id) {
              <button hlmCommandItem [value]="'go ' + c.label + ' ' + (c.keywords ?? '')" (selected)="exec(c)">
                <svg [lucideIcon]="c.icon" [size]="14" class="text-muted-foreground shrink-0"></svg>
                <span class="min-w-0 flex-1 truncate">{{ c.label }}</span>
                @if (c.keys) {
                  <hlm-command-shortcut><app-kbd [keys]="c.keys" /></hlm-command-shortcut>
                }
              </button>
            }
          </hlm-command-group>
          <hlm-command-group>
            <hlm-command-group-label>Actions</hlm-command-group-label>
            @for (c of actionCommands(); track c.id) {
              <button hlmCommandItem [value]="'action ' + c.label + ' ' + (c.keywords ?? '')" (selected)="exec(c)">
                <svg [lucideIcon]="c.icon" [size]="14" class="text-muted-foreground shrink-0"></svg>
                <span class="min-w-0 flex-1 truncate">{{ c.label }}</span>
                @if (c.keys) {
                  <hlm-command-shortcut><app-kbd [keys]="c.keys" /></hlm-command-shortcut>
                }
              </button>
            }
          </hlm-command-group>
        } @else if (!isSearching() && !recent().length) {
          <div class="text-muted-foreground flex flex-col items-center gap-2 px-6 py-12 text-center text-sm">
            <svg [lucideIcon]="searchIcon" [size]="18" [strokeWidth]="1.5"></svg>
            <p>Search workstreams, issues, decisions, artifacts and projects.</p>
          </div>
        }
      </hlm-command-list>
      <div class="text-muted-foreground flex h-8 shrink-0 items-center gap-3 border-t px-2.5 text-xs max-sm:hidden">
        <span class="flex items-center gap-1"><app-kbd keys="up down" /> navigate</span>
        <span class="flex items-center gap-1"><app-kbd keys="enter" /> open</span>
        <span class="flex items-center gap-1"><app-kbd keys="esc" /> close</span>
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
  private readonly session = inject(SessionStore);
  private readonly router = inject(Router);
  private readonly theme = inject(ThemeService);
  private readonly searchSvc = inject(SearchService);
  private readonly recents = inject(RecentItems);

  protected readonly filter = commandFilter;
  protected readonly icons = HIT_ICON;
  protected readonly searchIcon = LucideSearch;
  protected readonly query = signal('');
  protected readonly loading = signal(false);
  private readonly remote = signal<{ q: string; hits: SearchHit[] } | null>(null);
  private timer: ReturnType<typeof setTimeout> | undefined;
  private gen = 0;

  protected readonly placeholder = computed(() =>
    this.mode() === 'palette' ? 'Type a command or search…' : 'Search workstreams, issues, decisions…',
  );
  protected readonly isSearching = computed(() => this.query().trim().length > 0);
  protected readonly recent = computed<RecentItem[]>(() => this.recents.list().slice(0, 6));

  protected readonly hits = computed<SearchHit[]>(() => {
    const q = this.query().trim();
    if (!q) return [];
    const r = this.remote();
    if (r && r.q === q && r.hits.length) return r.hits;
    // Remote still pending / failed / empty: show what the snapshot knows right now.
    return this.searchSvc.local(q);
  });

  protected readonly resultGroups = computed(() => {
    const by = new Map<HitType, SearchHit[]>();
    for (const h of this.hits()) by.set(h.type, [...(by.get(h.type) ?? []), h]);
    return HIT_ORDER.filter((t) => by.has(t)).map((t) => ({ type: t, label: HIT_LABEL[t], hits: by.get(t)! }));
  });

  private readonly slug = computed(() => this.store.slug() ?? '');

  protected readonly navCommands = computed<Cmd[]>(() => {
    const slug = this.slug();
    const go = (...path: string[]) => () => void this.router.navigate(['/', slug, ...path]);
    const out: Cmd[] = MAIN_NAV.map((n) => ({
      id: 'nav:' + n.segment,
      label: n.label,
      keywords: n.segment === 'projects' ? 'repository repositories repo git' : undefined,
      icon: n.icon,
      keys: n.keys,
      run: go(n.segment),
    }));
    out.push({ id: 'nav:teams', label: 'Teams', icon: LucideUsers, keys: 'g t', run: go('teams') });
    out.push({ id: 'nav:views', label: 'Views', icon: LucideLayers, keys: 'g v', run: go('views') });
    for (const t of this.store.teams()) {
      out.push({ id: 'team:' + t.id, label: `Team ${t.name}`, keywords: t.key, icon: LucideUsers, run: go('teams', t.key) });
    }
    for (const v of this.store.views()) {
      out.push({ id: 'view:' + v.id, label: `View ${v.name}`, icon: LucideLayers, run: go('views', v.id) });
    }
    for (const s of SETTINGS_SECTIONS) {
      out.push({
        id: 'settings:' + s.id,
        label: `Settings ${s.label}`,
        keywords: s.keywords,
        icon: s.id === 'profile' ? LucideSettings : s.icon,
        keys: s.id === 'profile' ? 'g s' : undefined,
        run: go('settings', s.id),
      });
    }
    return out;
  });

  protected readonly actionCommands = computed<Cmd[]>(() => {
    const create = (kind: CreateKind) => () => this.ui.openCreate(kind);
    const canWrite = this.store.can('member');
    const out: Cmd[] = [];
    if (canWrite) {
      out.push(
        { id: 'new:workstream', label: 'Create workstream', icon: LucidePlus, keys: 'c', run: create('workstream') },
        { id: 'new:issue', label: 'Create issue', keywords: 'bug feature incident report', icon: LucidePlus, run: create('issue') },
        { id: 'new:decision', label: 'Create decision', keywords: 'adr', icon: LucidePlus, run: create('decision') },
      );
    }
    out.push(
      { id: 'search', label: 'Search everything', icon: LucideSearch, keys: '/', run: () => this.ui.openModal('search') },
      {
        id: 'theme:toggle',
        label: 'Toggle theme',
        keywords: 'dark light mode',
        icon: this.theme.isDark() ? LucideSun : LucideMoon,
        keys: 'mod+j',
        run: () => this.theme.toggle(),
      },
      { id: 'theme:light', label: 'Theme: Light', icon: LucideSun, run: () => this.theme.set('light') },
      { id: 'theme:dark', label: 'Theme: Dark', icon: LucideMoon, run: () => this.theme.set('dark') },
      { id: 'theme:system', label: 'Theme: Match system', icon: LucideMonitor, run: () => this.theme.set('system') },
      { id: 'sidebar', label: 'Toggle sidebar', icon: LucidePanelLeft, keys: 'mod+b', run: () => this.ui.toggleSidebar() },
      { id: 'shortcuts', label: 'Keyboard shortcuts', icon: LucideCircleHelp, keys: '?', run: () => this.ui.openModal('shortcuts') },
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
      const q = this.query().trim();
      untracked(() => this.schedule(q));
    });
  }

  private schedule(q: string): void {
    clearTimeout(this.timer);
    const gen = ++this.gen;
    if (q.length < 2) {
      this.remote.set(null);
      this.loading.set(false);
      return;
    }
    this.loading.set(true);
    this.timer = setTimeout(async () => {
      try {
        const hits = await this.searchSvc.remote(q);
        if (gen === this.gen) this.remote.set({ q, hits });
      } catch {
        if (gen === this.gen) this.remote.set(null); // offline / endpoint missing: local results stay
      } finally {
        if (gen === this.gen) this.loading.set(false);
      }
    }, 180);
  }

  protected visual(h: SearchHit | RecentItem): Visual {
    const s = this.store;
    switch (h.type) {
      case 'workstream': {
        const w = s.workstreamById().get(h.id);
        if (w) return { kind: 'status', status: w.status };
        break;
      }
      case 'decision': {
        const d = s.decisionById().get(h.id);
        if (d) return { kind: 'status', status: d.status };
        break;
      }
      case 'issue': {
        const i = s.issueById().get(h.id);
        if (i) return { kind: 'status', status: i.status };
        break;
      }
      case 'artifact': {
        const a = s.artifactById().get(h.id);
        if (a) return { kind: 'artifact', status: a.state, artifactKind: a.kind };
        break;
      }
    }
    return { kind: 'icon' };
  }

  protected exec(c: Cmd): void {
    const before = this.ui.modal();
    c.run();
    // Create / search / shortcuts replace the modal themselves; otherwise close the palette.
    if (this.ui.modal() === before) this.ui.closeModal();
  }

  protected openHit(h: SearchHit | RecentItem): void {
    const slug = this.slug();
    if (!slug) return;
    const hit: SearchHit = { type: h.type, id: h.id, key: h.key, title: h.title, workstreamKey: h.workstreamKey };
    this.recents.push(hit);
    this.ui.closeModal();
    void this.router.navigate(['/', slug, ...this.searchSvc.path(hit)], { queryParams: this.searchSvc.queryParams(hit) });
  }
}
