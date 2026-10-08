import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Router, RouterLink, RouterLinkActive } from '@angular/router';
import {
  LucideChevronsUpDown,
  LucideCheck,
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
import { MAIN_NAV } from './nav';

/**
 * Sidebar content (workspace switcher, search, navigation, teams, views, user menu).
 * Rendered inside <hlm-sidebar> by AppShell — which also turns it into a sheet on mobile.
 */
@Component({
  selector: 'app-sidebar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
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
    <div hlmSidebarHeader class="gap-1.5 p-2">
      <!-- workspace switcher -->
      <button
        type="button"
        class="hover:bg-sidebar-accent data-open:bg-sidebar-accent flex h-9 w-full items-center gap-2 rounded-md px-1.5 text-start outline-hidden focus-visible:ring-2 focus-visible:ring-sidebar-ring"
        [hlmDropdownMenuTrigger]="workspaceMenu"
        align="start"
        aria-label="Switch workspace"
      >
        <span
          class="bg-foreground text-background flex size-5 shrink-0 items-center justify-center rounded-[5px] text-[11px] font-semibold"
          aria-hidden="true"
          >{{ wsInitial() }}</span
        >
        <span class="min-w-0 flex-1 truncate text-sm font-medium">{{ wsName() }}</span>
        <svg [lucideIcon]="chevrons" [size]="14" class="text-muted-foreground shrink-0"></svg>
      </button>

      <div class="flex items-center gap-1.5">
        <button
          type="button"
          class="border-sidebar-border bg-background text-muted-foreground hover:text-foreground flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border px-2 text-start text-[13px] outline-hidden focus-visible:ring-2 focus-visible:ring-sidebar-ring"
          (click)="ui.openCommandPalette()"
        >
          <svg [lucideIcon]="search" [size]="14" class="shrink-0"></svg>
          <span class="flex-1 truncate">Search</span>
          <app-kbd keys="mod+k" class="max-md:hidden" />
        </button>
        <button
          hlmBtn
          variant="outline"
          size="icon"
          class="bg-background border-sidebar-border size-8 shrink-0"
          hlmTooltip="New (C)"
          position="bottom"
          aria-label="Create"
          (click)="ui.openCreate('workstream')"
        >
          <svg [lucideIcon]="newIcon" [size]="14"></svg>
        </button>
      </div>
    </div>

    <div hlmSidebarContent class="gap-0 px-2 pb-2">
      <ul hlmSidebarMenu>
        @for (item of nav; track item.segment) {
          <li hlmSidebarMenuItem>
            <a
              hlmSidebarMenuButton
              [routerLink]="['/', slug(), item.segment]"
              routerLinkActive
              #rla="routerLinkActive"
              [isActive]="rla.isActive"
              closeMobileSidebarOnClick
            >
              <svg [lucideIcon]="item.icon" [size]="15" class="text-muted-foreground group-data-active/menu-button:text-foreground"></svg>
              <span class="flex-1 truncate">{{ item.label }}</span>
              @if (badge(item.badge); as n) {
                <span
                  class="tabular-nums text-[11px] font-medium"
                  [class]="item.badge === 'attention' ? 'text-status-needs-input' : 'text-primary'"
                  >{{ n }}</span
                >
              }
            </a>
          </li>
        }
      </ul>

      <!-- Teams -->
      <div hlmSidebarGroup class="mt-3 p-0">
        <div class="flex items-center">
          <a
            hlmSidebarGroupLabel
            class="hover:text-sidebar-foreground flex-1"
            [routerLink]="['/', slug(), 'teams']"
            >Teams</a
          >
          @if (canAdmin()) {
            <button
              type="button"
              class="text-muted-foreground hover:text-foreground flex size-6 items-center justify-center rounded-md"
              aria-label="Create team"
              (click)="ui.openCreate('team')"
            >
              <svg [lucideIcon]="plus" [size]="13"></svg>
            </button>
          }
        </div>
        <ul hlmSidebarMenu>
          @for (t of store.teams(); track t.id) {
            <li hlmSidebarMenuItem>
              <a
                hlmSidebarMenuButton
                [routerLink]="['/', slug(), 'teams', t.key]"
                routerLinkActive
                #tla="routerLinkActive"
                [isActive]="tla.isActive"
                closeMobileSidebarOnClick
              >
                <span
                  class="flex size-4 shrink-0 items-center justify-center rounded-[4px] font-mono text-[9px] font-semibold text-white"
                  [style.background]="t.color"
                  aria-hidden="true"
                  >{{ t.key.slice(0, 1) }}</span
                >
                <span class="flex-1 truncate">{{ t.name }}</span>
                <span class="text-muted-foreground font-mono text-[10px]">{{ t.key }}</span>
              </a>
            </li>
          } @empty {
            <li class="text-muted-foreground px-2 py-1 text-xs">No teams yet</li>
          }
        </ul>
      </div>

      <!-- Views -->
      <div hlmSidebarGroup class="mt-3 p-0">
        <div class="flex items-center">
          <a
            hlmSidebarGroupLabel
            class="hover:text-sidebar-foreground flex-1"
            [routerLink]="['/', slug(), 'views']"
            >Views</a
          >
          <button
            type="button"
            class="text-muted-foreground hover:text-foreground flex size-6 items-center justify-center rounded-md"
            aria-label="Create view"
            (click)="ui.openCreate('view')"
          >
            <svg [lucideIcon]="plus" [size]="13"></svg>
          </button>
        </div>
        <ul hlmSidebarMenu>
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
                <span class="flex-1 truncate">{{ v.name }}</span>
                @if (!v.shared) {
                  <span class="text-muted-foreground text-[10px]">Private</span>
                }
              </a>
            </li>
          } @empty {
            <li class="text-muted-foreground px-2 py-1 text-xs">No saved views</li>
          }
        </ul>
      </div>
    </div>

    <!-- footer: user menu -->
    <div hlmSidebarFooter class="border-sidebar-border border-t p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
      <button
        type="button"
        class="hover:bg-sidebar-accent data-open:bg-sidebar-accent flex h-9 w-full items-center gap-2 rounded-md px-1.5 text-start outline-hidden focus-visible:ring-2 focus-visible:ring-sidebar-ring"
        [hlmDropdownMenuTrigger]="userMenu"
        align="start"
        side="top"
        aria-label="User menu"
      >
        <app-actor-avatar [actor]="meRef()" [size]="22" />
        <span class="min-w-0 flex-1">
          <span class="block truncate text-[13px] leading-4 font-medium">{{ session.user()?.name ?? 'Account' }}</span>
          <span class="text-muted-foreground block truncate text-[11px] leading-3.5 capitalize">{{ session.role() ?? '' }}</span>
        </span>
        <svg [lucideIcon]="chevrons" [size]="14" class="text-muted-foreground shrink-0"></svg>
      </button>
    </div>

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
  protected readonly wsInitial = computed(() => this.wsName().slice(0, 1).toUpperCase());
  protected readonly canAdmin = computed(() => this.store.can('admin'));
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
