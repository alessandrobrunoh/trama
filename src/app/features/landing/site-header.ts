import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router, RouterLink, RouterLinkActive } from '@angular/router';
import {
  LucideCopy,
  LucideDownload,
  LucideDynamicIcon,
  LucideMonitor,
  LucideMoon,
  LucidePalette,
  LucideSun,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmContextMenuImports } from '@spartan-ng/helm/context-menu';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import { ThemeService } from '../../core/theme';
import { BrandAssets, type LogoKind } from '../brand/brand-assets';

/** Sticky header shared by the public pages. Right-click the logo for brand assets. */
@Component({
  selector: 'app-site-header',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    RouterLinkActive,
    HlmButtonImports,
    HlmContextMenuImports,
    HlmDropdownMenuImports,
    LucideDynamicIcon,
  ],
  host: {
    class: 'border-border/60 bg-background/75 sticky top-0 z-20 block border-b backdrop-blur-xl',
  },
  template: `
    <div class="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4 sm:px-6">
      <a
        routerLink="/"
        class="flex shrink-0 items-center"
        aria-label="Trama home (right-click for brand assets)"
        [hlmContextMenuTrigger]="logoMenu"
      >
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

    <ng-template #logoMenu>
      <hlm-dropdown-menu class="w-56">
        <hlm-dropdown-menu-group>
          @for (item of copyItems; track item.kind) {
            <button hlmDropdownMenuItem (triggered)="copy(item.kind)">
              <svg [lucideIcon]="copyIcon" [size]="14"></svg> {{ item.label }}
            </button>
          }
        </hlm-dropdown-menu-group>
        <hlm-dropdown-menu-separator />
        <hlm-dropdown-menu-group>
          <button hlmDropdownMenuItem (triggered)="brand.downloadAll()">
            <svg [lucideIcon]="downloadIcon" [size]="14"></svg> Download brand assets
          </button>
          <button hlmDropdownMenuItem (triggered)="router.navigateByUrl('/brand')">
            <svg [lucideIcon]="paletteIcon" [size]="14"></svg> View brand
          </button>
        </hlm-dropdown-menu-group>
      </hlm-dropdown-menu>
    </ng-template>
  `,
})
export class SiteHeader {
  protected readonly theme = inject(ThemeService);
  protected readonly brand = inject(BrandAssets);
  protected readonly router = inject(Router);

  protected readonly copyIcon = LucideCopy;
  protected readonly downloadIcon = LucideDownload;
  protected readonly paletteIcon = LucidePalette;
  protected readonly copyItems: { kind: LogoKind; label: string }[] = [
    { kind: 'horizontal', label: 'Copy logo as SVG' },
    { kind: 'symbol', label: 'Copy logomark as SVG' },
    { kind: 'wordmark', label: 'Copy wordmark as SVG' },
  ];

  /** Copies the variant that reads on the current theme. */
  protected copy(kind: LogoKind): void {
    void this.brand.copySvg(kind, this.theme.resolved() === 'dark' ? 'white' : 'black');
  }

  protected themeIcon() {
    const m = this.theme.mode();
    return m === 'light' ? LucideSun : m === 'dark' ? LucideMoon : LucideMonitor;
  }

  protected cycleTheme(): void {
    const m = this.theme.mode();
    this.theme.set(m === 'system' ? 'light' : m === 'light' ? 'dark' : 'system');
  }
}
