import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import { LucideCheck, LucideDynamicIcon, LucideX } from '@lucide/angular';
import { SiteFooter } from '../landing/site-footer';
import { SiteHeader } from '../landing/site-header';
import { SiteWeave } from '../landing/site-weave';
import { BrandAssets } from './brand-assets';
import {
  LOGOS,
  LOGO_VARIANTS,
  WARP_PATH,
  WEFT_PATH,
  logoDataUrl,
  type LogoAsset,
  type LogoVariantInfo,
} from './brand-logo';
import { BrandMark } from './brand-mark';

interface Swatch {
  name: string;
  hex: string;
  use: string;
}

interface Face {
  family: string;
  aa: string;
  kicker: string;
  sample: string;
  font: string;
  sampleClass: string;
}

interface Dont {
  label: string;
  weft?: string;
  warp?: string;
  style?: string;
  size?: number;
  shift?: string;
}

/** Eyebrow ("01 LOGOS"), Newsreader title and the aside paragraph of a brand section. */
@Component({
  selector: 'app-brand-head',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex flex-col justify-between gap-5 lg:flex-row lg:items-end' },
  template: `
    <div class="flex flex-col gap-3.5">
      <div class="flex items-center gap-2.5 font-mono text-[12px]">
        <span class="text-primary">{{ num() }}</span>
        <span class="text-faint tracking-[1.2px]">{{ label() }}</span>
      </div>
      <h2
        class="font-title text-foreground text-[clamp(32px,3.1vw,44px)] leading-[1.15] tracking-[-0.014em]"
      >
        {{ title() }}
      </h2>
    </div>
    <p class="text-muted-foreground max-w-[460px] text-[15px] leading-6">
      <ng-content />
    </p>
  `,
})
export class BrandHead {
  readonly num = input.required<string>();
  readonly label = input.required<string>();
  readonly title = input.required<string>();
}

const SECTION = 'mx-auto flex w-full max-w-[1440px] flex-col gap-10 px-5 py-16 md:px-10 md:py-24 xl:px-[120px]';

