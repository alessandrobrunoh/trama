import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterLinkActive } from '@angular/router';
import { filter, map, startWith } from 'rxjs';
import {
  LucideArrowUpRight,
  LucideBell,
  LucideChartGantt,
  LucideBuilding2,
  LucideChevronDown,
  LucideEyeOff,
  LucideList,
  LucideLogIn,
  LucideLogOut,
  LucideSquareKanban,
  LucideChevronsUpDown,
  LucideCheck,
  LucideEllipsis,
  LucideInbox,
  LucideBox,
  LucidePlug,
  LucideDynamicIcon,
  LucidePanelLeft,
  LucidePlus,
  LucideSearch,
  LucideSettings,
  LucideUserRound,
  LucideX,
  type LucideIcon,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import { HlmSidebarImports, HlmSidebarService } from '@spartan-ng/helm/sidebar';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import { SharedProjectsStore } from '../core/stores/shared-projects.store';
import { NotificationsStore } from '../core/stores/notifications.store';
import { TimeEntriesStore } from '../core/stores/time-entries.store';
import { TramaStore } from '../core/stores/trama.store';
import { UiStore } from '../core/stores/ui.store';
import { SessionStore } from '../core/session/session.store';
import { ActorAvatar } from '../shared/actor-avatar';
import { TramaLogo } from '../shared/trama-logo';
import { ProjectGlyph } from '../features/projects/project-glyph';
import { SettingsSidebar } from '../features/settings/settings-sidebar';
import { settingsSectionOfUrl } from '../features/settings/settings-nav';
import { ago } from '../shared/ago';
import { queryItems } from '../core/query';
import type { Project, SavedView } from '../core/contracts/domain';
import {
  SIDEBAR_ALSO_ACTIVE,
  SIDEBAR_MAIN_NAV,
  SIDEBAR_WORKSPACE_NAV,
  navForRole,
  type NavItem,
} from './nav';

/**
 * Sidebar content (App · 14 Sidebar): workspace row with the switcher and the collapse button, "Search or
 * jump…", Home / Inbox / Time / Ask, a WORKSPACE group (Tasks, Projects, Views), Shared with me, then the
 * agent connector card and the user row (bell, settings gear). Mono uppercase section labels, 30px rows,
 * flat raised selected row.
 * Rendered inside <hlm-sidebar> by AppShell. On phones the shell shows <app-mobile-nav> instead.
 */
@Component({
  selector: 'app-sidebar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    TramaLogo,
    NgTemplateOutlet,
    RouterLink,
    RouterLinkActive,
    LucideDynamicIcon,
    HlmSidebarImports,
    HlmDropdownMenuImports,
    HlmButtonImports,
    HlmTooltip,
    ActorAvatar,
    ProjectGlyph,
    SettingsSidebar,
  ],
  host: { class: 'flex h-full min-h-0 flex-col' },
  template: `
    @if (inSettings()) {
      <!-- a settings page replaces this sidebar with the settings sidebar (features/settings) -->
      <app-settings-sidebar class="min-h-0 flex-1" />
    } @else {
    <div hlmSidebarHeader class="gap-0 p-0">
      <!-- workspace row (44px): logo, workspace name in serif, mono "acme · 6 members", switcher chevrons, panel toggle -->
      <div class="border-sidebar-border flex h-11 items-center gap-2.5 border-b px-3.5">
        @if (canSwitch()) {
          <button
            type="button"
            class="group/ws focus-visible:ring-sidebar-ring flex min-w-0 flex-1 items-center gap-2.5 text-start outline-hidden focus-visible:ring-2"
            [hlmDropdownMenuTrigger]="workspaceMenu"
            align="start"
            aria-label="Switch workspace"
          >
            <ng-container *ngTemplateOutlet="wsIdentity" />
            <span class="flex-1"></span>
            <svg
              [lucideIcon]="chevrons"
              [size]="13"
              class="text-faint group-hover/ws:text-foreground group-data-open/ws:text-foreground shrink-0"
            ></svg>
          </button>
        } @else {
          <!-- one personal workspace and nothing shared: nothing to switch to, so no chevrons -->
          <div class="flex min-w-0 flex-1 items-center gap-2.5">
            <ng-container *ngTemplateOutlet="wsIdentity" />
          </div>
        }
        <button
          type="button"
          class="text-faint hover:text-foreground focus-visible:ring-sidebar-ring flex size-[14px] shrink-0 items-center justify-center outline-hidden focus-visible:ring-2"
          hlmTooltip="Hide sidebar  ⌘B"
          position="bottom"
          aria-label="Hide sidebar (⌘B)"
          (click)="sidebar.toggleSidebar()"
        >
          <svg [lucideIcon]="sidebarIcon" [size]="14"></svg>
        </button>
      </div>

      <!-- search or jump (opens the command palette) -->
      <div class="px-3 py-2.5">
        <button
          type="button"
          class="bg-background border-border text-faint hover:text-muted-foreground hover:border-border-strong focus-visible:ring-sidebar-ring flex h-[30px] w-full items-center gap-2 border px-2 text-start outline-hidden focus-visible:ring-2"
          aria-label="Search or jump (⌘K)"
          (click)="ui.openCommandPalette()"
        >
          <svg [lucideIcon]="search" [size]="13" class="shrink-0"></svg>
          <span class="min-w-0 flex-1 truncate font-mono text-[11.5px]">Search or jump…</span>
          <kbd class="bg-secondary border-border text-muted-foreground shrink-0 border px-[5px] font-mono text-[10.5px] leading-[1.3]">{{ searchKeys }}</kbd>
        </button>
      </div>
    </div>

    <div hlmSidebarContent class="gap-0 p-0">
      <!-- Home, Inbox, Time, Ask -->
      <ul class="flex flex-col gap-px px-2 py-1.5">
        @for (item of mainNav(); track item.segment) {
          <ng-container *ngTemplateOutlet="navRow; context: { $implicit: item }" />
        }
      </ul>

      <!-- WORKSPACE: Tasks, then Projects and Views -->
      <div class="border-sidebar-border flex flex-col gap-px border-t px-2 pt-1 pb-1.5">
        <div class="flex items-center gap-2 px-2 pt-3 pb-1.5">
          <span class="text-muted-foreground font-mono text-[10px] leading-[1.3] tracking-[0.6px]">WORKSPACE</span>
          <span class="bg-border h-px flex-1" aria-hidden="true"></span>
        </div>
        @for (item of workspaceNav(); track item.segment) {
          <ul class="flex flex-col gap-px">
            <ng-container *ngTemplateOutlet="navRow; context: { $implicit: item }" />
          </ul>
        }

        <!-- Projects: glyph in the project colour, open task count on the right, "shared" for the ones placed here -->
        <ng-container
          *ngTemplateOutlet="subLabel; context: { $implicit: 'projects', label: 'PROJECTS', create: 'project', createLabel: 'New project' }"
        />
        @if (!ui.isFolded('projects')) {
          <ul class="flex flex-col gap-px">
            @for (r of projectRowsShown(); track r.key) {
              <li class="group/proj relative">
                <a
                  [routerLink]="r.link"
                  routerLinkActive
                  #pla="routerLinkActive"
                  [class]="pla.isActive ? rowOn : rowOff"
                  [attr.title]="r.title"
                  (click)="closeMobile()"
                >
                  <app-project-glyph [project]="r.project" [size]="15" />
                  <span class="truncate-fade min-w-0 flex-1">{{ r.project.name }}</span>
                  @if (r.shared) {
                    <span class="text-faint font-mono text-[11px] group-hover/proj:invisible">shared</span>
                  } @else if (r.open) {
                    <span class="text-faint font-mono text-[11px] tabular-nums">{{ r.open }}</span>
                  }
                </a>
                @if (r.shared) {
                  <button
                    type="button"
                    class="text-muted-foreground hover:text-foreground hover:bg-sidebar-accent absolute top-1/2 right-1 flex size-5 -translate-y-1/2 items-center justify-center rounded-sm opacity-0 group-hover/proj:opacity-100 focus-visible:opacity-100 max-md:opacity-100"
                    [attr.aria-label]="'Stop showing ' + r.project.name + ' here'"
                    hlmTooltip="Back to Shared with me"
                    (click)="shared.clear(r.project.id)"
                  >
                    <svg [lucideIcon]="closeIcon" [size]="12"></svg>
                  </button>
                }
              </li>
            } @empty {
              @if (store.can('member')) {
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
            }
            @if (projectsHidden() > 0 || projectsExpanded()) {
              <ng-container
                *ngTemplateOutlet="viewMore; context: { expanded: projectsExpanded(), hidden: projectsHidden(), toggle: toggleProjects }"
              />
            }
          </ul>
        }

        <!-- Views: saved views, icon by layout, matching count on the right -->
        @if (!store.isGuest()) {
          <ng-container
            *ngTemplateOutlet="subLabel; context: { $implicit: 'views', label: 'VIEWS', create: 'view', createLabel: 'New view' }"
          />
          @if (!ui.isFolded('views')) {
            <ul class="flex flex-col gap-px">
              @for (v of viewRowsShown(); track v.view.id) {
                <li>
                  <a
                    [routerLink]="['/', slug(), 'views', v.view.id]"
                    routerLinkActive
                    #vla="routerLinkActive"
                    [class]="vla.isActive ? rowOn : rowOff"
                    [attr.title]="v.view.name"
                    (click)="closeMobile()"
                  >
                    <svg [lucideIcon]="v.icon" [size]="15" class="shrink-0"></svg>
                    <span class="truncate-fade min-w-0 flex-1">{{ v.view.name }}</span>
                    @if (v.count) {
                      <span class="text-faint font-mono text-[11px] tabular-nums">{{ v.count }}</span>
                    }
                  </a>
                </li>
              }
              @if (viewsHidden() > 0 || viewsExpanded()) {
                <ng-container
                  *ngTemplateOutlet="viewMore; context: { expanded: viewsExpanded(), hidden: viewsHidden(), toggle: toggleViews }"
                />
              }
            </ul>
          }
        }
      </div>

      <!-- Shared with me: projects where the person is a guest and has not placed them in a workspace -->
      @if (shared.unplaced().length || hiddenShared().length) {
        <div class="border-sidebar-border flex flex-col gap-px border-t px-2 pt-2.5 pb-1.5">
          <button
            type="button"
            class="text-faint hover:text-muted-foreground focus-visible:ring-sidebar-ring flex items-center text-start font-mono text-[10px] leading-[1.3] outline-hidden focus-visible:ring-2"
            [attr.aria-expanded]="!ui.isFolded('shared')"
            (click)="ui.toggleFolded('shared')"
          >
            SHARED WITH ME
          </button>
          @if (!ui.isFolded('shared')) {
            <ul class="flex flex-col gap-px">
              @for (s of shared.unplaced(); track s.id) {
                <ng-container *ngTemplateOutlet="sharedRow; context: { $implicit: s }" />
              }
              @if (hiddenShared().length) {
                <li>
                  <button
                    type="button"
                    class="text-faint hover:text-foreground px-2.5 py-1 font-mono text-[11px]"
                    [attr.aria-expanded]="showHidden()"
                    (click)="showHidden.set(!showHidden())"
                  >
                    {{ showHidden() ? 'Hide ' : '' }}{{ hiddenShared().length }} hidden
                  </button>
                </li>
                @if (showHidden()) {
                  @for (s of hiddenShared(); track s.id) {
                    <ng-container *ngTemplateOutlet="sharedRow; context: { $implicit: s }" />
                  }
                }
              }
            </ul>
          }
        </div>
      }
    </div>

    <!-- footer: agent connector card, then the user row -->
    <div hlmSidebarFooter class="gap-0 p-0 pb-[env(safe-area-inset-bottom)]">
      @if (!store.isGuest()) {
        <div class="border-sidebar-border flex flex-col gap-2 border-t px-3.5 py-2.5">
          <a
            [routerLink]="['/', slug(), 'connect']"
            class="bg-secondary border-border text-foreground hover:border-border-strong focus-visible:ring-sidebar-ring flex items-center gap-2 border px-2 py-1.5 text-[12.5px] leading-[1.3] outline-hidden focus-visible:ring-2"
            hlmTooltip="Connect Delta and your agent: install the /trama skill or the CLI"
            position="top"
            (click)="closeMobile()"
          >
            <svg [lucideIcon]="plugIcon" [size]="13" class="text-primary shrink-0"></svg>
            <span class="min-w-0 flex-1 truncate">Connect your agent</span>
            <svg [lucideIcon]="arrowUpRight" [size]="12" class="text-faint shrink-0"></svg>
          </a>
          <span class="flex items-center gap-2">
            <span class="size-[7px] shrink-0" [class]="agentSeen() ? 'bg-status-done' : 'bg-faint'" aria-hidden="true"></span>
            <span class="text-foreground font-mono text-[10.5px] leading-[1.3]">Delta · /trama skill</span>
          </span>
          <span class="text-faint truncate font-mono text-[10px] leading-[1.3]">{{ agentSub() }}</span>
        </div>
      }
      <div class="border-sidebar-border flex items-center gap-2.5 border-t px-3.5 py-2.5">
        <a
          [routerLink]="['/', slug(), 'settings', 'profile']"
          class="text-foreground hover:text-sidebar-accent-foreground focus-visible:ring-sidebar-ring flex min-w-0 flex-1 items-center gap-2.5 text-start outline-hidden focus-visible:ring-2"
          aria-label="Profile"
          (click)="closeMobile()"
        >
          <app-actor-avatar [actor]="meRef()" [size]="22" />
          <span class="min-w-0 flex-1 truncate text-[12.5px]">{{ session.user()?.name ?? 'Account' }}</span>
        </a>
        <a
          [routerLink]="['/', slug(), 'inbox']"
          class="text-faint hover:text-foreground relative flex size-[14px] shrink-0 items-center justify-center outline-hidden focus-visible:ring-2 focus-visible:ring-sidebar-ring"
          hlmTooltip="Inbox  G then A"
          position="top"
          [attr.aria-label]="inboxCount() ? 'Inbox, ' + inboxCount() + ' need you' : 'Inbox'"
          (click)="closeMobile()"
        >
          <svg [lucideIcon]="bellIcon" [size]="14"></svg>
        </a>
        <a
          [routerLink]="settingsLink()"
          class="text-faint hover:text-foreground flex size-[14px] shrink-0 items-center justify-center outline-hidden focus-visible:ring-2 focus-visible:ring-sidebar-ring"
          hlmTooltip="Settings  G then S"
          position="top"
          aria-label="Settings"
          (click)="closeMobile()"
        >
          <svg [lucideIcon]="settings" [size]="14"></svg>
        </a>
      </div>
    </div>

    }

    <!-- mono section label ("PROJECTS") with its "+" action at the right; the label folds the list -->
    <ng-template #subLabel let-id let-label="label" let-create="create" let-createLabel="createLabel">
      <div class="flex items-center px-2 pt-2.5 pb-1">
        <button
          type="button"
          class="text-faint hover:text-muted-foreground focus-visible:ring-sidebar-ring flex flex-1 items-center text-start font-mono text-[10px] leading-[1.3] outline-hidden focus-visible:ring-2"
          (click)="ui.toggleFolded(id)"
          [attr.aria-expanded]="!ui.isFolded(id)"
        >
          {{ label }}
        </button>
        @if (create && store.can('member')) {
          <button
            type="button"
            class="text-faint hover:text-foreground focus-visible:ring-sidebar-ring flex size-3 items-center justify-center outline-hidden focus-visible:ring-2"
            [attr.aria-label]="createLabel"
            [hlmTooltip]="createLabel"
            (click)="ui.openCreate(create)"
          >
            <svg [lucideIcon]="plus" [size]="12"></svg>
          </button>
        }
      </div>
    </ng-template>

    <!-- "View more +5" / "View less" under a long list -->
    <ng-template #viewMore let-expanded="expanded" let-hidden="hidden" let-toggle="toggle">
      <li>
        <button
          type="button"
          class="text-faint hover:text-muted-foreground focus-visible:ring-sidebar-ring flex w-full items-center gap-2 px-2 py-[5px] text-start text-[12.5px] leading-[1.3] outline-hidden focus-visible:ring-2"
          [attr.aria-expanded]="expanded"
          (click)="toggle()"
        >
          <svg [lucideIcon]="chevronDown" [size]="13" class="shrink-0" [class.rotate-180]="expanded"></svg>
          <span class="flex-1">{{ expanded ? 'View less' : 'View more' }}</span>
          @if (!expanded) {
            <span class="font-mono text-[10.5px]">+{{ hidden }}</span>
          }
        </button>
      </li>
    </ng-template>

    <!-- logo, workspace name in serif and the mono line below it; shared by the switcher and the plain header -->
    <ng-template #wsIdentity>
      <app-trama-logo [size]="24" />
      <span class="flex min-w-0 flex-col gap-px">
        <span class="font-title text-foreground truncate text-[18px] leading-[18px]">{{ wsName() }}</span>
        <span class="text-faint truncate font-mono text-[10px] leading-[13px]">{{ wsSub() }}</span>
      </span>
    </ng-template>

    <!-- a project shared with me: glyph, name, the owning workspace's slug in mono, row menu -->
    <ng-template #sharedRow let-s>
      <li class="group/shared relative">
        <a
          [routerLink]="['/', s.workspace.slug, 'projects', s.id]"
          routerLinkActive
          #sha="routerLinkActive"
          [class]="sha.isActive ? rowOn : rowOff"
          [attr.title]="s.name + ' · ' + s.workspace.name"
          (click)="closeMobile()"
        >
          <app-project-glyph [project]="s" [size]="15" />
          <span class="truncate-fade min-w-0 flex-1">{{ s.name }}</span>
          <span class="text-faint max-w-[88px] truncate font-mono text-[11px] group-hover/shared:invisible">{{ s.workspace.slug }}</span>
        </a>
        <button
          type="button"
          class="text-muted-foreground hover:text-foreground hover:bg-sidebar-accent data-open:opacity-100 absolute top-1/2 right-1 flex size-5 -translate-y-1/2 items-center justify-center rounded-sm opacity-0 group-hover/shared:opacity-100 focus-visible:opacity-100 max-md:opacity-100"
          [attr.aria-label]="'Actions for ' + s.name"
          [hlmDropdownMenuTrigger]="sharedMenu"
          [hlmDropdownMenuTriggerData]="{ s: s }"
          align="start"
        >
          <svg [lucideIcon]="more" [size]="13"></svg>
        </button>
      </li>
    </ng-template>

    <ng-template #sharedMenu let-s="s">
      <hlm-dropdown-menu class="w-56">
        <hlm-dropdown-menu-group>
          <button hlmDropdownMenuItem (triggered)="go(['/', s.workspace.slug, 'projects', s.id])">
            <svg [lucideIcon]="arrowUpRight" [size]="14"></svg>
            Open
          </button>
          <button hlmDropdownMenuItem [hlmDropdownMenuSubTrigger]="showInMenu" [hlmDropdownMenuTriggerData]="{ s: s }">
            <svg [lucideIcon]="logInIcon" [size]="14"></svg>
            Show in
            <hlm-dropdown-menu-item-sub-indicator />
          </button>
          @if (s.placement) {
            <button hlmDropdownMenuItem (triggered)="shared.clear(s.id)">
              <svg [lucideIcon]="inboxIcon" [size]="14"></svg>
              Back to Shared with me
            </button>
          } @else {
            <button hlmDropdownMenuItem (triggered)="shared.hide(s.id)">
              <svg [lucideIcon]="eyeOffIcon" [size]="14"></svg>
              Hide from Shared with me
            </button>
          }
        </hlm-dropdown-menu-group>
        <hlm-dropdown-menu-separator />
        <button hlmDropdownMenuItem variant="destructive" (triggered)="shared.leave(s.id)">
          <svg [lucideIcon]="logout" [size]="14"></svg>
          Leave project
        </button>
      </hlm-dropdown-menu>
    </ng-template>

    <ng-template #showInMenu let-s="s">
      <hlm-dropdown-menu-sub class="w-64">
        <hlm-dropdown-menu-label class="text-faint font-mono text-[10px] uppercase">Your workspaces</hlm-dropdown-menu-label>
        <hlm-dropdown-menu-group>
          @for (w of session.workspaces(); track w.id) {
            <button hlmDropdownMenuItem (triggered)="shared.place(s.id, w.id)">
              <svg [lucideIcon]="w.personal ? user : buildingIcon" [size]="14" class="text-muted-foreground"></svg>
              <span class="flex-1 truncate text-start">{{ w.personal ? w.name + ' · personal' : w.name }}</span>
              @if (s.placement?.workspaceId === w.id) {
                <svg [lucideIcon]="check" [size]="14" class="text-muted-foreground"></svg>
              }
            </button>
          }
        </hlm-dropdown-menu-group>
        <hlm-dropdown-menu-separator />
        <p class="text-muted-foreground px-2 py-1.5 text-[11px] leading-snug">
          Only you see it there. Nobody in that workspace gets access.
        </p>
      </hlm-dropdown-menu-sub>
    </ng-template>

    <!-- one nav row (30px): icon, label, count; the row of the current page is lit -->
    <ng-template #navRow let-item>
      <li>
        <a
          [routerLink]="['/', slug(), item.segment]"
          [class]="isNavActive(item.segment) ? rowOn : rowOff"
          [attr.aria-current]="isNavActive(item.segment) ? 'page' : null"
          [attr.title]="item.hint ?? null"
          (click)="closeMobile()"
        >
          <svg [lucideIcon]="item.icon" [size]="15" class="shrink-0"></svg>
          <span class="truncate-fade min-w-0 flex-1">{{ item.label }}</span>
          @if (badge(item.badge, true); as n) {
            <span class="text-faint font-mono text-[11px] tabular-nums" [attr.aria-label]="n + ' pending'">{{ n }}</span>
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
              @if (w.personal) {
                <span class="text-faint font-mono text-[10px]">personal</span>
              }
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
        </hlm-dropdown-menu-group>
      </hlm-dropdown-menu>
    </ng-template>
  `,
})
export class AppSidebar {
  protected readonly ui = inject(UiStore);
  protected readonly shared = inject(SharedProjectsStore);
  protected readonly notifications = inject(NotificationsStore);
  protected readonly store = inject(TramaStore);
  protected readonly session = inject(SessionStore);
  private readonly timers = inject(TimeEntriesStore);
  protected readonly sidebar = inject(HlmSidebarService);
  private readonly router = inject(Router);

