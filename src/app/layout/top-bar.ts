import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink } from '@angular/router';
import {
  LucideChevronRight,
  LucideDynamicIcon,
  LucideInbox,
  LucidePanelLeft,
  LucidePanelRight,
  LucideSearch,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmSidebarService } from '@spartan-ng/helm/sidebar';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import { filter, map, startWith } from 'rxjs';
import { FavoritesStore } from '../core/stores/favorites.store';
import { NotificationsStore } from '../core/stores/notifications.store';
import { RightPaneStore } from '../core/stores/right-pane.store';
import { TramaStore } from '../core/stores/trama.store';
import { UiStore } from '../core/stores/ui.store';
import { SyncStatus } from '../core/sync/sync-status';
import { Viewport } from '../core/viewport';
import { AvatarStack } from '../shared/actor-avatar';
import { FavoriteButton } from '../shared/favorite-button';
import { SECTIONS_WITH_LIST, SECTION_LABELS } from './nav';
import { PANE_SECTIONS } from './right-pane';
import { PageChrome, type Crumb } from './page-chrome';

/**
 * Main pane header (one slim row, `h-11`): [sidebar toggle + search + inbox, only while the sidebar
 * is collapsed] page title (muted parents, regular weight) · favorite star · stacked avatars of the
 * people involved · live-sync dot … text+icon actions (the page's `appTopBarActions` slot) · the
 * right pane toggle. The sidebar and right pane have their own header rows; all three share the
 * height so the hairline under them reads as one line.
 */
@Component({
  selector: 'app-top-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    NgTemplateOutlet,
    RouterLink,
    LucideDynamicIcon,
    HlmButtonImports,
    HlmTooltip,
    AvatarStack,
    FavoriteButton,
  ],
  host: {
    class:
      'bg-background border-border sticky top-0 z-10 flex h-11 shrink-0 items-center gap-2.5 border-b px-5 max-md:hidden',
  },
  template: `
    @if (!viewport.isMobile()) {
      @if (sidebarCollapsed()) {
        <div class="-ml-1 flex items-center gap-0.5">
          <button
            hlmBtn
            variant="ghost"
            size="icon-sm"
            class="text-muted-foreground"
            hlmTooltip="Show sidebar  ⌘B"
            position="bottom"
            aria-label="Show sidebar (⌘B)"
            (click)="sidebar.toggleSidebar()"
          >
            <svg [lucideIcon]="panelLeft" [size]="16"></svg>
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
          <a
            hlmBtn
            variant="ghost"
            size="icon-sm"
            class="text-muted-foreground relative"
            [routerLink]="['/', slug(), 'inbox']"
            hlmTooltip="Inbox"
            position="bottom"
            aria-label="Inbox"
          >
            <svg [lucideIcon]="inbox" [size]="16"></svg>
            @if (inboxCount() > 0) {
              <span class="bg-primary ring-background absolute top-1 right-1 size-1.5 rounded-full ring-2" aria-hidden="true"></span>
            }
          </a>
        </div>
      }

      <!-- v3: "acme / Web app / TRM-128 / Title": parents in faint mono, the page in sans -->
      <nav aria-label="Breadcrumb" class="flex min-w-0 items-center">
        <ol class="flex min-w-0 items-center gap-1.5">
          <li class="flex shrink-0 items-center gap-1.5">
            <a
              [routerLink]="['/', slug(), 'overview']"
              class="text-faint hover:text-foreground font-mono text-[11.5px] transition-colors"
              >{{ slug() }}</a
            >
            <span class="text-faint font-mono text-[11.5px]" aria-hidden="true">/</span>
          </li>
          @for (c of crumbs(); track $index; let last = $last) {
            <li class="flex min-w-0 items-center gap-1.5" [class.shrink-0]="!last">
              @if (c.link && !last) {
                <a
                  [routerLink]="c.link"
                  class="text-faint hover:text-foreground truncate font-mono text-[11.5px] transition-colors"
                  >{{ c.label }}</a
                >
              } @else if (last) {
                <span
                  class="text-foreground truncate text-[13px]"
                  [class.font-mono]="c.mono"
                  aria-current="page"
                  >{{ c.label }}</span
                >
              } @else {
                <span class="text-faint truncate font-mono text-[11.5px]">{{ c.label }}</span>
              }
              @if (!last) {
                <span class="text-faint font-mono text-[11.5px]" aria-hidden="true">/</span>
              }
            </li>
          }
        </ol>
      </nav>

      @if (actors().length) {
        <app-avatar-stack [actors]="actors()" [max]="3" [size]="20" class="ms-1 shrink-0" />
      }

      @if (favoriteTarget(); as t) {
        <app-favorite-button [type]="t.type" [subjectId]="t.id" class="max-sm:hidden" />
      }

      @if (sync.live() === 'reconnecting' || sync.lastError()) {
        <span class="text-status-needs-input flex items-center gap-1.5 text-xs" role="status" [attr.aria-label]="sync.lastError() ?? sync.label()">
          <span class="bg-status-needs-input size-1.5 rounded-full"></span>
          <span class="max-sm:hidden">{{ sync.label() }}</span>
        </span>
      }

      <span class="flex-1"></span>

      <div class="top-bar__actions flex shrink-0 items-center gap-2 empty:hidden">
        @if (chrome.actions(); as tpl) {
          <ng-container *ngTemplateOutlet="tpl" />
        }
      </div>

      @if (paneAvailable()) {
        <button
          hlmBtn
          variant="ghost"
          size="icon-sm"
          class="text-muted-foreground -mr-1"
          [hlmTooltip]="rightPane.open() ? 'Hide preview  ⌘.' : 'Show preview  ⌘.'"
          position="bottom"
          [attr.aria-label]="rightPane.open() ? 'Hide preview pane' : 'Show preview pane'"
          [attr.aria-pressed]="rightPane.open()"
          (click)="rightPane.toggle()"
        >
          <svg [lucideIcon]="panelRight" [size]="16"></svg>
        </button>
      }
    }
  `,
})
export class TopBar {
  /** Phones render <app-mobile-header> instead; the desktop bar stays empty there. */
  protected readonly viewport = inject(Viewport);
  protected readonly chrome = inject(PageChrome);
  protected readonly sync = inject(SyncStatus);
  protected readonly ui = inject(UiStore);
  protected readonly sidebar = inject(HlmSidebarService);
  protected readonly rightPane = inject(RightPaneStore);
  private readonly router = inject(Router);
  private readonly store = inject(TramaStore);
  private readonly favorites = inject(FavoritesStore);
  private readonly notifications = inject(NotificationsStore);