/** `/brand`: logos, construction, colours, type and usage rules, with copy / download for every asset. */
@Component({
  selector: 'app-brand-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BrandHead, BrandMark, LucideDynamicIcon, SiteFooter, SiteHeader, SiteWeave],
  host: { class: 'bg-background text-foreground block min-h-svh overflow-x-clip leading-normal' },
  template: `
    <app-site-header />

    <main>
      <!-- Hero -->
      <section
        class="mx-auto flex w-full max-w-[1440px] flex-col items-start gap-5 px-5 pt-14 pb-12 md:px-10 md:pt-24 md:pb-16 xl:px-[120px]"
      >
        <div class="flex items-center gap-2.5">
          <span class="bg-primary size-2" aria-hidden="true"></span>
          <p class="text-faint font-mono text-[12px] tracking-[1.2px]">BRAND</p>
        </div>
        <h1
          class="font-title text-foreground text-[clamp(44px,5vw,72px)] leading-none tracking-[-0.021em]"
        >
          Trama brand
        </h1>
        <p class="text-muted-foreground max-w-[720px] text-[18px] leading-[29px]">
          Logos, colours and type for writing about Trama, linking to it or building on top of it.
          Copy any asset as SVG, download it as SVG or PNG, or grab everything at once.
        </p>
        <button
          type="button"
          class="bg-primary text-primary-foreground hover:bg-primary-strong mt-2 px-3.5 py-[9px] font-mono text-[12.5px] transition-colors"
          (click)="assets.downloadAll()"
        >
          Download all assets (.zip)
        </button>
      </section>

      <app-site-weave />

      <!-- 01 Logos -->
      <section [class]="section" aria-labelledby="logos">
        <app-brand-head id="logos" num="01" label="LOGOS" title="Logos">
          The mark is two strands woven into one fabric: the warp and the weft, trama in Italian,
          crossing over and under on a loom. Amber weft, ink warp. Use white or black when colour
          isn't available.
        </app-brand-head>
        <div class="flex flex-col">
          @for (logo of logos; track logo.kind) {
            <article class="border-border flex flex-col gap-5 border-t pt-7 pb-8 lg:flex-row lg:gap-8">
              <div class="flex flex-col gap-2 lg:w-[240px] lg:shrink-0">
                <h3 class="font-title text-foreground text-[24px] leading-tight">{{ logo.name }}</h3>
                <p class="text-muted-foreground text-[13.5px] leading-[21px]">
                  {{ logo.description }}
                </p>
              </div>
              <div class="grid min-w-0 flex-1 grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
                @for (v of variants; track v.variant) {
                  <figure class="border-border flex min-w-0 flex-col border">
                    <div
                      class="flex h-[160px] items-center justify-center sm:h-[200px]"
                      [class]="v.surface === 'light' ? 'bg-white' : 'bg-[#0f1114]'"
                    >
                      <img
                        [src]="previews[logo.kind + '/' + v.variant]"
                        [attr.width]="logo.width"
                        [attr.height]="logo.height"
                        [alt]="'Trama ' + logo.name.toLowerCase() + ', ' + v.label.toLowerCase()"
                        class="max-w-[80%]"
                      />
                    </div>
                    <figcaption
                      class="border-border flex flex-wrap items-center gap-x-2.5 gap-y-1 border-t px-3 py-2.5 font-mono text-[10.5px]"
                    >
                      <span class="text-faint mr-auto text-[10px]">{{ v.label }}</span>
                      <button
                        type="button"
                        class="text-primary hover:text-primary-strong"
                        (click)="assets.copySvg(logo.kind, v.variant)"
                      >
                        Copy
                      </button>
                      <button
                        type="button"
                        class="text-muted-foreground hover:text-foreground"
                        (click)="assets.downloadSvg(logo.kind, v.variant)"
                      >
                        SVG
                      </button>
                      <button
                        type="button"
                        class="text-muted-foreground hover:text-foreground"
                        (click)="assets.downloadPng(logo.kind, v.variant)"
                      >
                        PNG
                      </button>
                    </figcaption>
                  </figure>
                }
              </div>
            </article>
          }
        </div>
      </section>

      <!-- 02 Construction -->
      <section class="border-border border-t" aria-labelledby="construction">
        <div [class]="section">
          <app-brand-head
            id="construction"
            num="02"
            label="CONSTRUCTION"
            title="Construction and clear space"
          >
            Built on a 4-unit module inside a 100-unit square: every edge lands on the grid. Two
            60-unit frames with a 12-unit band, offset by 32. Each strand passes over the other once,
            with a 4-unit gap at every crossing.
          </app-brand-head>
          <div class="flex flex-col gap-6 lg:flex-row">
            <div
              class="bg-card border-border flex aspect-square w-full items-center justify-center border lg:w-[520px] lg:shrink-0"
            >
              <div class="relative aspect-square w-[84.6%]">
                <svg
                  viewBox="0 0 100 100"
                  preserveAspectRatio="none"
                  class="absolute inset-0 size-full overflow-visible"
                  fill="none"
                  aria-hidden="true"
                >
                  @for (u of gridUnits; track u) {
                    <path
                      [attr.d]="'M' + u + ' 0V100M0 ' + u + 'H100'"
                      vector-effect="non-scaling-stroke"
                      stroke-width="1"
                      [class]="module.includes(u) ? 'stroke-border-strong' : 'stroke-border'"
                    />
                  }
                </svg>
                <svg
                  viewBox="0 0 96 96"
                  preserveAspectRatio="none"
                  class="absolute inset-0 size-full overflow-visible opacity-90"
                  aria-hidden="true"
                >
                  <path [attr.d]="weftPath" class="fill-primary" fill-opacity="0.4" />
                  <path [attr.d]="warpPath" class="fill-text-2" />
                </svg>
                <span class="text-foreground absolute top-[6.4%] left-[66%] font-mono text-[11px]"
                  >BAND 12</span
                >
                <span class="text-foreground absolute top-[31.4%] left-[68.6%] font-mono text-[11px]"
                  >GAP 4</span
                >
                <span class="text-foreground absolute top-[73%] left-[67.3%] font-mono text-[11px]"
                  >OFFSET 32</span
                >
                <span class="text-foreground absolute top-[19%] left-[18.6%] font-mono text-[11px]"
                  >60 × 60</span
                >
              </div>
            </div>
            <div class="flex min-w-0 flex-1 flex-col gap-6">
              <div
                class="bg-card border-border flex h-[300px] flex-col items-center justify-center gap-4 border"
              >
                <div class="outline-primary p-10 outline-1 -outline-offset-1 outline-dashed">
                  <app-brand-mark [size]="80" weft="var(--primary)" warp="var(--foreground)" />
                </div>
                <span class="text-faint font-mono text-[10.5px]"
                  >CLEAR SPACE = ½ OF THE MARK ON EVERY SIDE</span
                >
              </div>
              <div
                class="bg-card border-border flex h-[196px] items-end justify-center gap-6 border pb-8 sm:gap-10"
              >
                @for (s of sizes; track s) {
                  <div class="flex flex-col items-center gap-2.5">
                    <app-brand-mark [size]="s" weft="var(--primary)" warp="var(--foreground)" />
                    <span class="text-faint font-mono text-[10px]">{{ s }}px</span>
                  </div>
                }
              </div>
              <p class="text-muted-foreground text-[14px] leading-[22px]">
                The logomark is never smaller than 16px, and the horizontal logo never shorter than
                20px. At 16–28px the band gets thinner and the gaps wider, so the weave still reads.
                The interface uses the same 4-unit module for spacing and icon grids.
              </p>
            </div>
          </div>
        </div>
      </section>

      <!-- 03 Colours -->
      <section class="border-border border-t" aria-labelledby="colours">
        <div [class]="section">
          <app-brand-head id="colours" num="03" label="COLOURS" title="Colours">
            Trama is mostly ink and paper, with one amber accent. Amber is the weft in the logo and
            the colour of every primary action. Click a swatch to copy its hex value.
          </app-brand-head>
          <div class="flex flex-col gap-4 lg:flex-row">
            <div class="border-border flex min-w-0 flex-1 flex-col border">
              <div class="flex h-[220px]">
                <button
                  type="button"
                  class="flex flex-1 flex-col justify-end bg-[#e2a93b] p-4 text-left"
                  aria-label="Copy amber on dark, #E2A93B"
                  (click)="assets.copyText('#E2A93B', 'Amber copied')"
                ></button>
                <button
                  type="button"
                  class="flex flex-1 flex-col justify-end bg-[#c98a1e] p-4 text-left"
                  aria-label="Copy amber on light, #C98A1E"
                  (click)="assets.copyText('#C98A1E', 'Amber (light) copied')"
                ></button>
              </div>
              <div class="flex flex-col gap-1 px-4 py-3.5">
                <span class="text-foreground text-[15px] font-medium">Amber</span>
                <span class="text-muted-foreground font-mono text-[11px]"
                  >#E2A93B on dark · #C98A1E on light</span
                >
                <span class="text-faint text-[12.5px]"
                  >The weft in the logo, primary actions, focus and progress. Text on amber is
                  #1A1206.</span
                >
              </div>
            </div>
            @for (c of core; track c.name) {
              <button
                type="button"
                class="border-border hover:bg-card flex flex-col border text-left transition-colors lg:w-[280px] lg:shrink-0"
                (click)="assets.copyText(c.hex, c.name + ' copied')"
              >
                <span class="block h-[220px] w-full" [style.background]="c.hex"></span>
                <span class="flex flex-col gap-1 px-4 py-3.5">
                  <span class="text-foreground text-[15px] font-medium">{{ c.name }}</span>
                  <span class="text-muted-foreground font-mono text-[11px]">{{ c.hex }}</span>
                  <span class="text-faint text-[12.5px] leading-[18px]">{{ c.use }}</span>
                </span>
              </button>
            }
          </div>
          <div class="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-5">
            @for (c of neutrals; track c.name) {
              <button
                type="button"
                class="border-border hover:bg-card flex flex-col border text-left transition-colors"
                (click)="assets.copyText(c.hex, c.name + ' copied')"
              >
                <span class="block h-24 w-full" [style.background]="c.hex"></span>
                <span class="flex flex-col gap-1 px-4 py-3.5">
                  <span class="text-foreground text-[15px] font-medium">{{ c.name }}</span>
                  <span class="text-muted-foreground font-mono text-[11px]">{{ c.hex }}</span>
                  <span class="text-faint text-[12.5px] leading-[18px]">{{ c.use }}</span>
                </span>
              </button>
            }
          </div>
          <div
            class="border-border flex flex-col gap-4 border-t pt-5 md:flex-row md:flex-wrap md:items-center md:gap-[18px]"
          >
            <span class="text-foreground text-[14px] font-medium md:mr-auto"
              >Workspace accents · the logo always stays amber</span
            >
            <ul class="flex flex-wrap gap-x-[18px] gap-y-2">
              @for (a of accents; track a.name) {
                <li class="flex items-center gap-1.5">
                  <span class="size-3" [style.background]="a.hex"></span>
                  <span class="text-muted-foreground font-mono text-[10.5px]">{{ a.name }}</span>
                </li>
              }
            </ul>
          </div>
        </div>
      </section>

      <!-- 04 Typography -->
      <section class="border-border border-t" aria-labelledby="typography">
        <div [class]="section">
          <app-brand-head id="typography" num="04" label="TYPOGRAPHY" title="Typography">
            Three families, all free on Google Fonts. A serif for headings and the wordmark, a sans
            for the interface, a mono for anything you could type.
          </app-brand-head>
          <div class="grid gap-4 lg:grid-cols-3">
            @for (f of faces; track f.family) {
              <div class="border-border flex flex-col gap-5 border p-7">
                <span
                  class="text-foreground text-[112px] leading-[112px] tracking-[-2px]"
                  [class]="f.font"
                  aria-hidden="true"
                  >{{ f.aa }}</span
                >
                <div class="border-border flex flex-col gap-1.5 border-t pt-5">
                  <span class="text-faint font-mono text-[10px]">{{ f.kicker }}</span>
                  <span class="text-foreground text-[18px] font-medium">{{ f.family }}</span>
                  <span class="text-muted-foreground" [class]="f.sampleClass">{{ f.sample }}</span>
                </div>
              </div>
            }
          </div>
        </div>
      </section>

      <!-- 05 Writing the name -->
      <section class="border-border border-t" aria-labelledby="name">
        <div [class]="section">
          <app-brand-head id="name" num="05" label="WRITING THE NAME" title="Writing the name">
            Trama is one word with a capital T, in running text and in titles. It is Italian for
            weft, the thread that ties a fabric together, and for the plot of a play.
          </app-brand-head>
          <div class="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-5">
            @for (n of names; track n.text) {
              <div
                class="flex flex-col border"
                [class]="n.ok ? 'border-primary' : 'border-border'"
              >
                <div
                  class="flex h-[140px] items-center justify-center text-[30px] font-medium"
                  [class]="n.ok ? 'bg-primary/10 text-foreground' : 'bg-card text-faint'"
                >
                  {{ n.text }}
                </div>
                <div
                  class="border-border flex items-center gap-2 border-t px-3.5 py-2.5 font-mono text-[11px]"
                  [class]="n.ok ? 'text-foreground' : 'text-muted-foreground'"
                >
                  <svg
                    [lucideIcon]="n.ok ? checkIcon : xIcon"
                    [size]="14"
                    [class]="n.ok ? 'text-green' : 'text-red'"
                  ></svg>
                  {{ n.ok ? 'Correct' : "Please don't" }}
                </div>
              </div>
            }
          </div>
        </div>
      </section>

      <!-- 06 Misuse -->
      <section class="border-border border-t" aria-labelledby="misuse">
        <div [class]="section">
          <app-brand-head id="misuse" num="06" label="MISUSE" title="Please don't">
            Use the files as they are. If a placement doesn't work, use the one-colour version or
            step down to the wordmark, rather than changing the mark.
          </app-brand-head>
          <div class="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-5">
            @for (d of donts; track d.label) {
              <figure class="border-border flex flex-col border">
                <div class="bg-card flex h-[200px] items-center justify-center overflow-hidden">
                  <app-brand-mark
                    [size]="d.size ?? 96"
                    [weft]="d.weft ?? '#e2a93b'"
                    [warp]="d.warp ?? '#dcdde0'"
                    [warpShift]="d.shift ?? null"
                    [style]="d.style ?? null"
                  />
                </div>
                <figcaption
                  class="border-border text-muted-foreground flex items-center gap-2 border-t px-3.5 py-2.5 text-[13px]"
                >
                  <svg [lucideIcon]="xIcon" [size]="14" class="text-red shrink-0"></svg>
                  {{ d.label }}
                </figcaption>
              </figure>
            }
          </div>
        </div>
      </section>
    </main>

    <app-site-footer />
  `,
})
export class BrandPage {
  protected readonly assets = inject(BrandAssets);