  protected readonly sidebarIcon = LucidePanelLeft;
  protected readonly inboxIcon = LucideInbox;
  protected readonly logInIcon = LucideLogIn;
  protected readonly eyeOffIcon = LucideEyeOff;
  protected readonly buildingIcon = LucideBuilding2;

  /** Row classes: 30px, 10px gap, 13px label; the current page gets the raised fill. */
  protected readonly rowOn =
    'focus-visible:ring-sidebar-ring flex h-[30px] w-full items-center gap-2.5 px-2.5 text-[13px] outline-hidden focus-visible:ring-2 bg-hover text-foreground';
  protected readonly rowOff =
    'focus-visible:ring-sidebar-ring flex h-[30px] w-full items-center gap-2.5 px-2.5 text-[13px] outline-hidden focus-visible:ring-2 text-muted-foreground hover:bg-hover/60 hover:text-foreground';
  protected readonly searchKeys = IS_MAC ? '⌘K' : 'Ctrl K';
  protected readonly chevronDown = LucideChevronDown;
  protected readonly arrowUpRight = LucideArrowUpRight;

  /** Home, Inbox, Time, Ask; a guest does not get Ask. */
  protected readonly mainNav = computed(() => navForRole(SIDEBAR_MAIN_NAV, this.store.isGuest()));
  /** Tasks, under the WORKSPACE rule. */
  protected readonly workspaceNav = computed(() =>
    navForRole(SIDEBAR_WORKSPACE_NAV, this.store.isGuest()),
  );

