import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import {
  LucideActivity,
  LucideCircleDot,
  LucideDynamicIcon,
  LucideFolderGit2,
  LucideMenu,
  LucideMessageSquare,
  LucideX,
  LucideSettings,
  LucideSearch,
} from '@lucide/angular';
import { AssistantStore } from '../core/ai/assistant.store';
import { NablaStore } from '../core/stores/nabla.store';
import { MAIN_NAV, PERSONAL_NAV } from './nav';
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
  private readonly session = inject(SessionStore);
  protected readonly items = [
    { ...PERSONAL_NAV[0], label: 'Inbox' },
    { segment: 'issues', label: 'Issues', icon: LucideCircleDot },
    { segment: 'activity', label: 'Activity', icon: LucideActivity },
    { segment: 'projects', label: 'Projects', icon: LucideFolderGit2 },
  ];
  protected readonly slug = inject(NablaStore).slug;
  protected readonly assistantIcon = LucideMessageSquare;
  protected readonly menuIcon = LucideMenu;
  protected readonly closeIcon = LucideX;
  protected readonly searchIcon = LucideSearch;
  protected readonly menuItems = [
    { ...PERSONAL_NAV[0], label: 'Inbox' },
    { ...PERSONAL_NAV[1], label: 'My issues' },
    { segment: 'activity', label: 'Pulse', icon: LucideActivity },
    ...MAIN_NAV.filter((item) => item.segment !== 'activity'),
    { segment: 'settings/profile', label: 'Settings', icon: LucideSettings },
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

  protected openSearch(): void {
    this.closeMenu();
    this.ui.openCommandPalette();
  }

  protected toggleAssistant(): void {
    this.assistant.open.update((open) => !open);
  }
}
