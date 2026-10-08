import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { LucideDynamicIcon, LucideEllipsis } from '@lucide/angular';
import { NablaStore } from '../core/stores/nabla.store';
import { UiStore } from '../core/stores/ui.store';
import { MAIN_NAV, PERSONAL_NAV } from './nav';

@Component({
  selector: 'app-mobile-nav',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, RouterLinkActive, LucideDynamicIcon],
  host: { class: 'mobile-nav md:hidden' },
  template: `
    <nav aria-label="Main navigation" class="mobile-nav__items">
      @for (item of items; track item.segment) {
        <a
          [routerLink]="['/', slug(), item.segment]"
          routerLinkActive="mobile-nav__link--active"
          [routerLinkActiveOptions]="{ exact: false }"
          class="mobile-nav__link"
          [attr.aria-label]="item.label"
        >
          <svg [lucideIcon]="item.icon" [size]="20" aria-hidden="true"></svg>
          <span>{{ item.shortLabel }}</span>
        </a>
      }
      <button type="button" class="mobile-nav__link" (click)="ui.setMobileSidebar(true)" aria-label="Apri tutte le sezioni">
        <svg [lucideIcon]="moreIcon" [size]="20" aria-hidden="true"></svg>
        <span>More</span>
      </button>
    </nav>
  `,
})
export class MobileNav {
  protected readonly ui = inject(UiStore);
  protected readonly items = [
    { ...PERSONAL_NAV[0], shortLabel: 'Inbox' },
    { ...PERSONAL_NAV[1], shortLabel: 'My work' },
    { ...MAIN_NAV.find((item) => item.segment === 'issues')!, shortLabel: 'Issues' },
    { ...MAIN_NAV.find((item) => item.segment === 'projects')!, shortLabel: 'Projects' },
  ];
  protected readonly slug = inject(NablaStore).slug;
  protected readonly moreIcon = LucideEllipsis;
}
