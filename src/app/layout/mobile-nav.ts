import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import {
  LucideActivity,
  LucideCircleDot,
  LucideDynamicIcon,
  LucideBox,
  LucideCheck,
  LucideMenu,
  LucideMessageSquare,
  LucidePlus,
  LucideX,
  LucideSettings,
  LucideSearch,
} from '@lucide/angular';
import { AssistantStore } from '../core/ai/assistant.store';
import { NablaStore } from '../core/stores/nabla.store';
import { MAIN_NAV, PERSONAL_NAV, type NavItem } from './nav';
import { UiStore } from '../core/stores/ui.store';
import { SessionStore } from '../core/session/session.store';

@Component({
  selector: 'app-mobile-nav',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, RouterLinkActive, LucideDynamicIcon],
  host: { class: 'mobile-nav md:hidden' },
  template: `
    @if (ui.mobileSidebarOpen()) {
      <button class="mobile-menu__backdrop" type="button" aria-label="Close navigation menu" (click)="closeMenu()"></button>
      <section class="mobile-menu" role="dialog" aria-modal="true" aria-label="Navigation menu">
        <header class="mobile-menu__header">
          <div class="mobile-menu__identity">
            <span class="mobile-menu__avatar" aria-hidden="true">{{ initials }}</span>
            <span class="mobile-menu__account">{{ accountName }}</span>
          </div>
          <button class="mobile-menu__close" type="button" aria-label="Close navigation menu" (click)="closeMenu()">
            <svg [lucideIcon]="closeIcon" [size]="22" aria-hidden="true"></svg>
          </button>
        </header>
        <nav class="mobile-menu__links" aria-label="All sections">
          <div class="mobile-menu__workspaces" role="group" aria-label="Workspaces">
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
              <svg [lucideIcon]="plusIcon" [size]="21" aria-hidden="true"></svg><span>Create workspace</span>
            </a>
          </div>
          @for (item of menuItems; track item.segment) {
            <a [routerLink]="['/', slug(), item.segment]" routerLinkActive="mobile-menu__link--active"
              [routerLinkActiveOptions]="{ exact: false }" ariaCurrentWhenActive="page"
              class="mobile-menu__link" (click)="closeMenu()">
              <svg [lucideIcon]="item.icon" [size]="21" aria-hidden="true"></svg><span>{{ item.label }}</span>
            </a>
          }
          <button class="mobile-menu__link" type="button" (click)="openSearch()">
            <svg [lucideIcon]="searchIcon" [size]="21" aria-hidden="true"></svg><span>Search</span>
          </button>
        </nav>
      </section>
    }
    <nav aria-label="Main navigation" class="mobile-nav__items">
      @for (item of items; track item.segment) {
        <a
          [routerLink]="['/', slug(), item.segment]"
          routerLinkActive="mobile-nav__link--active"
          [routerLinkActiveOptions]="{ exact: false }"
          ariaCurrentWhenActive="page"
          class="mobile-nav__link"
          [attr.aria-label]="item.label"
          [attr.title]="item.label"
        >
          <svg [lucideIcon]="item.icon" [size]="22" aria-hidden="true"></svg>
          <span class="sr-only">{{ item.label }}</span>
          @if (item.badge === 'attention' && store.attentionCount() > 0) {
            <span class="mobile-nav__badge" aria-hidden="true">{{ store.attentionCount() > 99 ? '99+' : store.attentionCount() }}</span>
          }
        </a>
      }
      <button
        type="button"
        class="mobile-nav__link"
        [class.mobile-nav__link--active]="ui.mobileSidebarOpen()"
        aria-label="Open navigation menu"
        title="Navigation menu"
        [attr.aria-expanded]="ui.mobileSidebarOpen()"
        (click)="ui.setMobileSidebar(!ui.mobileSidebarOpen())"
      >
        <svg [lucideIcon]="menuIcon" [size]="22" aria-hidden="true"></svg>
        <span class="sr-only">More sections</span>
      </button>
      <button
        id="mobile-assistant-launcher"
        type="button"
        class="mobile-nav__link"
        [class.mobile-nav__link--active]="assistant.open()"
        aria-label="Open Trama assistant"
        title="Trama assistant"
        aria-controls="nabla-assistant"
        [attr.aria-expanded]="assistant.open()"
        (click)="toggleAssistant()"
      >
        <svg [lucideIcon]="assistantIcon" [size]="22" aria-hidden="true"></svg>
        <span class="sr-only">Assistant</span>
      </button>
    </nav>
  `,
})
export class MobileNav {
  protected readonly assistant = inject(AssistantStore);
  protected readonly ui = inject(UiStore);
  protected readonly session = inject(SessionStore);
  protected readonly items: Pick<NavItem, 'segment' | 'label' | 'icon' | 'badge'>[] = [
    PERSONAL_NAV[0],
    { segment: 'issues', label: 'Issues', icon: LucideCircleDot },
    { segment: 'activity', label: 'Activity', icon: LucideActivity },
    { segment: 'projects', label: 'Projects', icon: LucideBox },
  ];
  protected readonly store = inject(NablaStore);
  protected readonly slug = this.store.slug;
  protected readonly assistantIcon = LucideMessageSquare;
  protected readonly menuIcon = LucideMenu;
  protected readonly closeIcon = LucideX;
  protected readonly searchIcon = LucideSearch;
  protected readonly checkIcon = LucideCheck;
  protected readonly plusIcon = LucidePlus;
  protected readonly menuItems = [
    PERSONAL_NAV[0],
    PERSONAL_NAV[1],
    PERSONAL_NAV[3],
    { segment: 'activity', label: 'Activity', icon: LucideActivity },
    ...MAIN_NAV.filter((item) => item.segment !== 'activity'),
    { segment: 'settings', label: 'Settings', icon: LucideSettings },
  ];
  protected get accountName(): string {
    return this.session.user()?.name ?? 'Account';
  }
  protected get initials(): string {
    return this.accountName.split(/\s+/).map((part) => part[0]).slice(0, 2).join('').toUpperCase();
  }

  protected closeMenu(): void {
    this.ui.setMobileSidebar(false);
  }

  protected switchTo(next: string): void {
    this.closeMenu();
    if (next !== this.slug()) void this.session.switchWorkspace(next);
  }

  protected openSearch(): void {
    this.closeMenu();
    this.ui.openCommandPalette();
  }

  protected toggleAssistant(): void {
    this.assistant.open.update((open) => !open);
  }
}
