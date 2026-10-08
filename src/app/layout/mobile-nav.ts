import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import {
  LucideActivity,
  LucideCircleDot,
  LucideDynamicIcon,
  LucideFolderGit2,
  LucideMessageSquare,
} from '@lucide/angular';
import { AssistantStore } from '../core/ai/assistant.store';
import { NablaStore } from '../core/stores/nabla.store';
import { PERSONAL_NAV } from './nav';

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
  protected readonly items = [
    { ...PERSONAL_NAV[0], label: 'Inbox' },
    { segment: 'issues', label: 'Issues', icon: LucideCircleDot },
    { segment: 'activity', label: 'Activity', icon: LucideActivity },
    { segment: 'projects', label: 'Projects', icon: LucideFolderGit2 },
  ];
  protected readonly slug = inject(NablaStore).slug;
  protected readonly assistantIcon = LucideMessageSquare;

  protected toggleAssistant(): void {
    this.assistant.open.update((open) => !open);
  }
}
