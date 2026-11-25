import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterLinkActive } from '@angular/router';
import { filter, map, startWith } from 'rxjs';
import {
  LucideBell,
  LucideSquare,
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
import { TimeEntriesStore } from '../core/stores/time-entries.store';
import { TramaStore } from '../core/stores/trama.store';
import { UiStore } from '../core/stores/ui.store';
import { SessionStore } from '../core/session/session.store';
import { ThemeService, type ThemeMode } from '../core/theme';
import { ActorAvatar } from '../shared/actor-avatar';
import { Kbd } from '../shared/kbd';
import { StatusIcon } from '../shared/status';
import { CHANGELOG } from '../features/changelog/changelog-entries';
import { ProjectGlyph } from '../features/projects/project-glyph';
import { ago } from '../shared/ago';
import { MORE_NAV, PRIMARY_NAV, orderNav, type NavItem } from './nav';

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
  ],
  host: { class: 'flex h-full min-h-0 flex-col' },
  template: `
    <div hlmSidebarHeader class="gap-0 p-0">
      <!-- top row: three window marks, the panel toggle on the right -->
      <div class="flex items-center gap-2 px-3.5 pt-3.5 pb-2.5">
        <span class="flex gap-1.5" aria-hidden="true">
          <span class="size-[9px] bg-[#33363c]"></span>
          <span class="size-[9px] bg-[#33363c]"></span>
          <span class="size-[9px] bg-[#33363c]"></span>
        </span>
        <span class="flex-1"></span>
        <button
          type="button"
          class="text-faint hover:text-foreground focus-visible:ring-sidebar-ring -m-1 flex size-[22px] items-center justify-center outline-hidden focus-visible:ring-2"
          hlmTooltip="Hide sidebar  ⌘B"
          position="bottom"
          aria-label="Hide sidebar (⌘B)"
          (click)="sidebar.toggleSidebar()"
        >
          <svg [lucideIcon]="sidebarIcon" [size]="14"></svg>
        </button>
      </div>
      <!-- workspace: red "T" mark, "Trama" in serif, mono "acme · 6 members" -->
      <button
        type="button"
        class="hover:bg-sidebar-accent/50 data-open:bg-sidebar-accent focus-visible:ring-sidebar-ring flex items-center gap-2.5 px-3.5 pt-1 pb-3 text-start outline-hidden focus-visible:ring-2"
        [hlmDropdownMenuTrigger]="workspaceMenu"
        align="start"
        aria-label="Switch workspace"
      >
        <span
          class="bg-brand font-title flex size-6 shrink-0 items-center justify-center text-[16px] leading-none text-white"
          aria-hidden="true"
          >T</span
        >
        <span class="flex min-w-0 flex-col gap-px">
          <span class="font-title text-foreground text-[18px] leading-[18px]">Trama</span>
          <span class="text-faint truncate font-mono text-[10px] leading-[13px]">{{ wsSub() }}</span>
        </span>
        <span class="flex-1"></span>
        <svg [lucideIcon]="chevrons" [size]="13" class="text-faint shrink-0"></svg>
      </button>

      <!-- search or jump (opens the command palette) -->
      <div class="px-3 pb-2.5">
        <button
          type="button"
          class="bg-background border-border text-faint hover:text-muted-foreground hover:border-border-strong focus-visible:ring-sidebar-ring flex h-[30px] w-full items-center gap-2 border px-2 text-start outline-hidden focus-visible:ring-2"
          aria-label="Search or jump (⌘K)"
          (click)="ui.openCommandPalette()"
        >
          <svg [lucideIcon]="search" [size]="13" class="shrink-0"></svg>
          <span class="min-w-0 flex-1 truncate font-mono text-[11.5px]">Search or jump…</span>
          <app-kbd keys="mod+k" />
        </button>
      </div>
    </div>

    <div hlmSidebarContent class="gap-0 px-2 pb-2">
      <ul hlmSidebarMenu class="gap-px py-1.5">
        @for (item of primary(); track item.segment) {
          <ng-container *ngTemplateOutlet="navLink; context: { $implicit: item }" />
        }
      </ul>

      <!-- Pinned: only once something is pinned -->
      @if (favorites.entries().length) {
        <div class="mt-4">
          <ng-container *ngTemplateOutlet="sectionLabel; context: { $implicit: 'favorites', label: 'Pinned' }" />
          @if (!ui.isFolded('favorites')) {
            <ul hlmSidebarMenu class="mt-px gap-px">
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

      <!-- Projects: flat list, open task count on the right -->
      <div class="py-1.5">
        <ng-container
          *ngTemplateOutlet="
            sectionLabel;
            context: { $implicit: 'projects', label: 'Projects', all: 'projects', allLabel: 'All projects', create: 'project', createLabel: 'New project' }
          "
        />
        @if (!ui.isFolded('projects')) {
          <ul hlmSidebarMenu class="mt-px gap-px">
            @for (p of projectRows(); track p.project.id) {
              <li hlmSidebarMenuItem>
                <a
                  hlmSidebarMenuButton
                  [routerLink]="['/', slug(), 'projects', p.project.id]"
                  routerLinkActive
                  #pla="routerLinkActive"
                  [isActive]="pla.isActive"
                  [tooltip]="p.project.name"
                  closeMobileSidebarOnClick
                >
                  <svg [lucideIcon]="squareIcon" [size]="15" class="text-muted-foreground group-data-active/menu-button:text-foreground"></svg>
                  <span class="truncate-fade flex-1">{{ p.project.name }}</span>
                  @if (p.open) {
                    <span class="text-faint font-mono text-[11px] tabular-nums">{{ p.open }}</span>
                  }
                </a>
              </li>
            } @empty {
              <li>
                <button
                  type="button"
                  class="text-faint hover:text-foreground px-2.5 py-1 font-mono text-[11px]"
                  (click)="ui.openCreate('project')"
                >
                  + New project
                </button>
              </li>
            }
          </ul>
        }
      </div>

      <!-- Workspace: Settings (everything else stays one keystroke away: ⌘K, G chords) -->
      <div class="py-1.5">
        <ng-container *ngTemplateOutlet="sectionLabel; context: { $implicit: 'workspace', label: 'Workspace' }" />
        @if (!ui.isFolded('workspace')) {
          <ul hlmSidebarMenu class="mt-px gap-px">
            <ng-container *ngTemplateOutlet="navLink; context: { $implicit: settingsItem }" />
          </ul>
        }
      </div>
    </div>

    <!-- footer: agent connector, then the user row -->
    <div hlmSidebarFooter class="gap-0 p-0 pb-[env(safe-area-inset-bottom)]">
      <a
        [routerLink]="['/', slug(), 'connect']"
        class="border-sidebar-border hover:bg-sidebar-accent/50 flex flex-col gap-1 border-t px-3.5 py-2.5 outline-hidden focus-visible:ring-2 focus-visible:ring-sidebar-ring"
        hlmTooltip="Connect Delta and your agent: install the /trama skill or the CLI"
        position="top"
        closeMobileSidebarOnClick
      >
        <span class="flex items-center gap-2">
          <span class="size-[7px] shrink-0" [class]="agentSeen() ? 'bg-status-done' : 'bg-faint'" aria-hidden="true"></span>
          <span class="text-foreground font-mono text-[10.5px] leading-[15px]">Delta · /trama skill</span>
        </span>
        <span class="text-faint truncate font-mono text-[10px] leading-[13px]">{{ agentSub() }}</span>
      </a>
      <div class="border-sidebar-border flex items-center gap-2.5 border-t px-3.5 py-2.5">
        <button
          type="button"
          class="text-foreground hover:text-sidebar-accent-foreground data-open:text-sidebar-accent-foreground focus-visible:ring-sidebar-ring flex min-w-0 flex-1 items-center gap-2.5 text-start outline-hidden focus-visible:ring-2"
          [hlmDropdownMenuTrigger]="userMenu"
          align="start"
          side="top"
          aria-label="User menu"
        >
          <app-actor-avatar [actor]="meRef()" [size]="22" />
          <span class="min-w-0 flex-1 truncate text-[12.5px]">{{ session.user()?.name ?? 'Account' }}</span>
        </button>
        <a
          [routerLink]="['/', slug(), 'inbox']"
          class="text-faint hover:text-foreground relative flex size-[14px] shrink-0 items-center justify-center outline-hidden focus-visible:ring-2 focus-visible:ring-sidebar-ring"
          hlmTooltip="Inbox  G then A"
          position="top"
          [attr.aria-label]="inboxCount() ? 'Inbox, ' + inboxCount() + ' need you' : 'Inbox'"
          closeMobileSidebarOnClick
        >
          <svg [lucideIcon]="bellIcon" [size]="14"></svg>
        </a>
      </div>
    </div>

    <!-- mono uppercase section label ("PROJECTS"); the fold chevron and actions show on hover / focus -->
    <ng-template #sectionLabel let-id let-label="label" let-all="all" let-allLabel="allLabel" let-create="create" let-createLabel="createLabel">
      <div class="group/sec flex h-[13px] items-center">
        <button
          type="button"
          class="text-faint hover:text-muted-foreground focus-visible:ring-sidebar-ring flex flex-1 items-center font-mono text-[10px] leading-none uppercase outline-hidden focus-visible:ring-2"
          (click)="ui.toggleFolded(id)"
          [attr.aria-expanded]="!ui.isFolded(id)"
        >
          {{ label }}
        </button>
        @if (all) {
          <a
            [routerLink]="['/', slug(), all]"
            class="text-muted-foreground hover:text-foreground flex size-4 items-center justify-center opacity-0 group-hover/sec:opacity-100 group-focus-within/sec:opacity-100 focus-visible:opacity-100"
            [hlmTooltip]="allLabel"
            [attr.aria-label]="allLabel"
            closeMobileSidebarOnClick
            ><svg [lucideIcon]="more" [size]="13"></svg
          ></a>
        }
        @if (create) {
          <button
            type="button"
            class="text-muted-foreground hover:text-foreground flex size-4 items-center justify-center opacity-0 group-hover/sec:opacity-100 group-focus-within/sec:opacity-100 focus-visible:opacity-100"
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
          @if (badge(item.badge, true); as n) {
            @if (ui.sidebarBadgeStyle() === 'dot') {
              <span
                class="size-[5px] shrink-0"
                [class.bg-primary]="item.badge === 'inbox'"
                [class.bg-faint]="item.badge !== 'inbox'"
                role="img"
                [attr.aria-label]="n + ' pending'"
              ></span>
            } @else {
              <span class="text-faint font-mono text-[11px] tabular-nums" [attr.aria-label]="n + ' pending'">{{ n }}</span>
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
          <button hlmDropdownMenuItem (triggered)="go(['/', slug(), 'connect'])">
            <svg [lucideIcon]="plugIcon" [size]="14"></svg>
            Connect your agent
          </button>
          <button hlmDropdownMenuItem (triggered)="showChecklist()">
            <svg [lucideIcon]="checklistIcon" [size]="14"></svg>
            Setup checklist
          </button>
          <button hlmDropdownMenuItem (triggered)="openPublic('/changelog')">
            <svg [lucideIcon]="bookIcon" [size]="14"></svg>
            What's new
            <svg [lucideIcon]="externalIcon" [size]="12" class="text-muted-foreground ms-auto"></svg>
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
  private readonly timers = inject(TimeEntriesStore);
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
  /** "More" entries. "Only when badged" entries drop out while their badge is empty. */
  protected readonly moreItems = computed(() =>
    this.visible(orderNav(MORE_NAV, this.ui.sidebarOrder().workspace)).map(withPath),
  );
  /** Active projects with their open (not done / canceled) task count. */
  protected readonly projectRows = computed(() => {
    const byProject = this.store.issuesByProject();
    return this.store
      .projects()
      .filter((p) => p.status !== 'completed' && p.status !== 'canceled')
      .map((project) => ({
        project,
        open: (byProject.get(project.id) ?? []).filter(
          (i) => i.status !== 'done' && i.status !== 'canceled',
        ).length,
      }));
  });
  /** Most recent use of any workspace API token: the closest honest signal of "the agent synced". */
  private readonly lastAgentUse = computed(() => {
    let last: string | undefined;
    for (const t of this.store.tokens()) {
      if (t.lastUsedAt && (!last || t.lastUsedAt > last)) last = t.lastUsedAt;
    }
    return last;
  });
  protected readonly agentSeen = computed(() => !!this.lastAgentUse());
  protected readonly agentSub = computed(() => {
    const last = this.lastAgentUse();
    return last ? `last agent sync ${ago(last)}` : 'not connected yet · set up';
  });
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
  protected readonly squareIcon = LucideSquare;
  protected readonly bellIcon = LucideBell;
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
  protected readonly wsInitial = computed(() => this.wsName().trim().charAt(0).toUpperCase() || 'T');
  /** "acme · 6 members" under the workspace name. */
  protected readonly wsSub = computed(() => {
    const n = this.store.memberships().length;
    const slug = this.slug();
    return n ? `${slug} · ${n} ${n === 1 ? 'member' : 'members'}` : slug;
  });
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

  /** My open tasks (not done / canceled / draft). */
  private readonly mineCount = computed(() => {
    const me = this.session.user()?.id;
    if (!me) return 0;
    return this.store
      .issues()
      .filter((i) => i.assigneeId === me && !['done', 'canceled', 'draft'].includes(i.status)).length;
  });
  /** Every task except drafts. */
  private readonly taskCount = computed(
    () => this.store.issues().filter((i) => i.status !== 'draft').length,
  );
  /** My tracked time since Monday, "6h 20m". */
  private readonly weekTime = computed(() => {
    const me = this.session.user()?.id;
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
    const from = start.getTime();
    let ms = 0;
    for (const e of this.timers.entries()) {
      if (e.userId !== me) continue;
      const s = Date.parse(e.startedAt);
      if (s < from) continue;
      ms += (e.endedAt ? Date.parse(e.endedAt) : Date.now()) - s;
    }
    const m = Math.floor(ms / 60000);
    if (m < 1) return '';
    return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
  });

  protected badge(kind: NavItem['badge']): number;
  protected badge(kind: NavItem['badge'], text: true): string | number;
  protected badge(kind: NavItem['badge'], text?: true): string | number {
    if (kind === 'inbox') return this.store.attentionCount() + this.notifications.updatesUnread();
    if (kind === 'issues') return this.taskCount();
    if (kind === 'mine') return this.mineCount();
    if (kind === 'time') return text ? this.weekTime() : this.weekTime() ? 1 : 0;
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
