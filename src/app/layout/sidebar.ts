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
  LucideInbox,
  LucideBox,
  LucideLayers,
  LucideLock,
  LucideBookOpen,
  LucideCircleHelp,
  LucideExternalLink,
  LucideKeyboard,
  LucideKeyRound,
  LucideListChecks,
  LucideMap,
  LucidePlug,
  LucideDynamicIcon,
  LucideLogOut,
  LucideMonitor,
  LucideMoon,
  LucidePanelLeft,
  LucidePlus,
  LucideSearch,
  LucideSettings,
  LucideSquarePen,
  LucideSun,
  LucideUserRound,
  LucideX,
  type LucideIcon,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import { HlmSidebarImports, HlmSidebarService } from '@spartan-ng/helm/sidebar';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import { FavoritesStore } from '../core/stores/favorites.store';
import { NotificationsStore } from '../core/stores/notifications.store';
import { TramaStore } from '../core/stores/trama.store';
import { UiStore } from '../core/stores/ui.store';
import { SessionStore } from '../core/session/session.store';
import { ThemeService, type ThemeMode } from '../core/theme';
import { ActorAvatar } from '../shared/actor-avatar';
import { Kbd } from '../shared/kbd';
import { StatusIcon } from '../shared/status';
import { CHANGELOG } from '../features/changelog/changelog-entries';
import { ProjectGlyph } from '../features/projects/project-glyph';
import { MORE_NAV, PRIMARY_NAV, orderNav, type NavItem } from './nav';
import { SidebarTree } from './sidebar-tree';

