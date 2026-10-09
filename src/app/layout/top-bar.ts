import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink } from '@angular/router';
import { LucideChevronRight, LucideDynamicIcon } from '@lucide/angular';
import { HlmSidebarTrigger } from '@spartan-ng/helm/sidebar';
import { filter, map, startWith } from 'rxjs';
import { FavoritesStore } from '../core/stores/favorites.store';
import { NablaStore } from '../core/stores/nabla.store';
import { FavoriteButton } from '../shared/favorite-button';
import { SyncStatus } from '../core/sync/sync-status';
import { Viewport } from '../core/viewport';
import { PageChrome, type Crumb } from './page-chrome';
import { ALL_NAV, SECTIONS_WITH_LIST, SECTION_LABELS } from './nav';

/** Top bar: sidebar toggle, breadcrumb trail, live-sync dot and the page's action slot. */
@Component({
  selector: 'app-top-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet, RouterLink, LucideDynamicIcon, HlmSidebarTrigger, FavoriteButton],
  host: {
    class:
      'bg-background sticky top-0 z-10 flex h-11 shrink-0 items-center gap-2 border-b px-3 max-md:hidden md:rounded-t-lg',
  },
  template: `
    @if (!viewport.isMobile()) {
    <button hlmSidebarTrigger class="-ml-1 hidden size-7 md:inline-flex" srOnlyText="Toggle sidebar (⌘B)"></button>

    <nav aria-label="Breadcrumb" class="flex min-w-0 flex-1 items-center gap-1.5">
      @if (sectionIcon(); as icon) {
        <svg [lucideIcon]="icon" [size]="15" class="text-muted-foreground shrink-0 max-sm:hidden"></svg>
      }
      <ol class="flex min-w-0 items-center gap-0.5 text-[13px]">
        @for (c of crumbs(); track $index; let last = $last) {
          <li class="flex min-w-0 items-center gap-1" [class.shrink-0]="!last" [class.min-w-0]="last">
            @if (c.link && !last) {
              <a
                [routerLink]="c.link"
                class="text-muted-foreground hover:text-foreground hover:bg-accent truncate rounded-md px-1.5 py-0.5 transition-colors"
                [class.font-mono]="c.mono"
                >{{ c.label }}</a
              >
            } @else {
              <span
                class="truncate px-1.5 font-medium"
                [class.font-mono]="c.mono"
                [class.text-muted-foreground]="!last"
                [attr.aria-current]="last ? 'page' : null"
                >{{ c.label }}</span
              >
            }
            @if (!last) {
              <svg [lucideIcon]="sep" [size]="12" class="text-muted-foreground/50 shrink-0" aria-hidden="true"></svg>
            }
          </li>
        }
      </ol>
      @if (description(); as d) {
        <span class="text-muted-foreground/90 min-w-0 shrink-[20] truncate text-[13px] max-lg:hidden">{{ d }}</span>
      }
    </nav>

    @if (favoriteTarget(); as t) {
      <app-favorite-button [type]="t.type" [subjectId]="t.id" />
    }

    @if (sync.live() === 'reconnecting' || sync.lastError()) {
      <span class="text-status-needs-input flex items-center gap-1.5 text-xs" role="status">
        <span class="bg-status-needs-input size-1.5 rounded-full"></span>
        <span class="max-sm:hidden">{{ sync.label() }}</span>
      </span>
    }

    <div class="top-bar__actions flex shrink-0 items-center gap-1.5 empty:hidden">
      @if (chrome.actions(); as tpl) {
        <ng-container *ngTemplateOutlet="tpl" />
      }
    </div>
    }
  `,
})
export class TopBar {
  /** Phones render <app-mobile-header> instead; the desktop bar stays empty there. */
  protected readonly viewport = inject(Viewport);
  protected readonly chrome = inject(PageChrome);
  protected readonly sync = inject(SyncStatus);
  private readonly router = inject(Router);
  private readonly store = inject(NablaStore);
  private readonly favorites = inject(FavoritesStore);
  protected readonly sep = LucideChevronRight;

  private readonly url = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map((e) => e.urlAfterRedirects),
      startWith(this.router.url),
    ),
    { initialValue: this.router.url },
  );

  protected readonly sectionIcon = computed(() => {
    const seg = this.url().split(/[?#]/)[0].split('/').filter(Boolean)[1];
    return ALL_NAV.find((n) => n.segment === seg)?.icon ?? null;
  });

  protected readonly favoriteTarget = this.favorites.current;

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
