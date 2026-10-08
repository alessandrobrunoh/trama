import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

/** Footer shared by the public pages (landing, blog). */
@Component({
  selector: 'app-site-footer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  host: { class: 'border-border/60 block border-t' },
  template: `
    <div
      class="mx-auto grid max-w-6xl gap-8 px-4 py-10 text-[13px] sm:grid-cols-[1.5fr_1fr_1fr] sm:px-6"
    >
      <div>
        <img src="/icons/trama-horizontal-black.svg" alt="Trama" class="h-6 w-auto dark:hidden" />
        <img
          src="/icons/trama-horizontal-white.svg"
          alt="Trama"
          class="hidden h-6 w-auto dark:block"
        />
        <p class="text-muted-foreground mt-3 max-w-xs leading-relaxed">
          The source-available coordination layer for teams of humans and coding agents.
        </p>
      </div>
      <nav class="flex flex-col gap-2" aria-label="Product">
        <span class="text-foreground font-medium">Product</span>
        <a routerLink="/" fragment="why" class="text-muted-foreground hover:text-foreground"
          >Why Trama</a
        >
        <a routerLink="/" fragment="compare" class="text-muted-foreground hover:text-foreground"
          >Compare</a
        >
        <a routerLink="/" fragment="agents" class="text-muted-foreground hover:text-foreground"
          >Agents</a
        >
      </nav>
      <nav class="flex flex-col gap-2" aria-label="Resources">
        <span class="text-foreground font-medium">Resources</span>
        <a routerLink="/blog" class="text-muted-foreground hover:text-foreground">Blog</a>
        <a routerLink="/roadmap" class="text-muted-foreground hover:text-foreground">Roadmap</a>
        <a routerLink="/changelog" class="text-muted-foreground hover:text-foreground">Changelog</a>
        <a routerLink="/brand" class="text-muted-foreground hover:text-foreground">Brand</a>
        <a routerLink="/login" class="text-muted-foreground hover:text-foreground">Sign in</a>
        <a routerLink="/register" class="text-muted-foreground hover:text-foreground"
          >Create account</a
        >
      </nav>
    </div>
    <div class="border-border/60 border-t">
      <p class="text-muted-foreground mx-auto max-w-6xl px-4 py-5 text-xs sm:px-6">
        © {{ year }} Trama · Source-available under PolyForm Shield 1.0.0
      </p>
    </div>
  `,
})
export class SiteFooter {
  protected readonly year = new Date().getFullYear();
}
