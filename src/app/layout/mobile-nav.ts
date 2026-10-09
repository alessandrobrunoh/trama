import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import {
  LucideCheck,
  LucideDynamicIcon,
  LucideEllipsis,
  LucideMessageSquare,
  LucidePlus,
  LucideSearch,
  LucideSettings,
  LucideX,
} from '@lucide/angular';
import { AssistantStore } from '../core/ai/assistant.store';
import { TramaStore } from '../core/stores/trama.store';
import { NotificationsStore } from '../core/stores/notifications.store';
import { SessionStore } from '../core/session/session.store';
import { UiStore } from '../core/stores/ui.store';
import { haptic } from '../core/viewport';
import { MORE_NAV, PRIMARY_NAV, type NavItem } from './nav';

interface SheetGroup {
  title: string;
  items: NavItem[];
}

/**
 * Phone navigation (< md): a docked tab bar (Inbox, My work, Issues, Search, More) with badges and
 * a "More" sheet that carries every other section, the workspace switcher and the assistant.
 * Everything here is `md:hidden`; the desktop sidebar is untouched.
 */
@Component({
  selector: 'app-mobile-nav',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, RouterLinkActive, LucideDynamicIcon],
  host: { class: 'mobile-nav md:hidden' },
  template: `
    @if (ui.mobileSidebarOpen()) {
      <button class="mobile-menu__backdrop" type="button" aria-label="Close menu" (click)="closeMenu()"></button>
      <section
        class="mobile-menu"
        role="dialog"
        aria-modal="true"
        aria-label="More"
        (keydown.escape)="closeMenu()"
      >
        <span
          class="mobile-menu__grabber"
          aria-hidden="true"
          (pointerdown)="dragStart($event)"
          (pointermove)="dragMove($event)"
          (pointerup)="dragEnd($event)"
          (pointercancel)="dragEnd($event)"
        ></span>
        <header class="mobile-menu__header">
          <div class="mobile-menu__identity">
            <span class="mobile-menu__avatar" aria-hidden="true">{{ initials() }}</span>
            <span class="mobile-menu__account">{{ accountName() }}</span>
          </div>
          <button class="mobile-menu__close" type="button" aria-label="Close menu" (click)="closeMenu()">
            <svg [lucideIcon]="closeIcon" [size]="20" aria-hidden="true"></svg>
          </button>
        </header>
        <nav class="mobile-menu__links" aria-label="All sections">
          <div class="mobile-menu__group" role="group" aria-label="Workspaces">
            <p class="mobile-menu__label">Workspaces</p>
            @for (w of session.workspaces(); track w.id) {
              <button
                type="button"
                class="mobile-menu__link"
                [class.mobile-menu__link--active]="w.slug === slug()"
                [attr.aria-current]="w.slug === slug() ? 'true' : null"
                (click)="switchTo(w.slug)"
              >
                <span class="mobile-menu__mark" aria-hidden="true">{{ w.name.slice(0, 1).toUpperCase() }}</span>
                <span class="min-w-0 flex-1 truncate">{{ w.name }}</span>
                @if (w.slug === slug()) {
                  <svg [lucideIcon]="checkIcon" [size]="18" aria-hidden="true"></svg>
                }
              </button>
            }
            <a class="mobile-menu__link" routerLink="/new-workspace" (click)="closeMenu()">
              <svg [lucideIcon]="plusIcon" [size]="20" aria-hidden="true"></svg><span>Create workspace</span>
            </a>
          </div>
          @for (group of groups(); track group.title) {
            <div class="mobile-menu__group" role="group" [attr.aria-label]="group.title">
              <p class="mobile-menu__label">{{ group.title }}</p>
              @for (item of group.items; track item.segment) {
                <a
                  [routerLink]="['/', slug(), item.segment]"
                  routerLinkActive="mobile-menu__link--active"
                  ariaCurrentWhenActive="page"
                  class="mobile-menu__link"
                  (click)="closeMenu()"
                >
                  <svg [lucideIcon]="item.icon" [size]="20" aria-hidden="true"></svg>
                  <span class="min-w-0 flex-1 truncate">{{ item.label }}</span>
                  @if (menuBadge(item); as n) {
                    <span class="mobile-badge mobile-badge--inline">{{ n > 99 ? '99+' : n }}</span>
                  }
                </a>
              }
            </div>
          }
          <div class="mobile-menu__group" role="group" aria-label="Trama">
            <button class="mobile-menu__link" type="button" (click)="openAssistant()">
              <svg [lucideIcon]="assistantIcon" [size]="20" aria-hidden="true"></svg><span>Assistant</span>
            </button>
            <a
              [routerLink]="['/', slug(), 'settings']"
              routerLinkActive="mobile-menu__link--active"
              class="mobile-menu__link"
              (click)="closeMenu()"
            >
              <svg [lucideIcon]="settingsIcon" [size]="20" aria-hidden="true"></svg><span>Settings</span>
            </a>
          </div>
        </nav>
      </section>
    }
    <nav aria-label="Main navigation" class="mobile-tabbar">
      @for (tab of tabs; track tab.segment) {
        <a
          [routerLink]="['/', slug(), tab.segment]"
          routerLinkActive="mobile-tab--active"
          ariaCurrentWhenActive="page"
          class="mobile-tab"
          (click)="tapped()"
        >
          <span class="mobile-tab__icon">
            <svg [lucideIcon]="tab.icon" [size]="24" aria-hidden="true"></svg>
            @if (tab.badge === 'inbox' && inbox(); as n) {
              <span class="mobile-badge" aria-hidden="true">{{ n > 99 ? '99+' : n }}</span>
            }
          </span>
          <span class="mobile-tab__label">{{ tab.label }}</span>
          @if (tab.badge === 'inbox' && inbox(); as n) {
            <span class="sr-only">, {{ n }} waiting on you</span>
          }
        </a>
      }
      <button type="button" class="mobile-tab" aria-haspopup="dialog" (click)="openSearch()">
        <span class="mobile-tab__icon"><svg [lucideIcon]="searchIcon" [size]="24" aria-hidden="true"></svg></span>
        <span class="mobile-tab__label">Search</span>
      </button>
      <button
        type="button"
        class="mobile-tab"
        [class.mobile-tab--active]="ui.mobileSidebarOpen()"
        aria-haspopup="dialog"
        [attr.aria-expanded]="ui.mobileSidebarOpen()"
        (click)="toggleMenu()"
      >
        <span class="mobile-tab__icon">
          <svg [lucideIcon]="moreIcon" [size]="24" aria-hidden="true"></svg>
        </span>
        <span class="mobile-tab__label">More</span>
      </button>
    </nav>
  `,
})
export class MobileNav {
  protected readonly assistant = inject(AssistantStore);
  protected readonly ui = inject(UiStore);
  protected readonly session = inject(SessionStore);
  private readonly store = inject(TramaStore);
  private readonly notifications = inject(NotificationsStore);

