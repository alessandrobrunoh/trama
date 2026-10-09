import { Location, NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  signal,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, NavigationStart, Router } from '@angular/router';
import { LucideChevronLeft, LucideDynamicIcon, LucidePlus } from '@lucide/angular';
import { filter, map, startWith } from 'rxjs';
import { FavoritesStore } from '../core/stores/favorites.store';
import { TramaStore } from '../core/stores/trama.store';
import { UiStore } from '../core/stores/ui.store';
import { SyncStatus } from '../core/sync/sync-status';
import { Viewport, haptic } from '../core/viewport';
import { FavoriteButton } from '../shared/favorite-button';
import { SECTION_LABELS } from './nav';
import { PageChrome } from './page-chrome';

/** Scrolling this far (px) folds the large title into the bar. */
const COLLAPSE_AT = 16;
/** Ignore scrollers that barely scroll (chip rows, tiny panes): folding would make the page jump. */
const MIN_SCROLL_RANGE = 160;
/** Entity keys such as DEBT-23, AUTH-42, ADR-21. */
const KEY_RE = /^[A-Z][A-Z0-9]*-\d+$/;

/**
 * Phone header (< md), the counterpart of <app-top-bar>:
 *   - section pages (Issues, Projects…) get a large title that folds into the bar once you scroll,
 *   - detail pages get a back button labelled with the parent and the entity key as title,
 *   - the page's top-bar actions render on the right; a "New …" action becomes the floating button.
 * It reads the same PageChrome registry as the desktop top bar, so pages need no mobile-specific code.
 */
@Component({
  selector: 'app-mobile-header',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet, LucideDynamicIcon, FavoriteButton],
  host: { class: 'mobile-header md:hidden', '[class.mobile-header--collapsed]': 'collapsed()' },
  template: `
    <div class="mobile-header__bar">
      <div class="mobile-header__lead">
        @if (!isRoot()) {
          <button type="button" class="mobile-header__back" [attr.aria-label]="'Back to ' + parentLabel()" (click)="back()">
            <svg [lucideIcon]="backIcon" [size]="26" aria-hidden="true"></svg>
            <span class="mobile-header__back-label">{{ parentLabel() }}</span>
          </button>
        } @else {
          <button type="button" class="mobile-header__avatar" aria-label="Open menu" (click)="openMenu()">
            {{ workspaceInitial() }}
          </button>
        }
      </div>
      <h2 class="mobile-header__title" [class.mobile-header__title--shown]="!isRoot() || collapsed()" [class.font-mono]="mono()">
        {{ title() }}
      </h2>
      <div class="mobile-header__end">
        @if (favoriteTarget(); as t) {
          <app-favorite-button [type]="t.type" [subjectId]="t.id" />
        }
        @if (sync.live() === 'reconnecting' || sync.lastError()) {
          <span class="mobile-header__sync" role="status">
            <span class="bg-status-needs-input size-2 rounded-full"></span>
            <span class="sr-only">{{ sync.label() }}</span>
          </span>
        }
        <div class="mobile-header__actions">
          @if (chrome.actions(); as tpl) {
            <ng-container *ngTemplateOutlet="tpl" />
          }
        </div>
      </div>
    </div>
    <!-- Labelled actions (Accept, Reject, + Workstream…) get a full-width row so they are real touch targets. -->
    <div class="mobile-header__row" #row>
      @if (chrome.actions(); as tpl) {
        <ng-container *ngTemplateOutlet="tpl" />
      }
    </div>
    @if (isRoot()) {
      <div class="mobile-header__large" aria-hidden="true">
        <p class="mobile-header__large-title">{{ title() }}</p>
      </div>
    }
    @if (!viewport.online()) {
      <div class="mobile-offline" role="status">You are offline. Showing the last data that synced.</div>
    }
    @if (fab(); as label) {
      <button type="button" class="mobile-fab" [attr.aria-label]="label" (click)="create()">
        <svg [lucideIcon]="plusIcon" [size]="26" aria-hidden="true"></svg>
      </button>
    }
  `,
})
export class MobileHeader {
  protected readonly viewport = inject(Viewport);
  protected readonly chrome = inject(PageChrome);
  protected readonly sync = inject(SyncStatus);
  protected readonly ui = inject(UiStore);
  private readonly router = inject(Router);
  private readonly location = inject(Location);
  private readonly store = inject(TramaStore);
  private readonly favorites = inject(FavoritesStore);
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly backIcon = LucideChevronLeft;
  protected readonly plusIcon = LucidePlus;
  protected readonly favoriteTarget = this.favorites.current;
  protected readonly collapsed = signal(false);
  /** Label of the create action the page offers ("New issue"), or null. Drives the floating button. */
  protected readonly fab = signal<string | null>(null);

