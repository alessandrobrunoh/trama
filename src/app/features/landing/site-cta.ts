import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

/** "Pull the thread." closing band shared by the landing page and Why Trama (v3 "CTA"). */
@Component({
  selector: 'app-site-cta',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  host: {
    class: 'bg-primary-soft border-border block scroll-mt-16 border-t leading-normal',
    id: 'start',
  },
  template: `
    <div
      class="mx-auto flex w-full max-w-[1440px] flex-col items-center gap-8 px-5 py-20 text-center md:px-10 md:py-[120px] xl:px-[120px]"
    >
      <h2
        class="font-title text-foreground text-[clamp(52px,9.4vw,96px)] leading-none tracking-[-0.026em]"
      >
        Pull the thread.
      </h2>
      <p class="text-muted-foreground text-[18px]">
        Free for small teams. Works with delta.dev out of the box.
      </p>
      <div class="flex flex-wrap items-center justify-center gap-3">
        <a
          routerLink="/register"
          class="bg-primary text-primary-foreground hover:bg-primary-strong inline-flex items-center gap-2.5 py-[11px] pr-2.5 pl-4 font-mono text-[14px] leading-normal whitespace-nowrap transition-colors"
        >
          Get started free
          <span class="bg-white/15 px-1.5 py-px text-[11px] leading-normal" aria-hidden="true"
            >G</span
          >
        </a>
        <a
          href="https://github.com/alessandrobrunoh/trama#readme"
          target="_blank"
          rel="noopener"
          class="bg-secondary border-border text-foreground hover:bg-hover inline-flex border px-4 py-[11px] font-mono text-[14px] leading-normal whitespace-nowrap transition-colors"
          >Read the docs</a
        >
      </div>
    </div>
  `,
})
export class SiteCta {}
