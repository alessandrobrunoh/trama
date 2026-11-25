import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TramaLogo } from '../../shared/trama-logo';

/** Footer shared by the public pages (v3 "Footer": brand, three link columns, licence line). */
@Component({
  selector: 'app-site-footer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, TramaLogo],
  host: { class: 'bg-background border-border block border-t leading-normal' },
  template: `
    <div
      class="mx-auto flex w-full max-w-[1440px] flex-col gap-14 px-5 pt-16 pb-10 md:px-10 xl:px-[120px]"
    >
      <div class="flex flex-col justify-between gap-10 md:flex-row">
        <div class="flex flex-col gap-3.5">
          <a routerLink="/" class="flex items-center gap-2.5" aria-label="Trama home">
            <app-trama-logo [size]="24" />
            <span class="font-title text-foreground text-[22px] leading-none">Trama</span>
          </a>
          <p class="text-muted-foreground text-[14px] leading-[22px]">
            The task hub for teams that build with Delta.<br />Plan in Trama. Work in Delta.
          </p>
        </div>
        <div class="grid grid-cols-2 gap-x-10 gap-y-10 sm:grid-cols-3 md:gap-x-24">
          <nav class="flex flex-col gap-3" aria-label="Product">
            <span class="text-faint font-mono text-[11px] tracking-[1.2px]">Product</span>
            <a routerLink="/why" class="text-muted-foreground hover:text-foreground text-[14px]"
              >Why Trama</a
            >
            <a routerLink="/compare" class="text-muted-foreground hover:text-foreground text-[14px]"
              >Compare</a
            >
            <a
              routerLink="/"
              fragment="delta"
              class="text-muted-foreground hover:text-foreground text-[14px]"
              >Agents</a
            >
            <a
              routerLink="/"
              fragment="start"
              class="text-muted-foreground hover:text-foreground text-[14px]"
              >Pricing</a
            >
          </nav>
          <nav class="flex flex-col gap-3" aria-label="Resources">
            <span class="text-faint font-mono text-[11px] tracking-[1.2px]">Resources</span>
            <a
              href="https://github.com/alessandrobrunoh/trama#readme"
              target="_blank"
              rel="noopener"
              class="text-muted-foreground hover:text-foreground text-[14px]"
              >Docs</a
            >
            <a routerLink="/blog" class="text-muted-foreground hover:text-foreground text-[14px]"
              >Blog</a
            >
            <a routerLink="/roadmap" class="text-muted-foreground hover:text-foreground text-[14px]"
              >Roadmap</a
            >
            <a
              routerLink="/changelog"
              class="text-muted-foreground hover:text-foreground text-[14px]"
              >Changelog</a
            >
            <a routerLink="/brand" class="text-muted-foreground hover:text-foreground text-[14px]"
              >Brand</a
            >
          </nav>
          <nav class="flex flex-col gap-3" aria-label="Company">
            <span class="text-faint font-mono text-[11px] tracking-[1.2px]">Company</span>
            <a
              href="https://github.com/alessandrobrunoh/trama"
              target="_blank"
              rel="noopener"
              class="text-muted-foreground hover:text-foreground text-[14px]"
              >GitHub</a
            >
            <a routerLink="/login" class="text-muted-foreground hover:text-foreground text-[14px]"
              >Sign in</a
            >
            <a
              routerLink="/register"
              class="text-muted-foreground hover:text-foreground text-[14px]"
              >Create account</a
            >
          </nav>
        </div>
      </div>
      <div
        class="border-border text-faint flex flex-col justify-between gap-2 border-t pt-5 font-mono text-[11px] sm:flex-row"
      >
        <span>© {{ year }} Trama · Source-available under PolyForm Shield 1.0.0</span>
        <span>All systems normal</span>
      </div>
    </div>
  `,
})
export class SiteFooter {
  protected readonly year = new Date().getFullYear();
}
