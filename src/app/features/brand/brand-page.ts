import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import {
  LucideCheck,
  LucideCopy,
  LucideDownload,
  LucideDynamicIcon,
  LucideX,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { SiteFooter } from '../landing/site-footer';
import { SiteHeader } from '../landing/site-header';
import { BrandAssets, LOGOS, logoUrl } from './brand-assets';

/** `/brand`: logos, colours, type and usage rules, with copy / download for every asset. */
@Component({
  selector: 'app-brand-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButtonImports, LucideDynamicIcon, SiteHeader, SiteFooter],
  host: {
    class: 'bg-background text-foreground relative isolate flex min-h-svh flex-col overflow-x-clip',
  },
  template: `
    <div
      aria-hidden="true"
      class="bg-primary/10 pointer-events-none absolute top-[-22rem] left-1/2 -z-10 h-[36rem] w-[60rem] max-w-[160vw] -translate-x-1/2 rounded-full blur-3xl"
    ></div>
    <app-site-header />

    <main class="mx-auto w-full max-w-6xl flex-1 px-4 pt-16 pb-24 sm:px-6 sm:pt-24">
      <div class="flex flex-wrap items-end justify-between gap-6">
        <div class="max-w-2xl">
          <p class="text-primary text-[13px] font-medium">Brand</p>
          <h1 class="mt-2 text-4xl font-semibold tracking-[-0.03em] sm:text-5xl">Trama brand</h1>
          <p class="text-muted-foreground mt-4 text-[15px] leading-relaxed">
            Logos, colours and type for writing about Trama, linking to it or building on top of it.
            Copy any asset as SVG, download it as SVG or PNG, or grab everything at once.
          </p>
        </div>
        <button hlmBtn (click)="assets.downloadAll()">
          <svg [lucideIcon]="downloadIcon" [size]="15"></svg>
          Download all assets (.zip)
        </button>
      </div>

      <!-- Logos -->
      <section class="mt-16" aria-labelledby="logos">
        <h2 id="logos" class="text-2xl font-semibold tracking-[-0.02em]">Logos</h2>
        <p class="text-muted-foreground mt-2 max-w-2xl text-[14px] leading-relaxed">
          The mark is a woven T: two strands crossing into one fabric, like the weft (trama) on a
          loom. Use black on light backgrounds and white on dark ones.
        </p>
        <div class="mt-8 flex flex-col gap-10">
          @for (logo of logos; track logo.kind) {
            <article>
              <div class="flex flex-wrap items-baseline justify-between gap-2">
                <h3 class="font-medium">{{ logo.name }}</h3>
                <p class="text-muted-foreground text-[13px]">{{ logo.description }}</p>
              </div>
              <div class="mt-3 grid gap-3 md:grid-cols-2">
                @for (variant of variants; track variant) {
                  <figure class="border-border overflow-hidden rounded-xl border">
                    <div
                      class="flex h-56 items-center justify-center p-10"
                      [class]="variant === 'black' ? 'bg-white' : 'bg-[#0e0f11]'"
                    >
                      <img
                        [src]="url(logo.kind, variant)"
                        [alt]="'Trama ' + logo.name.toLowerCase() + ', ' + variant"
                        class="max-h-full w-auto"
                        [class]="
                          logo.kind === 'symbol' || logo.kind === 'stacked' ? 'h-28' : 'h-16'
                        "
                      />
                    </div>
                    <figcaption
                      class="border-border bg-card flex items-center gap-1 border-t px-3 py-2 text-[12px]"
                    >
                      <span class="text-muted-foreground mr-auto capitalize">{{ variant }}</span>
                      <button
                        hlmBtn
                        variant="ghost"
                        size="sm"
                        (click)="assets.copySvg(logo.kind, variant)"
                      >
                        <svg [lucideIcon]="copyIcon" [size]="13"></svg> Copy SVG
                      </button>
                      <button
                        hlmBtn
                        variant="ghost"
                        size="sm"
                        (click)="assets.downloadSvg(logo.kind, variant)"
                      >
                        <svg [lucideIcon]="downloadIcon" [size]="13"></svg> SVG
                      </button>
                      <button
                        hlmBtn
                        variant="ghost"
                        size="sm"
                        (click)="assets.downloadPng(logo.kind, variant)"
                      >
                        <svg [lucideIcon]="downloadIcon" [size]="13"></svg> PNG
                      </button>
                    </figcaption>
                  </figure>
                }
              </div>
            </article>
          }
        </div>
      </section>

      <!-- Clear space -->
      <section class="mt-20 grid gap-8 lg:grid-cols-2 lg:items-center" aria-labelledby="space">
        <div>
          <h2 id="space" class="text-2xl font-semibold tracking-[-0.02em]">Clear space and size</h2>
          <p class="text-muted-foreground mt-2 text-[14px] leading-relaxed">
            Keep empty space around the logo equal to at least half the height of the logomark. Do
            not use the logomark smaller than 16px, or the horizontal logo shorter than 20px: below
            that, the strands blur together.
          </p>
        </div>
        <div class="border-border bg-card flex items-center justify-center rounded-xl border p-8">
          <div class="relative p-8 outline-1 outline-offset-0 outline-primary/40 outline-dashed">
            <div class="outline-primary/30 bg-primary/5 outline-1 outline-dashed">
              <img src="/icons/trama-horizontal-black.svg" alt="" class="h-12 w-auto dark:hidden" />
              <img
                src="/icons/trama-horizontal-white.svg"
                alt=""
                class="hidden h-12 w-auto dark:block"
              />
            </div>
            <span
              class="text-primary absolute top-1 left-1/2 -translate-x-1/2 font-mono text-[10px]"
              >½ mark</span
            >
          </div>
        </div>
      </section>

      <!-- Colours -->
      <section class="mt-20" aria-labelledby="colours">
        <h2 id="colours" class="text-2xl font-semibold tracking-[-0.02em]">Colours</h2>
        <p class="text-muted-foreground mt-2 max-w-2xl text-[14px] leading-relaxed">
          Trama is mostly ink and paper, with one terracotta accent. Workstream violet and decision
          amber identify the two concepts that make Trama different. Click a swatch to copy its hex
          value.
        </p>
        <div class="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          @for (c of colors; track c.name) {
            <button
              type="button"
              class="group border-border bg-card hover:border-border-strong overflow-hidden rounded-xl border text-left transition-colors"
              (click)="assets.copyText(c.hex, c.name + ' copied')"
            >
              <span class="block h-24 border-b border-black/5" [style.background]="c.hex"></span>
              <span class="flex items-center justify-between px-3.5 pt-3 text-[13px] font-medium">
                {{ c.name }}
                <svg
                  [lucideIcon]="copyIcon"
                  [size]="13"
                  class="text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
                ></svg>
              </span>
              <span class="text-muted-foreground block px-3.5 pt-0.5 font-mono text-[12px]">{{
                c.hex
              }}</span>
              <span class="text-muted-foreground block px-3.5 pt-1 pb-3 text-[12px]">{{
                c.role
              }}</span>
            </button>
          }
        </div>
      </section>

      <!-- Type -->
      <section class="mt-20" aria-labelledby="type">
        <h2 id="type" class="text-2xl font-semibold tracking-[-0.02em]">Typography</h2>
        <div class="mt-8 grid gap-3 md:grid-cols-2">
          <div class="border-border bg-card rounded-xl border p-6">
            <p class="text-muted-foreground text-[12px]">Interface and headings</p>
            <p class="mt-3 text-5xl font-semibold tracking-[-0.035em]">Inter</p>
            <p class="text-muted-foreground mt-4 text-[14px] leading-relaxed">
              Tight tracking on headings, regular weight for body text. Free from Google Fonts and
              rsms.me/inter.
            </p>
          </div>
          <div class="border-border bg-card rounded-xl border p-6">
            <p class="text-muted-foreground text-[12px]">Keys, code and identifiers</p>
            <p class="mt-3 font-mono text-5xl tracking-tight">Geist Mono</p>
            <p class="text-muted-foreground mt-4 text-[14px] leading-relaxed">
              For issue keys like <span class="text-foreground font-mono">AUTH-12</span>, shortcuts
              and code samples.
            </p>
          </div>
        </div>
      </section>

      <!-- Name -->
      <section class="mt-20" aria-labelledby="name">
        <h2 id="name" class="text-2xl font-semibold tracking-[-0.02em]">Writing the name</h2>
        <p class="text-muted-foreground mt-2 max-w-2xl text-[14px] leading-relaxed">
          Trama is one word with a capital T, in running text and in titles. It is Italian for
          <em>weft</em>, the thread that ties a fabric together.
        </p>
        <div class="mt-6 flex flex-wrap gap-2 text-[14px]">
          @for (n of names; track n.text) {
            <span
              class="inline-flex items-center gap-1.5 rounded-full border px-3 py-1"
              [class]="
                n.ok
                  ? 'border-tone-green/30 bg-tone-green/8 text-foreground'
                  : 'border-destructive/25 bg-destructive/5 text-muted-foreground line-through'
              "
            >
              <svg
                [lucideIcon]="n.ok ? checkIcon : xIcon"
                [size]="13"
                [class]="n.ok ? 'text-tone-green' : 'text-destructive'"
              ></svg>
              {{ n.text }}
            </span>
          }
        </div>
      </section>

      <!-- Usage -->
      <section class="mt-20" aria-labelledby="usage">
        <h2 id="usage" class="text-2xl font-semibold tracking-[-0.02em]">Please don't</h2>
        <div class="mt-8 grid grid-cols-2 gap-3 lg:grid-cols-4">
          @for (d of donts; track d.label) {
            <figure class="border-border bg-card overflow-hidden rounded-xl border">
              <div class="flex h-36 items-center justify-center overflow-hidden p-6">
                <img
                  src="/icons/trama-horizontal-black.svg"
                  alt=""
                  class="h-10 w-auto dark:hidden"
                  [style]="d.style"
                />
                <img
                  src="/icons/trama-horizontal-white.svg"
                  alt=""
                  class="hidden h-10 w-auto dark:block"
                  [style]="d.style"
                />
              </div>
              <figcaption
                class="border-border flex items-center gap-1.5 border-t px-3.5 py-2.5 text-[13px]"
              >
                <svg [lucideIcon]="xIcon" [size]="13" class="text-destructive shrink-0"></svg>
                {{ d.label }}
              </figcaption>
            </figure>
          }
        </div>
      </section>
    </main>

    <app-site-footer />
  `,
})
export class BrandPage {
  protected readonly assets = inject(BrandAssets);

  protected readonly logos = LOGOS;
  protected readonly variants = ['black', 'white'] as const;
  protected readonly url = logoUrl;

  protected readonly copyIcon = LucideCopy;
  protected readonly downloadIcon = LucideDownload;
  protected readonly checkIcon = LucideCheck;
  protected readonly xIcon = LucideX;

  protected readonly colors = [
    { name: 'Ink', hex: '#08090B', role: 'Logo on light backgrounds' },
    { name: 'Paper', hex: '#FFFFFF', role: 'Logo on dark backgrounds' },
    { name: 'Terracotta', hex: '#B5583A', role: 'Primary accent, links and actions' },
    { name: 'Night', hex: '#0E0F11', role: 'Dark surfaces' },
    { name: 'Graphite', hex: '#1B1C1F', role: 'Body text on light' },
    { name: 'Mist', hex: '#F4F4F6', role: 'Light surfaces and sidebar' },
    { name: 'Workstream Violet', hex: '#7C5CC4', role: 'Workstreams' },
    { name: 'Decision Amber', hex: '#B7791F', role: 'Decisions' },
  ];

  protected readonly names = [
    { text: 'Trama', ok: true },
    { text: 'TRAMA', ok: false },
    { text: 'trama', ok: false },
    { text: 'TramA', ok: false },
    { text: 'Trama.io', ok: false },
  ];

  protected readonly donts = [
    { label: 'Stretch or squash it', style: 'transform: scaleX(1.5)' },
    { label: 'Rotate it', style: 'transform: rotate(-14deg)' },
    {
      label: 'Recolour it',
      style: 'filter: invert(36%) sepia(84%) saturate(2600%) hue-rotate(330deg)',
    },
    {
      label: 'Add effects',
      style: 'filter: drop-shadow(4px 6px 2px rgb(181 88 58 / 0.8)) blur(0.6px)',
    },
  ];
}
