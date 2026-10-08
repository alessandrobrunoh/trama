import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterLinkActive } from '@angular/router';
import { filter, map, startWith } from 'rxjs';
import {
  LucideChevronDown,
  LucideChevronsUpDown,
  LucideCheck,
  LucideCircleDot,
  LucideEllipsis,
  LucideFolderGit2,
  LucideHexagon,
  LucideLayers,
  LucideLock,
  LucideScale,
  LucideUsers,
  LucideCircleHelp,
  LucideDynamicIcon,
  LucideLogOut,
  LucideMonitor,
  LucideMoon,
  LucidePlus,
  LucideSearch,
  LucideSettings,
  LucideSquarePen,
  LucideSun,
  LucideUserRound,
  type LucideIcon,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import { HlmSidebarImports, HlmSidebarService } from '@spartan-ng/helm/sidebar';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import { NablaStore } from '../core/stores/nabla.store';
import { UiStore } from '../core/stores/ui.store';
import { SessionStore } from '../core/session/session.store';
import { ThemeService, type ThemeMode } from '../core/theme';
import { ActorAvatar } from '../shared/actor-avatar';
import { Kbd } from '../shared/kbd';
import { MAIN_NAV, PERSONAL_NAV } from './nav';

/**
 * Sidebar content (workspace switcher, search, navigation, teams, views, user menu).
 * Rendered inside <hlm-sidebar> by AppShell — which also turns it into a sheet on mobile.
 */
@Component({
  selector: 'app-sidebar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    NgTemplateOutlet,
    RouterLink,
    RouterLinkActive,
    LucideDynamicIcon,
    HlmSidebarImports,
    HlmDropdownMenuImports,
    HlmButtonImports,
    HlmTooltip,
    Kbd,
    ActorAvatar,
  ],
  host: { class: 'flex h-full min-h-0 flex-col' },
  template: `
    <div class="border-sidebar-border flex items-center gap-2 border-b px-5 py-4 md:hidden">
      <button
        type="button"
        class="hover:bg-sidebar-accent flex min-w-0 flex-1 items-center gap-3 rounded-2xl px-2 py-2 text-start"
        [hlmDropdownMenuTrigger]="userMenu"
        align="start"
        aria-label="Account menu"
      >
        <app-actor-avatar [actor]="meRef()" [size]="36" />
        <span class="min-w-0 flex-1 truncate text-base font-medium">{{ session.user()?.name ?? 'Account' }}</span>
        <svg [lucideIcon]="chevrons" [size]="17" class="text-muted-foreground shrink-0"></svg>
      </button>
      <button
        type="button"
        class="hover:bg-sidebar-accent flex size-10 shrink-0 items-center justify-center rounded-full"
        aria-label="Settings"
        (click)="go(['/', slug(), 'settings', 'profile'])"
      >
        <svg [lucideIcon]="settings" [size]="19"></svg>
      </button>
    </div>

    <div hlmSidebarHeader class="gap-1 px-2 pt-2.5 pb-1 max-md:hidden">
      <div class="flex items-center gap-0.5">
        <!-- workspace switcher -->
        <button
          type="button"
          class="hover:bg-sidebar-accent data-open:bg-sidebar-accent flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 text-start outline-hidden focus-visible:ring-2 focus-visible:ring-sidebar-ring"
          [hlmDropdownMenuTrigger]="workspaceMenu"
          align="start"
          aria-label="Switch workspace"
        >
          <span
            class="bg-primary text-primary-foreground flex size-5 shrink-0 items-center justify-center rounded-[5px] text-[11px] font-semibold"
            [style.background]="wsColor()"
            [style.color]="wsColor() ? '#fff' : null"
            aria-hidden="true"
            >{{ wsInitial() }}</span
          >
          <span class="min-w-0 truncate text-[13px] font-semibold">{{ wsName() }}</span>
          <svg [lucideIcon]="chevronDown" [size]="13" class="text-muted-foreground shrink-0"></svg>
        </button>
        <button
          type="button"
          class="text-muted-foreground hover:bg-sidebar-accent hover:text-foreground flex size-8 shrink-0 items-center justify-center rounded-md outline-hidden focus-visible:ring-2 focus-visible:ring-sidebar-ring"
          hlmTooltip="Search  ⌘K"
          position="bottom"
          aria-label="Search (⌘K)"
          (click)="ui.openCommandPalette()"
        >
          <svg [lucideIcon]="search" [size]="15"></svg>
        </button>
        <button
          type="button"
          class="bg-background border-sidebar-border text-foreground hover:bg-sidebar-accent flex size-8 shrink-0 items-center justify-center rounded-md border shadow-xs outline-hidden focus-visible:ring-2 focus-visible:ring-sidebar-ring"
          [hlmDropdownMenuTrigger]="createMenu"
          align="end"
          hlmTooltip="Create  C"
          position="bottom"
          aria-label="Create"
        >
          <svg [lucideIcon]="newIcon" [size]="15"></svg>
        </button>
      </div>
    </div>

    <div hlmSidebarContent class="gap-0 px-2 pb-2">
      <ul hlmSidebarMenu class="gap-px">
        @for (item of personal; track item.segment) {
          <ng-container *ngTemplateOutlet="navLink; context: { $implicit: item }" />
        }
      </ul>

      <!-- Workspace -->
      <div class="mt-4 max-md:mt-2">
        <button type="button" class="group/sec text-muted-foreground hover:text-foreground flex h-6 w-full items-center gap-1 rounded-md px-2 text-xs font-medium" (click)="ui.toggleFolded('workspace')" [attr.aria-expanded]="!ui.isFolded('workspace')">
          Workspace
          <span class="inline-flex shrink-0 transition-transform" [class.-rotate-90]="ui.isFolded('workspace')"><svg [lucideIcon]="chevronDown" [size]="12" class="opacity-0 group-hover/sec:opacity-100"></svg></span>
        </button>
        @if (!ui.isFolded('workspace')) {
          <ul hlmSidebarMenu class="gap-px">
            @for (item of nav; track item.segment) {
              <ng-container *ngTemplateOutlet="navLink; context: { $implicit: item }" />
            }
          </ul>
        }
      </div>

      <!-- Teams -->
      <div class="mt-4 max-md:mt-3">
        <div class="group/sec flex items-center">
          <button type="button" class="text-muted-foreground hover:text-foreground flex h-6 flex-1 items-center gap-1 rounded-md px-2 text-xs font-medium" (click)="ui.toggleFolded('teams')" [attr.aria-expanded]="!ui.isFolded('teams')">
            Your teams
            <span class="inline-flex shrink-0 transition-transform" [class.-rotate-90]="ui.isFolded('teams')"><svg [lucideIcon]="chevronDown" [size]="12" class="opacity-0 group-hover/sec:opacity-100"></svg></span>
          </button>
          <a
            [routerLink]="['/', slug(), 'teams']"
            class="text-muted-foreground hover:text-foreground hover:bg-sidebar-accent flex size-6 items-center justify-center rounded-md opacity-0 group-hover/sec:opacity-100 focus-visible:opacity-100"
            hlmTooltip="All teams"
            aria-label="All teams"
            closeMobileSidebarOnClick
            ><svg [lucideIcon]="more" [size]="13"></svg
          ></a>
          @if (canAdmin()) {
            <button
              type="button"
              class="text-muted-foreground hover:text-foreground hover:bg-sidebar-accent flex size-6 items-center justify-center rounded-md opacity-0 group-hover/sec:opacity-100 focus-visible:opacity-100"
              aria-label="Create team"
              hlmTooltip="Create team"
              (click)="ui.openCreate('team')"
            >
              <svg [lucideIcon]="plus" [size]="13"></svg>
            </button>
          }
        </div>
        @if (!ui.isFolded('teams')) {
          <ul hlmSidebarMenu class="gap-px">
            @for (t of sidebarTeams(); track t.id) {
              @let open = ui.isFolded('open:team:' + t.id);
              <li hlmSidebarMenuItem>
                <button
                  type="button"
                  hlmSidebarMenuButton
                  (click)="ui.toggleFolded('open:team:' + t.id)"
                  [attr.aria-expanded]="open"
                >
                  <span
                    class="flex size-4 shrink-0 items-center justify-center rounded-[4px] text-[9px] font-semibold text-white"
                    [style.background]="t.color"
                    aria-hidden="true"
                    >{{ t.key.slice(0, 1) }}</span
                  >
                  <span class="truncate">{{ t.name }}</span>
                  <span class="inline-flex shrink-0 transition-transform" [class.-rotate-90]="!open"><svg [lucideIcon]="chevronDown" [size]="12" class="text-muted-foreground shrink-0"></svg></span>
                </button>
                @if (open) {
                  <ul class="mt-px flex flex-col gap-px pl-[18px]">
                    @for (sub of teamLinks; track sub.label) {
                      <li>
                        <a
                          hlmSidebarMenuButton
                          [routerLink]="sub.segment ? ['/', slug(), sub.segment] : ['/', slug(), 'teams', t.key]"
                          [queryParams]="sub.segment ? { team: t.id } : null"
                          [isActive]="isTeamLinkActive(t.id, t.key, sub.segment)"
                          closeMobileSidebarOnClick
                        >
                          <svg [lucideIcon]="sub.icon" [size]="14" class="text-muted-foreground"></svg>
                          <span class="flex-1 truncate">{{ sub.label }}</span>
                          @if (sub.segment === 'issues' && openIssuesByTeam().get(t.id); as n) {
                            <span class="text-muted-foreground text-[11px] tabular-nums">{{ n }}</span>
                          }
                          @if (sub.segment === 'workstreams' && activeWsByTeam().get(t.id); as n) {
                            <span class="text-muted-foreground text-[11px] tabular-nums">{{ n }}</span>
                          }
                        </a>
                      </li>
                    }
                  </ul>
                }
              </li>
            } @empty {
              <li class="text-muted-foreground px-2 py-1 text-xs">No teams yet</li>
            }
          </ul>
        }
      </div>

      <!-- Views -->
      <div class="mt-4 max-md:mt-3">
        <div class="group/sec flex items-center">
          <button type="button" class="text-muted-foreground hover:text-foreground flex h-6 flex-1 items-center gap-1 rounded-md px-2 text-xs font-medium" (click)="ui.toggleFolded('views')" [attr.aria-expanded]="!ui.isFolded('views')">
            Views
            <span class="inline-flex shrink-0 transition-transform" [class.-rotate-90]="ui.isFolded('views')"><svg [lucideIcon]="chevronDown" [size]="12" class="opacity-0 group-hover/sec:opacity-100"></svg></span>
          </button>
          <a
            [routerLink]="['/', slug(), 'views']"
            class="text-muted-foreground hover:text-foreground hover:bg-sidebar-accent flex size-6 items-center justify-center rounded-md opacity-0 group-hover/sec:opacity-100 focus-visible:opacity-100"
            hlmTooltip="All views"
            aria-label="All views"
            closeMobileSidebarOnClick
            ><svg [lucideIcon]="more" [size]="13"></svg
          ></a>
          <button
            type="button"
            class="text-muted-foreground hover:text-foreground hover:bg-sidebar-accent flex size-6 items-center justify-center rounded-md opacity-0 group-hover/sec:opacity-100 focus-visible:opacity-100"
            aria-label="Create view"
            hlmTooltip="Create view"
            (click)="ui.openCreate('view')"
          >
            <svg [lucideIcon]="plus" [size]="13"></svg>
          </button>
        </div>
        @if (!ui.isFolded('views')) {
          <ul hlmSidebarMenu class="gap-px">
            @for (v of store.views(); track v.id) {
              <li hlmSidebarMenuItem>
                <a
                  hlmSidebarMenuButton
                  [routerLink]="['/', slug(), 'views', v.id]"
                  routerLinkActive
                  #vla="routerLinkActive"
                  [isActive]="vla.isActive"
                  closeMobileSidebarOnClick
                >
                  <svg [lucideIcon]="viewIcon(v.entity)" [size]="14" class="text-muted-foreground"></svg>
                  <span class="flex-1 truncate">{{ v.name }}</span>
                  @if (!v.shared) {
                    <svg [lucideIcon]="lock" [size]="11" class="text-muted-foreground/70" aria-label="Private"></svg>
                  }
                </a>
              </li>
            } @empty {
              <li>
                <button type="button" class="text-muted-foreground hover:text-foreground px-2 py-1 text-xs" (click)="ui.openCreate('view')">
                  Save a filter as a view…
                </button>
              </li>
            }
          </ul>
        }
      </div>

      <div class="mt-4 border-t border-sidebar-border pt-2 md:hidden">
        <button
          type="button"
          hlmSidebarMenuButton
          class="max-md:!h-12 max-md:!rounded-xl max-md:!px-4 max-md:!text-[15px]"
          (click)="ui.openCommandPalette()"
          closeMobileSidebarOnClick
        >
          <svg [lucideIcon]="search" [size]="17" class="text-muted-foreground"></svg>
          <span>Search</span>
        </button>
      </div>
    </div>

    <!-- footer: user menu + help -->
    <div hlmSidebarFooter class="flex-row items-center gap-1 p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] max-md:hidden">
      <button
        type="button"
        class="hover:bg-sidebar-accent data-open:bg-sidebar-accent flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 text-start outline-hidden focus-visible:ring-2 focus-visible:ring-sidebar-ring"
        [hlmDropdownMenuTrigger]="userMenu"
        align="start"
        side="top"
        aria-label="User menu"
      >
        <app-actor-avatar [actor]="meRef()" [size]="20" />
        <span class="min-w-0 flex-1 truncate text-[13px] font-medium">{{ session.user()?.name ?? 'Account' }}</span>
      </button>
      <button
        type="button"
        class="text-muted-foreground hover:bg-sidebar-accent hover:text-foreground flex size-8 shrink-0 items-center justify-center rounded-md"
        hlmTooltip="Keyboard shortcuts  ?"
        position="top"
        aria-label="Keyboard shortcuts"
        (click)="ui.openModal('shortcuts')"
      >
        <svg [lucideIcon]="help" [size]="15"></svg>
      </button>
    </div>

    <ng-template #navLink let-item>
      <li hlmSidebarMenuItem>
        <a
          hlmSidebarMenuButton
          [routerLink]="['/', slug(), item.segment]"
          routerLinkActive
          #rla="routerLinkActive"
          [routerLinkActiveOptions]="{ paths: 'subset', queryParams: 'ignored', fragment: 'ignored', matrixParams: 'ignored' }"
          [isActive]="rla.isActive && !teamScoped()"
          [tooltip]="item.label"
          [attr.title]="item.hint ?? null"
          closeMobileSidebarOnClick
        >
          <svg [lucideIcon]="item.icon" [size]="15" class="text-muted-foreground group-data-active/menu-button:text-foreground"></svg>
          <span class="flex-1 truncate">{{ item.label }}</span>
          @if (badge(item.badge); as n) {
            @if (item.badge === 'attention') {
              <span class="bg-primary text-primary-foreground min-w-[18px] rounded-full px-1.5 text-center text-[10px] leading-[16px] font-semibold tabular-nums">{{ n }}</span>
            } @else {
              <span class="text-muted-foreground text-[11px] tabular-nums">{{ n }}</span>
            }
          }
        </a>
      </li>
    </ng-template>

    <!-- menus -->
    <ng-template #workspaceMenu>
      <hlm-dropdown-menu class="w-60">
        <hlm-dropdown-menu-label>Workspaces</hlm-dropdown-menu-label>
        <hlm-dropdown-menu-group>
          @for (w of session.workspaces(); track w.id) {
            <button hlmDropdownMenuItem (triggered)="session.switchWorkspace(w.slug)">
              <span
                class="bg-foreground text-background! flex size-4 shrink-0 items-center justify-center rounded-[4px] text-[10px] font-semibold"
                aria-hidden="true"
                >{{ w.name.slice(0, 1).toUpperCase() }}</span
              >
              <span class="flex-1 truncate text-start">{{ w.name }}</span>
              @if (w.slug === slug()) {
                <svg [lucideIcon]="check" [size]="14" class="text-muted-foreground"></svg>
              }
            </button>
          }
        </hlm-dropdown-menu-group>
        <hlm-dropdown-menu-separator />
        <hlm-dropdown-menu-group>
          <button hlmDropdownMenuItem (triggered)="go(['/new-workspace'])">
            <svg [lucideIcon]="plus" [size]="14"></svg>
            Create workspace
          </button>
          <button hlmDropdownMenuItem (triggered)="go(['/', slug(), 'settings', 'workspace'])">
            <svg [lucideIcon]="settings" [size]="14"></svg>
            Workspace settings
            <hlm-dropdown-menu-shortcut><app-kbd keys="g s" /></hlm-dropdown-menu-shortcut>
          </button>
        </hlm-dropdown-menu-group>
      </hlm-dropdown-menu>
    </ng-template>

    <ng-template #createMenu>
      <hlm-dropdown-menu class="w-64">
        <hlm-dropdown-menu-group>
          <button hlmDropdownMenuItem (triggered)="ui.openCreate('issue')">
            <svg [lucideIcon]="issueIcon" [size]="14"></svg>
            <span class="flex flex-1 flex-col">
              <span>New issue</span>
              <span class="text-muted-foreground text-[11px]">A bug, request or incident</span>
            </span>
          </button>
          <button hlmDropdownMenuItem (triggered)="ui.openCreate('workstream')">
            <svg [lucideIcon]="wsIcon" [size]="14" class="text-entity-workstream"></svg>
            <span class="flex flex-1 flex-col">
              <span>New workstream</span>
              <span class="text-muted-foreground text-[11px]">An outcome that resolves issues</span>
            </span>
          </button>
          <button hlmDropdownMenuItem (triggered)="ui.openCreate('decision')">
            <svg [lucideIcon]="decisionIcon" [size]="14" class="text-entity-decision"></svg>
            <span class="flex-1">New decision</span>
          </button>
        </hlm-dropdown-menu-group>
        <hlm-dropdown-menu-separator />
        <hlm-dropdown-menu-group>
          <button hlmDropdownMenuItem (triggered)="ui.openCreate('view')">
            <svg [lucideIcon]="layers" [size]="14"></svg>
            <span class="flex-1">New view</span>
          </button>
          <button hlmDropdownMenuItem (triggered)="ui.openCreate('repository')">
            <svg [lucideIcon]="repoIcon" [size]="14"></svg>
            <span class="flex-1">New project</span>
          </button>
          @if (canAdmin()) {
            <button hlmDropdownMenuItem (triggered)="ui.openCreate('team')">
              <svg [lucideIcon]="usersIcon" [size]="14"></svg>
              <span class="flex-1">New team</span>
            </button>
          }
        </hlm-dropdown-menu-group>
      </hlm-dropdown-menu>
    </ng-template>

    <ng-template #userMenu>
      <hlm-dropdown-menu class="w-60">
        <hlm-dropdown-menu-label class="flex flex-col gap-0.5">
          <span class="text-foreground text-[13px] font-medium">{{ session.user()?.name }}</span>
          <span class="text-muted-foreground text-xs font-normal">{{ session.user()?.email }}</span>
        </hlm-dropdown-menu-label>
        <hlm-dropdown-menu-separator />
        <hlm-dropdown-menu-group>
          <button hlmDropdownMenuItem (triggered)="go(['/', slug(), 'settings', 'profile'])">
            <svg [lucideIcon]="user" [size]="14"></svg>
            Profile
          </button>
          <button hlmDropdownMenuItem (triggered)="go(['/', slug(), 'settings', 'profile'])">
            <svg [lucideIcon]="settings" [size]="14"></svg>
            Settings
            <hlm-dropdown-menu-shortcut><app-kbd keys="g s" /></hlm-dropdown-menu-shortcut>
          </button>
          <button hlmDropdownMenuItem (triggered)="ui.openModal('shortcuts')">
            <svg [lucideIcon]="help" [size]="14"></svg>
            Keyboard shortcuts
            <hlm-dropdown-menu-shortcut><app-kbd keys="?" /></hlm-dropdown-menu-shortcut>
          </button>
        </hlm-dropdown-menu-group>
        <hlm-dropdown-menu-separator />
        <hlm-dropdown-menu-label class="flex items-center justify-between">
          Theme <app-kbd keys="mod+j" />
        </hlm-dropdown-menu-label>
        <hlm-dropdown-menu-group>
          @for (t of themes; track t.mode) {
            <button
              hlmDropdownMenuRadio
              [checked]="theme.mode() === t.mode"
              (triggered)="theme.set(t.mode)"
            >
              <svg [lucideIcon]="t.icon" [size]="14"></svg>
              {{ t.label }}
              <hlm-dropdown-menu-radio-indicator />
            </button>
          }
        </hlm-dropdown-menu-group>
        <hlm-dropdown-menu-separator />
        <button hlmDropdownMenuItem variant="destructive" (triggered)="session.logout()">
          <svg [lucideIcon]="logout" [size]="14"></svg>
          Log out
        </button>
      </hlm-dropdown-menu>
    </ng-template>
  `,
})
export class AppSidebar {
  protected readonly ui = inject(UiStore);
  protected readonly store = inject(NablaStore);
  protected readonly session = inject(SessionStore);
  protected readonly theme = inject(ThemeService);
  private readonly router = inject(Router);
  private readonly sidebar = inject(HlmSidebarService);