/**
 * Sidebar content: icon row (toggle, search, inbox, create), workspace switcher, Inbox / Tasks,
 * Pinned, the Projects tree, Views, a "More" group and the user menu. Light-gray pane, no row
 * dividers, flat gray selected row, sentence-case muted section labels.
 * Rendered inside <hlm-sidebar> by AppShell. On phones the shell shows <app-mobile-nav> instead.
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
    StatusIcon,
    ProjectGlyph,
    SidebarTree,
  ],
  host: { class: 'flex h-full min-h-0 flex-col' },
  template: `
    <div hlmSidebarHeader class="gap-0 p-0">
      <!-- window-ish icon row: toggle + search on the left, inbox + create on the right -->
      <div class="pane-header border-sidebar-border border-b px-2">
        <button
          hlmBtn
          variant="ghost"
          size="icon-sm"
          class="text-muted-foreground"
          hlmTooltip="Hide sidebar  ⌘B"
          position="bottom"
          aria-label="Hide sidebar (⌘B)"
          (click)="sidebar.toggleSidebar()"
        >
          <svg [lucideIcon]="sidebarIcon" [size]="16"></svg>
        </button>
        <button
          hlmBtn
          variant="ghost"
          size="icon-sm"
          class="text-muted-foreground"
          hlmTooltip="Search  ⌘K"
          position="bottom"
          aria-label="Search (⌘K)"
          (click)="ui.openCommandPalette()"
        >
          <svg [lucideIcon]="search" [size]="16"></svg>
        </button>
        <span class="flex-1"></span>
        <a
          hlmBtn
          variant="ghost"
          size="icon-sm"
          class="text-muted-foreground relative"
          [routerLink]="['/', slug(), 'inbox']"
          hlmTooltip="Inbox  G then A"
          position="bottom"
          [attr.aria-label]="inboxCount() ? 'Inbox, ' + inboxCount() + ' need you' : 'Inbox'"
        >
          <svg [lucideIcon]="inboxIcon" [size]="16"></svg>
          @if (inboxCount() > 0) {
            <span class="bg-primary ring-sidebar absolute top-1 right-1 size-1.5 rounded-full ring-2" aria-hidden="true"></span>
          }
        </a>
        <button
          hlmBtn
          variant="ghost"
          size="icon-sm"
          class="text-muted-foreground"
          [hlmDropdownMenuTrigger]="createMenu"
          align="end"
          hlmTooltip="Create  C"
          position="bottom"
          aria-label="Create"
        >
          <svg [lucideIcon]="newIcon" [size]="16"></svg>
        </button>
      </div>

      <!-- workspace switcher -->
      <div class="px-2 pt-2 pb-1">
        <button
          type="button"
          class="text-sidebar-foreground hover:bg-sidebar-accent/60 data-open:bg-sidebar-accent focus-visible:ring-sidebar-ring flex h-8 w-full min-w-0 items-center gap-2 rounded-sm px-2 text-start outline-hidden focus-visible:ring-2"
          [hlmDropdownMenuTrigger]="workspaceMenu"
          align="start"
          aria-label="Switch workspace"
        >
          <span class="text-muted-foreground min-w-0 flex-1 truncate text-[13px]">{{ wsName() }}</span>
          <svg [lucideIcon]="chevrons" [size]="14" class="text-muted-foreground shrink-0"></svg>
        </button>
      </div>
    </div>

    <div hlmSidebarContent class="gap-0 px-2 pb-2">
      <ul hlmSidebarMenu class="gap-px">
        @for (item of primary(); track item.segment) {
          <ng-container *ngTemplateOutlet="navLink; context: { $implicit: item }" />
        }
      </ul>

      <!-- Pinned: only once something is pinned -->
      @if (favorites.entries().length) {
        <div class="mt-4">
          <ng-container *ngTemplateOutlet="sectionLabel; context: { $implicit: 'favorites', label: 'Pinned' }" />
          @if (!ui.isFolded('favorites')) {
            <ul hlmSidebarMenu class="gap-px">
              @for (e of favorites.entries(); track e.favorite.id) {
                <li hlmSidebarMenuItem class="group/fav relative">
                  <a
                    hlmSidebarMenuButton
                    [routerLink]="['/', slug(), ...e.link]"
                    routerLinkActive
                    #fla="routerLinkActive"
                    [isActive]="fla.isActive"
                    [tooltip]="e.key ? e.key + ' · ' + e.label : e.label"
                    closeMobileSidebarOnClick
                  >
                    @switch (e.type) {
                      @case ('issue') {
                        <app-status-icon entity="issue" [status]="$any(e.status)" />
                      }
                      @case ('project') {
                        @if (store.getProject(e.subjectId); as pj) {
                          <app-project-glyph [project]="pj" [size]="14" />
                        } @else {
                          <svg
                            [lucideIcon]="projectIcon"
                            [size]="14"
                            class="text-muted-foreground shrink-0"
                          ></svg>
                        }
                      }
                      @case ('view') {
                        <svg
                          [lucideIcon]="layers"
                          [size]="14"
                          class="text-muted-foreground shrink-0"
                        ></svg>
                      }
                    }
                    <span class="truncate-fade flex-1">{{ e.label }}</span>
                  </a>
                  <button
                    type="button"
                    class="text-muted-foreground hover:text-foreground hover:bg-sidebar-accent absolute top-1/2 right-1 flex size-5 -translate-y-1/2 items-center justify-center rounded-sm opacity-0 group-hover/fav:opacity-100 focus-visible:opacity-100 max-md:opacity-100"
                    aria-label="Remove from pinned"
                    hlmTooltip="Unpin"
                    (click)="favorites.toggle(e.type, e.subjectId)"
                  >
                    <svg [lucideIcon]="closeIcon" [size]="12"></svg>
                  </button>
                </li>
              }
            </ul>
          }
        </div>
      }

      <!-- Projects: a tree (project > open tasks > subtasks) -->
      <div class="mt-4">
        <ng-container
          *ngTemplateOutlet="
            sectionLabel;
            context: { $implicit: 'projects', label: 'Projects', all: 'projects', allLabel: 'All projects', create: 'project', createLabel: 'New project' }
          "
        />
        @if (!ui.isFolded('projects')) {
          <app-sidebar-tree />
        }
      </div>

      <!-- Views -->
      <div class="mt-4">
        <ng-container
          *ngTemplateOutlet="
            sectionLabel;
            context: { $implicit: 'views', label: 'Views', all: 'views', allLabel: 'All views', create: 'view', createLabel: 'Create view' }
          "
        />
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
                  <svg
                    [lucideIcon]="viewIcon(v.entity)"
                    [size]="14"
                    class="text-muted-foreground"
                  ></svg>
                  <span class="truncate-fade flex-1">{{ v.name }}</span>
                  @if (!v.shared) {
                    <svg
                      [lucideIcon]="lock"
                      [size]="11"
                      class="text-muted-foreground/70"
                      aria-label="Private"
                    ></svg>
                  }
                </a>
              </li>
            } @empty {
              <li>
                <button
                  type="button"
                  class="text-muted-foreground hover:text-foreground px-2 py-1 text-xs"
                  (click)="ui.openCreate('view')"
                >
                  Save a filter as a view…
                </button>
              </li>
            }
          </ul>
        }
      </div>

      <!-- More: Stats, Timer, Activity, Assistant, Connect, Settings. Folded by default, open on its own pages. -->
      <div class="mt-4">
        <button
          type="button"
          class="text-muted-foreground hover:text-foreground flex h-7 w-full items-center gap-1 rounded-sm px-2 text-[13px] outline-hidden focus-visible:ring-2 focus-visible:ring-sidebar-ring"
          (click)="ui.toggleFolded('open:more')"
          [attr.aria-expanded]="moreOpen()"
          aria-controls="sidebar-more"
        >
          More
          <svg
            [lucideIcon]="chevronDown"
            [size]="12"
            class="transition-transform"
            [class.-rotate-90]="!moreOpen()"
            aria-hidden="true"
          ></svg>
        </button>
        @if (moreOpen()) {
          <ul hlmSidebarMenu id="sidebar-more" class="gap-px">
            @for (item of moreItems(); track item.segment) {
              <ng-container *ngTemplateOutlet="navLink; context: { $implicit: item }" />
            }
            <ng-container *ngTemplateOutlet="navLink; context: { $implicit: settingsItem }" />
          </ul>
        }
      </div>
    </div>

    <!-- footer: user menu + help -->
    <div
      hlmSidebarFooter
      class="border-sidebar-border flex-row items-center gap-1 border-t p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]"
    >
      <button
        type="button"
        class="text-sidebar-foreground hover:bg-sidebar-accent/60 data-open:bg-sidebar-accent focus-visible:ring-sidebar-ring flex h-8 min-w-0 flex-1 items-center gap-2 rounded-sm px-2 text-start outline-hidden focus-visible:ring-2"
        [hlmDropdownMenuTrigger]="userMenu"
        align="start"
        side="top"
        aria-label="User menu"
      >
        <app-actor-avatar [actor]="meRef()" [size]="20" />
        <span class="min-w-0 flex-1 truncate text-[13px]">{{ session.user()?.name ?? 'Account' }}</span>
        <svg [lucideIcon]="chevronDown" [size]="14" class="text-muted-foreground shrink-0"></svg>
      </button>
      <button
        hlmBtn
        variant="ghost"
        size="icon-sm"
        class="text-muted-foreground data-open:bg-sidebar-accent shrink-0"
        [hlmDropdownMenuTrigger]="helpMenu"
        align="start"
        side="top"
        aria-label="Help"
      >
        <svg [lucideIcon]="help" [size]="15"></svg>
      </button>
    </div>

    <!-- sentence-case muted section label; the fold chevron and actions show on hover / focus -->
    <ng-template #sectionLabel let-id let-label="label" let-all="all" let-allLabel="allLabel" let-create="create" let-createLabel="createLabel">
      <div class="group/sec flex items-center">
        <button
          type="button"
          class="text-muted-foreground hover:text-foreground focus-visible:ring-sidebar-ring flex h-7 flex-1 items-center gap-1 rounded-sm px-2 text-[13px] outline-hidden focus-visible:ring-2"
          (click)="ui.toggleFolded(id)"
          [attr.aria-expanded]="!ui.isFolded(id)"
        >
          {{ label }}
          <svg
            [lucideIcon]="chevronDown"
            [size]="12"
            class="transition-[transform,opacity] group-hover/sec:opacity-100 group-focus-within/sec:opacity-100 max-md:opacity-100"
            [class.-rotate-90]="ui.isFolded(id)"
            [class.opacity-0]="!ui.isFolded(id)"
            aria-hidden="true"
          ></svg>
        </button>
        @if (all) {
          <a
            [routerLink]="['/', slug(), all]"
            class="text-muted-foreground hover:text-foreground hover:bg-sidebar-accent flex size-6 items-center justify-center rounded-sm opacity-0 group-hover/sec:opacity-100 group-focus-within/sec:opacity-100 focus-visible:opacity-100"
            [hlmTooltip]="allLabel"
            [attr.aria-label]="allLabel"
            closeMobileSidebarOnClick
            ><svg [lucideIcon]="more" [size]="13"></svg
          ></a>
        }
        @if (create) {
          <button
            type="button"
            class="text-muted-foreground hover:text-foreground hover:bg-sidebar-accent flex size-6 items-center justify-center rounded-sm opacity-0 group-hover/sec:opacity-100 group-focus-within/sec:opacity-100 focus-visible:opacity-100"
            [attr.aria-label]="createLabel"
            [hlmTooltip]="createLabel"
            (click)="ui.openCreate(create)"
          >
            <svg [lucideIcon]="plus" [size]="13"></svg>
          </button>
        }
      </div>
    </ng-template>

    <ng-template #navLink let-item>
      <li hlmSidebarMenuItem>
        <a
          hlmSidebarMenuButton
          [routerLink]="['/', slug(), ...item.path]"
          routerLinkActive
          #rla="routerLinkActive"
          [routerLinkActiveOptions]="{
            paths: 'subset',
            queryParams: 'ignored',
            fragment: 'ignored',
            matrixParams: 'ignored',
          }"
          [isActive]="rla.isActive"
          [tooltip]="item.label"
          [attr.title]="item.hint ?? null"
          closeMobileSidebarOnClick
        >
          <svg
            [lucideIcon]="item.icon"
            [size]="15"
            class="text-muted-foreground group-data-active/menu-button:text-foreground"
          ></svg>
          <span class="truncate-fade flex-1">{{ item.label }}</span>
          @if (badge(item.badge); as n) {
            @if (ui.sidebarBadgeStyle() === 'dot' || item.badge === 'inbox') {
              <span class="flex items-center gap-1.5">
                @if (item.badge === 'inbox' && ui.sidebarBadgeStyle() === 'count') {
                  <span class="text-primary text-[11px] tabular-nums">{{ n }}</span>
                }
                <span
                  class="size-1.5 shrink-0 rounded-full"
                  [class.bg-primary]="item.badge === 'inbox'"
                  [class.bg-muted-foreground]="item.badge !== 'inbox'"
                  role="img"
                  [attr.aria-label]="n + ' pending'"
                ></span>
              </span>
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
              <span>New task</span>
              <span class="text-muted-foreground text-[11px]">A bug, request or incident</span>
            </span>
          </button>
        </hlm-dropdown-menu-group>
        <hlm-dropdown-menu-separator />
        <hlm-dropdown-menu-group>
          <button hlmDropdownMenuItem (triggered)="ui.openCreate('view')">
            <svg [lucideIcon]="layers" [size]="14"></svg>
            <span class="flex-1">New view</span>
          </button>
          <button hlmDropdownMenuItem (triggered)="ui.openCreate('project')">
            <svg [lucideIcon]="projectIcon" [size]="14"></svg>
            <span class="flex-1">New project</span>
          </button>
        </hlm-dropdown-menu-group>
      </hlm-dropdown-menu>
    </ng-template>

    <ng-template #helpMenu>
      <hlm-dropdown-menu class="w-64">
        <hlm-dropdown-menu-group>
          <button hlmDropdownMenuItem (triggered)="ui.openModal('shortcuts')">
            <svg [lucideIcon]="keyboardIcon" [size]="14"></svg>
            Keyboard shortcuts
            <hlm-dropdown-menu-shortcut><app-kbd keys="?" /></hlm-dropdown-menu-shortcut>
          </button>
          <button hlmDropdownMenuItem (triggered)="ui.openCommandPalette()">
            <svg [lucideIcon]="search" [size]="14"></svg>
            Command palette
            <hlm-dropdown-menu-shortcut><app-kbd keys="mod+k" /></hlm-dropdown-menu-shortcut>
          </button>
          <button hlmDropdownMenuItem (triggered)="go(['/', slug(), 'connect'])">
            <svg [lucideIcon]="plugIcon" [size]="14"></svg>
            Connect your agent
            <hlm-dropdown-menu-shortcut><app-kbd keys="g k" /></hlm-dropdown-menu-shortcut>
          </button>
          <button hlmDropdownMenuItem (triggered)="go(['/', slug(), 'settings', 'tokens'])">
            <svg [lucideIcon]="keyIcon" [size]="14"></svg>
            API tokens
          </button>
          <button hlmDropdownMenuItem (triggered)="showChecklist()">
            <svg [lucideIcon]="checklistIcon" [size]="14"></svg>
            Setup checklist
          </button>
          <button hlmDropdownMenuItem (triggered)="go(['/', slug(), 'settings', 'integrations'])">
            <svg [lucideIcon]="plugIcon" [size]="14"></svg>
            Integrations
          </button>
          <button hlmDropdownMenuItem (triggered)="go(['/', slug(), 'settings', 'profile'])">
            <svg [lucideIcon]="settings" [size]="14"></svg>
            Settings
            <hlm-dropdown-menu-shortcut><app-kbd keys="g s" /></hlm-dropdown-menu-shortcut>
          </button>
        </hlm-dropdown-menu-group>
        <hlm-dropdown-menu-separator />
        <hlm-dropdown-menu-group>
          <button hlmDropdownMenuItem (triggered)="openPublic('/roadmap')">
            <svg [lucideIcon]="mapIcon" [size]="14"></svg>
            Roadmap
            <svg
              [lucideIcon]="externalIcon"
              [size]="12"
              class="text-muted-foreground ms-auto"
            ></svg>
          </button>
          <button hlmDropdownMenuItem (triggered)="openPublic('/blog')">
            <svg [lucideIcon]="bookIcon" [size]="14"></svg>
            Blog
            <svg
              [lucideIcon]="externalIcon"
              [size]="12"
              class="text-muted-foreground ms-auto"
            ></svg>
          </button>
        </hlm-dropdown-menu-group>
        <hlm-dropdown-menu-separator />
        <hlm-dropdown-menu-label>What's new</hlm-dropdown-menu-label>
        <hlm-dropdown-menu-group>
          @for (e of latestChanges; track e.title) {
            <button hlmDropdownMenuItem (triggered)="openPublic('/changelog')">
              <span class="min-w-0 flex-1 truncate">{{ e.title }}</span>
              <span class="text-muted-foreground shrink-0 text-xs">{{ e.date.slice(5) }}</span>
            </button>
          }
          <button hlmDropdownMenuItem (triggered)="openPublic('/changelog')">
            <span class="flex-1">Full changelog</span>
            <svg [lucideIcon]="externalIcon" [size]="12" class="text-muted-foreground"></svg>
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
          <button hlmDropdownMenuItem (triggered)="ui.openModal('customize-sidebar')">
            <svg [lucideIcon]="sidebarIcon" [size]="14"></svg>
            Customize sidebar
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
  protected readonly favorites = inject(FavoritesStore);
  protected readonly notifications = inject(NotificationsStore);
  protected readonly store = inject(TramaStore);
  protected readonly session = inject(SessionStore);
  protected readonly theme = inject(ThemeService);
  protected readonly sidebar = inject(HlmSidebarService);
  private readonly router = inject(Router);

  protected readonly sidebarIcon = LucidePanelLeft;
  protected readonly inboxIcon = LucideInbox;

  /** Top entries (Inbox, Tasks) the user chose to show, in their order. Projects live in the tree below. */
  protected readonly primary = computed(() =>
    this.visible(orderNav(PRIMARY_NAV, this.ui.sidebarOrder().personal))
      .filter((n) => n.segment !== 'projects')
      .map(withPath),
  );
  /** "More" entries (Views has its own section). "Only when badged" entries drop out while their badge is empty. */
  protected readonly moreItems = computed(() =>
    this.visible(orderNav(MORE_NAV, this.ui.sidebarOrder().workspace))
      .filter((n) => n.segment !== 'views')
      .map(withPath),
  );
  protected readonly settingsItem = {
    segment: 'settings',
    path: ['settings', 'profile'],
    label: 'Settings',
    icon: LucideSettings,
    hint: 'Your profile, workspace, members, integrations and tokens',
  };
  /** Open by choice, or because the page you are on lives under More. */
  protected readonly moreOpen = computed(() => {
    if (this.ui.isFolded('open:more')) return true;
    const section = this.url().split(/[?#]/)[0].split('/').filter(Boolean)[1];
    return section === 'settings' || this.moreItems().some((n) => n.segment === section);
  });
  protected readonly inboxCount = computed(() => this.badge('inbox'));
  protected readonly chevronDown = LucideChevronDown;
  protected readonly more = LucideEllipsis;
  protected readonly lock = LucideLock;
  protected readonly issueIcon = LucideCircleDot;
  protected readonly layers = LucideLayers;
  protected readonly closeIcon = LucideX;
  protected readonly projectIcon = LucideBox;

  private readonly url = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map((e) => e.urlAfterRedirects),
      startWith(this.router.url),
    ),
    { initialValue: this.router.url },
  );
  protected viewIcon(entity: string): LucideIcon {
    if (entity === 'issue') return LucideCircleDot;
    return entity === 'project' ? LucideBox : LucideLayers;
  }
  protected readonly chevrons = LucideChevronsUpDown;
  protected readonly search = LucideSearch;
  protected readonly newIcon = LucideSquarePen;
  protected readonly plus = LucidePlus;
  protected readonly check = LucideCheck;
  protected readonly settings = LucideSettings;
  protected readonly user = LucideUserRound;
  protected readonly help = LucideCircleHelp;
  protected readonly keyboardIcon = LucideKeyboard;
  protected readonly keyIcon = LucideKeyRound;
  protected readonly plugIcon = LucidePlug;
  protected readonly mapIcon = LucideMap;
  protected readonly checklistIcon = LucideListChecks;
  protected readonly bookIcon = LucideBookOpen;
  protected readonly externalIcon = LucideExternalLink;
  protected readonly latestChanges = CHANGELOG.slice(0, 3);
  protected readonly logout = LucideLogOut;
  protected readonly themes: { mode: ThemeMode; label: string; icon: LucideIcon }[] = [
    { mode: 'light', label: 'Light', icon: LucideSun },
    { mode: 'dark', label: 'Dark', icon: LucideMoon },
    { mode: 'system', label: 'System', icon: LucideMonitor },
  ];

  protected readonly slug = computed(
    () => this.store.slug() ?? this.session.workspace()?.slug ?? '',
  );
  protected readonly wsName = computed(
    () => this.store.workspace()?.name ?? this.session.workspace()?.name ?? 'Workspace',
  );
  protected readonly meRef = computed(() => {
    const u = this.session.user();
    return u ? ({ type: 'user', id: u.id } as const) : null;
  });

  private visible(items: NavItem[]): NavItem[] {
    return items.filter((item) => {
      const mode = this.ui.sidebarVisibilityOf(item.segment);
      return mode === 'always' || (mode === 'badged' && this.badge(item.badge) > 0);
    });
  }

  protected badge(kind: NavItem['badge']): number {
    if (kind === 'inbox') return this.store.attentionCount() + this.notifications.updatesUnread();
    if (kind === 'issues') return this.store.backlogIssueCount();
    return 0;
  }

  protected openPublic(path: string): void {
    window.open(path, '_blank', 'noopener');
  }

  protected showChecklist(): void {
    this.ui.requestChecklist();
    this.go(['/', this.slug(), 'inbox']);
  }

  protected go(commands: string[]): void {
    void this.router.navigate(commands);
    this.sidebar.setOpenMobile(false);
  }
}

/** A nav entry with its router path below the workspace. */
function withPath(item: NavItem): NavItem & { path: string[] } {
  return { ...item, path: [item.segment] };
}