  private readonly url = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map((e) => e.urlAfterRedirects),
      startWith(this.router.url),
    ),
    { initialValue: this.router.url },
  );
  /** In-app navigations so far: with a previous one, "back" is real history; otherwise go to the parent. */
  private navigations = 0;

  private readonly segments = computed(() => this.url().split(/[?#]/)[0].split('/').filter(Boolean));
  private readonly section = computed(() => this.segments()[1] ?? '');
  protected readonly isRoot = computed(() => {
    const segs = this.segments();
    return segs.length <= 2 || this.section() === 'settings';
  });
  protected readonly workspaceInitial = computed(
    () => (this.store.workspace()?.name ?? 'T').slice(0, 1).toUpperCase(),
  );
  private readonly sectionLabel = computed(() => {
    const s = this.section();
    return SECTION_LABELS[s] ?? (s ? decodeURIComponent(s) : (this.store.workspace()?.name ?? 'Workspace'));
  });

  private readonly lastCrumb = computed(() => {
    const crumbs = this.chrome.crumbs();
    return crumbs?.length ? crumbs[crumbs.length - 1] : null;
  });
  protected readonly title = computed(() => {
    if (this.isRoot()) return this.chrome.page()?.title ?? this.sectionLabel();
    const last = this.lastCrumb();
    if (last) return last.label;
    const tail = decodeURIComponent(this.segments()[this.segments().length - 1] ?? '');
    if (KEY_RE.test(tail)) return tail;
    if (this.section() === 'views') return this.store.getView(tail)?.name ?? tail;
    return this.chrome.page()?.title ?? tail;
  });
  protected readonly mono = computed(() => {
    const last = this.lastCrumb();
    return !this.isRoot() && (last ? !!last.mono : KEY_RE.test(this.title()));
  });
  protected readonly parentLabel = computed(() => {
    const crumbs = this.chrome.crumbs();
    return crumbs && crumbs.length > 1 ? crumbs[crumbs.length - 2].label : this.sectionLabel();
  });
  private readonly parentLink = computed<readonly unknown[]>(() => {
    const crumbs = this.chrome.crumbs();
    const link = crumbs && crumbs.length > 1 ? crumbs[crumbs.length - 2].link : undefined;
    return link ?? ['/', this.segments()[0] ?? this.store.slug() ?? '', this.section()];
  });

  constructor() {
    this.router.events.pipe(filter((e) => e instanceof NavigationEnd)).subscribe(() => this.navigations++);
    // Every route change opens with the large title expanded.
    this.router.events
      .pipe(filter((e) => e instanceof NavigationStart))
      .subscribe(() => this.collapsed.set(false));

    afterNextRender(() => {
      const scroller = document.getElementById('main-content');
      if (!scroller) return;
      const onScroll = (e: Event): void => {
        const t = e.target;
        if (!(t instanceof HTMLElement) || t.clientHeight < 200) return;
        if (t.scrollHeight - t.clientHeight < MIN_SCROLL_RANGE) return;
        if (!this.collapsed() && t.scrollTop > COLLAPSE_AT) this.collapsed.set(true);
        else if (this.collapsed() && t.scrollTop <= 0) this.collapsed.set(false);
      };
      // `scroll` does not bubble: capture it so nested list scrollers drive the title too.
      scroller.addEventListener('scroll', onScroll, { capture: true, passive: true });
      this.destroyRef.onDestroy(() => scroller.removeEventListener('scroll', onScroll, true));

      // Tag each action as icon-only, labelled or the "New …" button (-> floating button): CSS places them.
      const actions = this.el.nativeElement.querySelector('.mobile-header__actions');
      const containers = [actions, this.el.nativeElement.querySelector('.mobile-header__row')].filter(
        (c): c is Element => !!c,
      );
      const classify = (): void => {
        for (const c of containers)
          for (const b of Array.from(c.querySelectorAll<HTMLElement>('[data-slot="button"]'))) {
            const kind = b.querySelector('app-kbd') ? 'fab' : b.innerText.trim() ? 'text' : 'icon';
            if (b.dataset['mh'] !== kind) b.dataset['mh'] = kind;
          }
        const fab = this.createButton();
        this.fab.set(fab ? (fab.querySelector('span')?.textContent?.trim() || 'New') : null);
      };
      const mo = new MutationObserver(classify);
      for (const c of containers) mo.observe(c, { childList: true, subtree: true, characterData: true });
      this.destroyRef.onDestroy(() => mo.disconnect());
      classify();
    });
  }

  private createButton(): HTMLElement | null {
    return this.el.nativeElement.querySelector<HTMLElement>('[data-mh="fab"]');
  }

  protected create(): void {
    haptic('tap');
    this.createButton()?.click();
  }

  protected openMenu(): void {
    haptic('tap');
    this.ui.setMobileSidebar(true);
  }

  protected back(): void {
    haptic('tap');
    if (this.navigations > 1) this.location.back();
    else void this.router.navigate([...this.parentLink()]);
  }
}