  protected readonly sep = LucideChevronRight;
  protected readonly panelLeft = LucidePanelLeft;
  protected readonly panelRight = LucidePanelRight;
  protected readonly search = LucideSearch;
  protected readonly inbox = LucideInbox;

  private readonly url = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map((e) => e.urlAfterRedirects),
      startWith(this.router.url),
    ),
    { initialValue: this.router.url },
  );

  /** The right pane exists on the sections that feed it (inbox, tasks, projects, views). */
  protected readonly paneAvailable = computed(() => {
    const section = this.url().split(/[?#]/)[0].split('/').filter(Boolean)[1];
    return section !== undefined && PANE_SECTIONS.has(section);
  });
  protected readonly sidebarCollapsed = computed(() => this.sidebar.state() === 'collapsed');
  protected readonly slug = computed(() => this.store.slug() ?? '');
  protected readonly inboxCount = computed(
    () => this.store.attentionCount() + this.notifications.updatesUnread(),
  );
  protected readonly favoriteTarget = this.favorites.current;
  protected readonly actors = computed(() => this.chrome.page()?.actors ?? []);

  /** Page description from <app-page-header>, shown after the trail (muted). */
  protected readonly description = computed(() => {
    const d = this.chrome.crumbs() ? undefined : this.chrome.page()?.description;
    const labels = this.crumbs().map((c) => c.label.toLowerCase());
    return d && !labels.includes(d.toLowerCase()) ? d : undefined;
  });

  protected readonly crumbs = computed<readonly Crumb[]>(() => {
    const override = this.chrome.crumbs();
    if (override) return override;
    const base = this.urlCrumbs();
    const page = this.chrome.page();
    if (!page || !base.length || base.some((c) => c.label === page.title)) return base;
    // the page's own title replaces the URL-derived label of the last crumb
    return [...base.slice(0, -1), { ...base[base.length - 1], label: page.title, mono: false }];
  });

  private readonly urlCrumbs = computed<readonly Crumb[]>(() => {
    const [path] = this.url().split(/[?#]/);
    const segs = path.split('/').filter(Boolean);
    const slug = segs[0] ?? this.store.slug() ?? '';
    const section = segs[1];
    if (!section) return [{ label: this.store.workspace()?.name ?? 'Workspace' }];
    const out: Crumb[] = [];
    const label = SECTION_LABELS[section] ?? decodeURIComponent(section);
    const rest = segs.slice(2);
    out.push({
      label,
      link: SECTIONS_WITH_LIST.has(section) && section !== 'settings' ? ['/', slug, section] : undefined,
    });
    if (rest.length) {
      const tail = decodeURIComponent(rest[rest.length - 1]);
      if (section === 'settings') {
        out.push({ label: tail.charAt(0).toUpperCase() + tail.slice(1) });
      } else if (section === 'views') {
        out.push({ label: this.store.getView(tail)?.name ?? tail });
      } else {
        out.push({ label: tail, mono: true });
      }
    }
    return out;
  });
}