  protected readonly section = SECTION;
  protected readonly logos: readonly LogoAsset[] = LOGOS;
  protected readonly variants: readonly LogoVariantInfo[] = LOGO_VARIANTS;
  /** `kind/variant` → the data URL of the exact file that is copied and downloaded. */
  protected readonly previews: Readonly<Record<string, string>> = Object.fromEntries(
    LOGOS.flatMap((l) =>
      LOGO_VARIANTS.map((v) => [`${l.kind}/${v.variant}`, logoDataUrl(l.kind, v.variant)]),
    ),
  );

  protected readonly checkIcon = LucideCheck;
  protected readonly xIcon = LucideX;
  protected readonly weftPath = WEFT_PATH;
  protected readonly warpPath = WARP_PATH;

  /** Construction grid: a line every 4 units, stronger on the edges of the module. */
  protected readonly gridUnits: readonly number[] = Array.from({ length: 26 }, (_, i) => i * 4);
  protected readonly module: readonly number[] = [4, 16, 36, 48, 52, 64, 68, 84, 96];
  protected readonly sizes: readonly number[] = [16, 20, 24, 32, 48];

  protected readonly core: readonly Swatch[] = [
    { name: 'Ink', hex: '#0F1114', use: 'The logo on light, and dark surfaces.' },
    { name: 'Paper', hex: '#FFFFFF', use: 'The logo on dark, and light surfaces.' },
  ];