  /** The first path segment of the current URL (`tasks` for `/acme/tasks/UNPR-1`). */
  private readonly section = computed(() => {
    const segs = this.url().split(/[?#]/)[0].split('/').filter(Boolean);
    return segs[1] ?? '';
  });
  protected isNavActive(segment: string): boolean {
    const section = this.section();
    return section === segment || (SIDEBAR_ALSO_ACTIVE[segment]?.includes(section) ?? false);
  }
  /** The project of the current URL (`/acme/projects/pj_1/...`), so a long list never hides the open one. */
  private readonly openProjectId = computed(() => {
    const segs = this.url().split(/[?#]/)[0].split('/').filter(Boolean);
    return segs[1] === 'projects' ? (segs[2] ?? '') : '';
  });
  private readonly openViewId = computed(() => {
    const segs = this.url().split(/[?#]/)[0].split('/').filter(Boolean);
    return segs[1] === 'views' ? (segs[2] ?? '') : '';
  });

  /** Own active projects (with their open task count), then the shared ones placed in this workspace. */
  private readonly projectRows = computed<ProjectRow[]>(() => {
    const byProject = this.store.issuesByProject();
    const slug = this.slug();
    const own = this.store
      .projects()
      .filter((p) => p.status !== 'completed' && p.status !== 'canceled')
      .map<ProjectRow>((project) => ({
        key: project.id,
        project,
        link: ['/', slug, 'projects', project.id],
        title: project.name,
        open: (byProject.get(project.id) ?? []).filter(
          (i) => i.status !== 'done' && i.status !== 'canceled',
        ).length,
        shared: false,
      }));
    const placed = this.shared.placedHere().map<ProjectRow>((s) => ({
      key: 'shared:' + s.id,
      project: s as unknown as Project,
      link: ['/', s.workspace.slug, 'projects', s.id],
      title: s.name + ' · shared from ' + s.workspace.slug,
      open: 0,
      shared: true,
    }));
    return [...own, ...placed];
  });
  protected readonly projectsExpanded = signal(false);
  protected readonly toggleProjects = (): void => this.projectsExpanded.update((v) => !v);
  protected readonly projectRowsShown = computed(() => {
    const rows = this.projectRows();
    if (this.projectsExpanded()) return rows;
    const open = this.openProjectId();
    return rows.filter((r, i) => i < PROJECT_LIMIT || (!!open && r.project.id === open));
  });
  protected readonly projectsHidden = computed(
    () => this.projectRows().length - this.projectRowsShown().length,
  );

  /** Saved views: icon by layout, count of the tasks (or projects) they match; a timeline has no count. */
  private readonly viewRows = computed<ViewRow[]>(() => {
    if (this.store.isGuest()) return [];
    const issues = this.store.issues();
    const projects = this.store.projects();
    return this.store.views().map((view) => {
      const spec = { filters: view.filters };
      const count =
        view.layout === 'timeline'
          ? 0
          : view.entity === 'project'
            ? queryItems('project', projects, spec).length
            : queryItems('issue', issues, spec).length;
      const icon =
        view.layout === 'timeline'
          ? LucideChartGantt
          : view.layout === 'board'
            ? LucideSquareKanban
            : LucideList;
      return { view, icon, count };
    });
  });
  protected readonly viewsExpanded = signal(false);
  protected readonly toggleViews = (): void => this.viewsExpanded.update((v) => !v);
  protected readonly viewRowsShown = computed(() => {
    const rows = this.viewRows();
    if (this.viewsExpanded()) return rows;
    const open = this.openViewId();
    return rows.filter((r, i) => i < VIEW_LIMIT || (!!open && r.view.id === open));
  });
  protected readonly viewsHidden = computed(() => this.viewRows().length - this.viewRowsShown().length);

  /** The gear in the user row: workspace settings, or the profile for a guest. */
  protected readonly settingsLink = computed(() => [
    '/',
    this.slug(),
    'settings',
    this.store.isGuest() ? 'profile' : 'workspace',
  ]);
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
  protected readonly inboxCount = computed(() => this.badge('inbox'));
  protected readonly more = LucideEllipsis;
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
  /** On a settings page this sidebar gives way to the settings sidebar. */
  protected readonly inSettings = computed(() => settingsSectionOfUrl(this.url()) !== null);
  protected readonly bellIcon = LucideBell;
  protected readonly chevrons = LucideChevronsUpDown;
  protected readonly search = LucideSearch;
  protected readonly plus = LucidePlus;
  protected readonly check = LucideCheck;
  protected readonly settings = LucideSettings;
  protected readonly user = LucideUserRound;
  protected readonly plugIcon = LucidePlug;
  protected readonly logout = LucideLogOut;

  protected readonly slug = computed(
    () => this.store.slug() ?? this.session.workspace()?.slug ?? '',
  );
  protected readonly wsName = computed(
    () => this.store.workspace()?.name ?? this.session.workspace()?.name ?? 'Workspace',
  );
  /** The open workspace is the person's own: named after them, nobody else can be added to leave or take it over. */
  protected readonly isPersonal = computed(
    () => (this.store.workspace() ?? this.session.workspace())?.personal === true,
  );
  /** The switcher shows once there is somewhere else to go: a second workspace or a shared project. */
  protected readonly canSwitch = computed(
    () => this.session.workspaces().length > 1 || this.shared.any(),
  );
  /** Shared projects the person hid from Shared with me; they can be brought back from there. */
  protected readonly hiddenShared = computed(() =>
    this.shared.items().filter((p) => p.placement && !p.placement.workspaceId),
  );
  protected readonly showHidden = signal(false);
  /** "acme · 6 members" under the workspace name; "personal workspace" for the person's own. */
  protected readonly wsSub = computed(() => {
    if (this.isPersonal()) {
      const others = this.session.workspaces().length - 1;
      const sharedCount = this.shared.items().length;
      if (others > 0) return `personal · ${others} more ${others === 1 ? 'workspace' : 'workspaces'}`;
      if (sharedCount > 0) return `personal · ${sharedCount} shared ${sharedCount === 1 ? 'project' : 'projects'}`;
      return 'personal workspace';
    }
    const n = this.store.memberships().length;
    const slug = this.slug();
    return n ? `${slug} · ${n} ${n === 1 ? 'member' : 'members'}` : slug;
  });
  protected readonly meRef = computed(() => {
    const u = this.session.user();
    return u ? ({ type: 'user', id: u.id } as const) : null;
  });

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
  /** My tracked time today, "6h 20m". */
  private readonly weekTime = computed(() => {
    const me = this.session.user()?.id;
    const start = new Date();
    start.setHours(0, 0, 0, 0);
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

  protected go(commands: string[]): void {
    void this.router.navigate(commands);
    this.sidebar.setOpenMobile(false);
  }

  protected closeMobile(): void {
    this.sidebar.setOpenMobile(false);
  }
}

const IS_MAC =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Rows shown before "View more": Pen lists four projects and three views. */
const PROJECT_LIMIT = 4;
const VIEW_LIMIT = 3;

interface ProjectRow {
  key: string;
  project: Project;
  link: string[];
  title: string;
  open: number;
  shared: boolean;
}

interface ViewRow {
  view: SavedView;
  icon: LucideIcon;
  count: number;
}