  protected readonly nav = MAIN_NAV;
  protected readonly personal = PERSONAL_NAV;
  protected readonly chevronDown = LucideChevronDown;
  protected readonly more = LucideEllipsis;
  protected readonly lock = LucideLock;
  protected readonly issueIcon = LucideCircleDot;
  protected readonly wsIcon = LucideHexagon;
  protected readonly decisionIcon = LucideScale;
  protected readonly layers = LucideLayers;
  protected readonly repoIcon = LucideFolderGit2;
  protected readonly usersIcon = LucideUsers;
  protected readonly teamLinks = [
    { label: 'Issues', segment: 'issues', icon: LucideCircleDot },
    { label: 'Workstreams', segment: 'workstreams', icon: LucideHexagon },
    { label: 'Team page', segment: '', icon: LucideUsers },
  ] as const;

  private readonly url = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map((e) => e.urlAfterRedirects),
      startWith(this.router.url),
    ),
    { initialValue: this.router.url },
  );
  /** `?team=` of the current list page (team sub-links light up instead of the main item). */
  protected readonly teamScoped = computed(() => /[?&]team=/.test(this.url()));

  /** My teams first, then the rest. */
  protected readonly sidebarTeams = computed(() => {
    const mine = this.store.myTeamIds();
    return [...this.store.teams()].sort((a, b) => Number(mine.has(b.id)) - Number(mine.has(a.id)));
  });
  protected readonly openIssuesByTeam = computed(() => {
    const m = new Map<string, number>();
    for (const i of this.store.issues()) {
      if (!i.teamId || i.status === 'done' || i.status === 'canceled') continue;
      m.set(i.teamId, (m.get(i.teamId) ?? 0) + 1);
    }
    return m;
  });
  protected readonly activeWsByTeam = computed(() => {
    const m = new Map<string, number>();
    for (const w of this.store.workstreams()) {
      if (w.status === 'shipped' || w.status === 'canceled' || w.status === 'draft') continue;
      m.set(w.ownerTeamId, (m.get(w.ownerTeamId) ?? 0) + 1);
    }
    return m;
  });

  protected isTeamLinkActive(teamId: string, teamKey: string, segment: string): boolean {
    const [path, query = ''] = this.url().split('?');
    const segs = path.split('/').filter(Boolean);
    if (!segment) return segs[1] === 'teams' && decodeURIComponent(segs[2] ?? '').toUpperCase() === teamKey.toUpperCase();
    return segs[1] === segment && segs.length === 2 && new URLSearchParams(query).get('team') === teamId;
  }

  protected viewIcon(entity: string): LucideIcon {
    return entity === 'issue' ? LucideCircleDot : entity === 'decision' ? LucideScale : LucideHexagon;
  }
  protected readonly chevrons = LucideChevronsUpDown;
  protected readonly search = LucideSearch;
  protected readonly newIcon = LucideSquarePen;
  protected readonly plus = LucidePlus;
  protected readonly check = LucideCheck;
  protected readonly settings = LucideSettings;
  protected readonly user = LucideUserRound;
  protected readonly help = LucideCircleHelp;
  protected readonly logout = LucideLogOut;
  protected readonly themes: { mode: ThemeMode; label: string; icon: LucideIcon }[] = [
    { mode: 'light', label: 'Light', icon: LucideSun },
    { mode: 'dark', label: 'Dark', icon: LucideMoon },
    { mode: 'system', label: 'System', icon: LucideMonitor },
  ];

  protected readonly slug = computed(() => this.store.slug() ?? this.session.workspace()?.slug ?? '');
  protected readonly wsName = computed(
    () => this.store.workspace()?.name ?? this.session.workspace()?.name ?? 'Workspace',
  );
  protected readonly wsInitial = computed(() => this.store.settings().iconInitial || this.wsName().slice(0, 1).toUpperCase());
  protected readonly wsColor = computed(() => this.store.settings().iconColor ?? null);
  protected readonly canAdmin = computed(() => this.store.allowed('createTeams'));
  protected readonly meRef = computed(() => {
    const u = this.session.user();
    return u ? ({ type: 'user', id: u.id } as const) : null;
  });

  protected badge(kind: 'attention' | 'issues' | undefined): number {
    if (kind === 'attention') return this.store.attentionCount();
    if (kind === 'issues') return this.store.backlogIssueCount();
    return 0;
  }

  protected go(commands: string[]): void {
    void this.router.navigate(commands);
    this.sidebar.setOpenMobile(false);
  }
}
