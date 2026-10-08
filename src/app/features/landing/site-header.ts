import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { LucideDynamicIcon, LucideMonitor, LucideMoon, LucideSun } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { ThemeService } from '../../core/theme';

/** Sticky header shared by the public pages (landing, blog). */
@Component({
  selector: 'app-site-header',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, RouterLinkActive, HlmButtonImports, LucideDynamicIcon],
  host: {
    class: 'border-border/60 bg-background/75 sticky top-0 z-20 block border-b backdrop-blur-xl',
  },
  template: `
    <div class="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4 sm:px-6">
      <a routerLink="/" class="flex shrink-0 items-center" aria-label="Trama home">
        <img src="/icons/trama-horizontal-black.svg" alt="Trama" class="h-7 w-auto dark:hidden" />
        <img
          src="/icons/trama-horizontal-white.svg"
          alt="Trama"
          class="hidden h-7 w-auto dark:block"
        />
      </a>
      <nav
        class="text-muted-foreground hidden items-center gap-5 text-[13px] md:flex"
        aria-label="Site"
      >
        <a routerLink="/" fragment="why" class="hover:text-foreground transition-colors"
          >Why Trama</a
        >
        <a routerLink="/" fragment="compare" class="hover:text-foreground transition-colors"
          >Compare</a
        >
        <a
          routerLink="/roadmap"
          routerLinkActive="text-foreground"
          class="hover:text-foreground transition-colors"
          >Roadmap</a
        >
        <a
          routerLink="/changelog"
          routerLinkActive="text-foreground"
          class="hover:text-foreground transition-colors"
          >Changelog</a
        >
        <a
          routerLink="/blog"
          routerLinkActive="text-foreground"
          class="hover:text-foreground transition-colors"
          >Blog</a
        >
      </nav>
      <div class="ml-auto flex items-center gap-1.5">
        <a
          routerLink="/blog"
          class="text-muted-foreground hover:text-foreground mr-1 text-[13px] md:hidden"
          >Blog</a
        >
        <button
          hlmBtn
          variant="ghost"
          size="icon-sm"
          class="text-muted-foreground"
          [attr.aria-label]="'Theme: ' + theme.mode()"
          (click)="cycleTheme()"
        >
          <svg [lucideIcon]="themeIcon()" [size]="15"></svg>
        </button>
        <a hlmBtn variant="ghost" size="sm" routerLink="/login">Sign in</a>
        <a hlmBtn size="sm" routerLink="/register">Get started</a>
      </div>
    </div>
  `,
})
export class SiteHeader {
  protected readonly theme = inject(ThemeService);

  protected themeIcon() {
    const m = this.theme.mode();
    return m === 'light' ? LucideSun : m === 'dark' ? LucideMoon : LucideMonitor;
  }

  protected cycleTheme(): void {
    const m = this.theme.mode();
    this.theme.set(m === 'system' ? 'light' : m === 'light' ? 'dark' : 'system');
  }
}