  protected readonly slug = this.store.slug;
  /** Inbox = what waits on you (attention) plus unread updates. */
  protected readonly inbox = computed(() => this.store.attentionCount() + this.notifications.updatesUnread());

  /** The first three primary places live in the bar; Workstreams and Projects open from More. */
  protected readonly tabs = PRIMARY_NAV.slice(0, 3);
  /** Tabs live in the bar; the sheet lists everything else. */
  private static readonly IN_BAR = new Set(['inbox', 'my-work', 'issues', 'assistant', 'settings']);
  protected readonly groups = computed<SheetGroup[]>(() => {
    const rest = (items: NavItem[]) => items.filter((n) => !MobileNav.IN_BAR.has(n.segment));
    return [
      { title: 'Work', items: rest(PRIMARY_NAV) },
      { title: 'Workspace', items: rest(MORE_NAV) },
    ].filter((g) => g.items.length > 0);
  });

  protected readonly assistantIcon = LucideMessageSquare;
  protected readonly moreIcon = LucideEllipsis;
  protected readonly closeIcon = LucideX;
  protected readonly searchIcon = LucideSearch;
  protected readonly checkIcon = LucideCheck;
  protected readonly plusIcon = LucidePlus;
  protected readonly settingsIcon = LucideSettings;

  protected readonly accountName = computed(() => this.session.user()?.name ?? 'Account');
  protected readonly initials = computed(() =>
    this.accountName()
      .split(/\s+/)
      .map((part) => part[0])
      .slice(0, 2)
      .join('')
      .toUpperCase(),
  );

  // Swipe-down on the grabber to dismiss, like the dialog sheets.
  protected drag = 0;
  private dragState: { id: number; startY: number; startT: number } | null = null;

  protected menuBadge(item: NavItem): number {
    return item.badge === 'inbox' ? this.inbox() : 0;
  }

  protected tapped(): void {
    haptic('tap');
    this.ui.setMobileSidebar(false);
  }

  protected toggleMenu(): void {
    haptic('tap');
    this.ui.setMobileSidebar(!this.ui.mobileSidebarOpen());
  }

  protected closeMenu(): void {
    this.ui.setMobileSidebar(false);
  }

  protected switchTo(next: string): void {
    this.closeMenu();
    if (next !== this.slug()) void this.session.switchWorkspace(next);
  }

  protected openSearch(): void {
    haptic('tap');
    this.ui.openModal('search');
  }

  protected openAssistant(): void {
    this.closeMenu();
    this.assistant.open.set(true);
  }

  protected dragStart(ev: PointerEvent): void {
    this.dragState = { id: ev.pointerId, startY: ev.clientY, startT: ev.timeStamp };
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
  }

  protected dragMove(ev: PointerEvent): void {
    const d = this.dragState;
    if (!d || d.id !== ev.pointerId) return;
    this.drag = Math.max(0, ev.clientY - d.startY);
    (ev.currentTarget as HTMLElement).parentElement?.style.setProperty('--sheet-drag', `${this.drag}px`);
  }

  protected dragEnd(ev: PointerEvent): void {
    const d = this.dragState;
    if (!d || d.id !== ev.pointerId) return;
    this.dragState = null;
    const fast = this.drag / Math.max(1, ev.timeStamp - d.startT) > 0.5;
    const close = this.drag > 96 || (fast && this.drag > 24);
    this.drag = 0;
    (ev.currentTarget as HTMLElement).parentElement?.style.removeProperty('--sheet-drag');
    if (close) this.closeMenu();
  }
}