  protected readonly neutrals: readonly Swatch[] = [
    { name: 'Night', hex: '#14161A', use: 'Panels and the sidebar in dark mode.' },
    { name: 'Fog', hex: '#DCDDE0', use: 'Body text on dark.' },
    { name: 'Graphite', hex: '#17181C', use: 'Body text on light.' },
    { name: 'Mist', hex: '#F7F7F8', use: 'Panels and the sidebar in light mode.' },
    { name: 'Line', hex: '#24272D', use: 'Borders and dividers in dark mode.' },
  ];

  protected readonly accents: readonly { name: string; hex: string }[] = [
    { name: 'terracotta', hex: '#B5583A' },
    { name: 'vermilion', hex: '#CC4B30' },
    { name: 'crimson', hex: '#E5484D' },
    { name: 'orange', hex: '#EE6A2F' },
    { name: 'moss', hex: '#3F8F5A' },
    { name: 'teal', hex: '#14918A' },
    { name: 'cobalt', hex: '#3D5BD9' },
    { name: 'violet', hex: '#7C5CC4' },
  ];

  protected readonly faces: readonly Face[] = [
    {
      family: 'Newsreader',
      aa: 'Aa',
      kicker: 'HEADINGS AND THE WORDMARK',
      sample: 'Every project has a plot.',
      font: 'font-title',
      sampleClass: 'font-title text-[22px]',
    },
    {
      family: 'IBM Plex Sans',
      aa: 'Aa',
      kicker: 'INTERFACE AND BODY TEXT',
      sample: 'Rotate OAuth tokens before expiry',
      font: 'font-sans',
      sampleClass: 'font-sans text-[15px]',
    },
    {
      family: 'IBM Plex Mono',
      aa: 'Aa',
      kicker: 'TASK KEYS, SHORTCUTS AND CODE',
      sample: 'TRM-128  ⌘K  /trama',
      font: 'font-mono',
      sampleClass: 'font-mono text-[15px]',
    },
  ];

  protected readonly names: readonly { text: string; ok: boolean }[] = [
    { text: 'Trama', ok: true },
    { text: 'TRAMA', ok: false },
    { text: 'trama', ok: false },
    { text: 'TramA', ok: false },
    { text: 'Trama.io', ok: false },
  ];

  protected readonly donts: readonly Dont[] = [
    { label: 'Stretch or squash it', style: 'transform: scale(1.5625, 0.875)' },
    { label: 'Rotate it', style: 'transform: rotate(-30deg)' },
    { label: 'Recolour it', weft: '#5274e0', warp: '#cc4b30' },
    {
      label: 'Add effects',
      style: 'filter: drop-shadow(0 0 14px #e2a93baa) drop-shadow(6px 10px 4px #000000cc)',
    },
    { label: 'Unweave it', shift: 'translate(-12 -12)' },
  ];
}
