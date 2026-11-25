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
import { HlmContextMenuImports } from '@spartan-ng/helm/context-menu';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import { ThemeService } from '../../core/theme';
import { TramaLogo } from '../../shared/trama-logo';
import { BrandAssets, type LogoKind } from '../brand/brand-assets';

/**
 * Header shared by the public pages (v3 "Nav": 64px, mark + wordmark, centered links, Sign in and
 * the primary "Get started" button with its `G` key). Right-click the logo for brand assets.
 */
@Component({
  selector: 'app-site-header',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    RouterLinkActive,
    HlmContextMenuImports,
    HlmDropdownMenuImports,
    LucideDynamicIcon,
    TramaLogo,
  ],
  host: {
    class:
      'bg-background/90 border-border sticky top-0 z-20 block border-b leading-normal backdrop-blur-xl',
    '(window:keydown)': 'onKey($event)',
  },
  template: `
    <div
      class="mx-auto flex h-16 w-full max-w-[1440px] items-center justify-between gap-6 px-5 md:px-10 xl:px-[120px]"
    >
      <a
        routerLink="/"
        class="flex shrink-0 items-center gap-2.5"
        aria-label="Trama home (right-click for brand assets)"
        [hlmContextMenuTrigger]="logoMenu"
      >
        <app-trama-logo [size]="24" />
        <span class="font-title text-foreground text-[22px] leading-none">Trama</span>
      </a>
      <nav class="hidden items-center gap-8 text-[14px] lg:flex" aria-label="Site">
        <a
          routerLink="/why"
          routerLinkActive="text-foreground"
          class="text-muted-foreground hover:text-foreground transition-colors"
          >Why Trama</a
        >
        <a
          routerLink="/"
          fragment="how"
          class="text-muted-foreground hover:text-foreground transition-colors"
          >How it works</a
        >
        <a
          routerLink="/"
          fragment="delta"
          class="text-muted-foreground hover:text-foreground transition-colors"
          >Delta</a
        >
        <a
          routerLink="/roadmap"
          routerLinkActive="text-foreground"
          class="text-muted-foreground hover:text-foreground transition-colors"
          >Roadmap</a
        >
        <a
          routerLink="/changelog"
          routerLinkActive="text-foreground"
          class="text-muted-foreground hover:text-foreground transition-colors"
          >Changelog</a
        >
      </nav>
      <div class="flex items-center gap-5">
        <button
          type="button"
          class="text-faint hover:text-foreground -mr-2 inline-flex size-7 items-center justify-center transition-colors"
          [attr.aria-label]="'Theme: ' + theme.mode()"
          (click)="cycleTheme()"
        >
          <svg [lucideIcon]="themeIcon()" [size]="15"></svg>
        </button>
        <a routerLink="/login" class="text-foreground text-[14px]">Sign in</a>
        <a
          routerLink="/register"
          class="bg-primary text-primary-foreground hover:bg-primary-strong inline-flex items-center gap-2.5 py-[7px] pr-2 pl-3 font-mono text-[12.5px] leading-normal whitespace-nowrap transition-colors"
        >
          Get started
          <span
            class="hidden bg-white/15 px-1.5 py-px text-[11px] leading-normal sm:inline"
            aria-hidden="true"
            >G</span
          >
        </a>
      </div>
    </div>
    <nav
      class="border-border flex gap-6 overflow-x-auto border-t px-5 py-2.5 text-[13px] whitespace-nowrap md:px-10 lg:hidden"
      aria-label="Site"
    >
      <a routerLink="/why" routerLinkActive="text-foreground" class="text-muted-foreground"
        >Why Trama</a
      >
      <a routerLink="/" fragment="how" class="text-muted-foreground">How it works</a>
      <a routerLink="/" fragment="delta" class="text-muted-foreground">Delta</a>
      <a routerLink="/roadmap" routerLinkActive="text-foreground" class="text-muted-foreground"
        >Roadmap</a
      >
      <a routerLink="/changelog" routerLinkActive="text-foreground" class="text-muted-foreground"
        >Changelog</a
      >
      <a routerLink="/blog" routerLinkActive="text-foreground" class="text-muted-foreground"
        >Blog</a
      >
    </nav>

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
    void this.brand.copySvg(kind, this.theme.resolved() === 'dark' ? 'colour-dark' : 'colour-light');
  }

  protected themeIcon() {
    const m = this.theme.mode();
    return m === 'light' ? LucideSun : m === 'dark' ? LucideMoon : LucideMonitor;
  }

  protected cycleTheme(): void {
    const m = this.theme.mode();
    this.theme.set(m === 'system' ? 'light' : m === 'light' ? 'dark' : 'system');
  }

  /** `G` is the key shown on "Get started": it opens the sign-up page. */
  protected onKey(event: KeyboardEvent): void {
    if (event.key.toLowerCase() !== 'g' || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
    ) {
      return;
    }
    void this.router.navigateByUrl('/register');
  }
}
