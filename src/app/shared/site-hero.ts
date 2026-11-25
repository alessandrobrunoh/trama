import {
  ChangeDetectionStrategy,
  Component,
  booleanAttribute,
  computed,
  input,
} from '@angular/core';

/** Column of the public marketing pages: 1200px, 120px side gutters at 1440. */
export const SITE_WRAP = 'mx-auto w-full max-w-[1200px] px-4 sm:px-8 min-[1360px]:px-0';

/**
 * Hero of the public secondary pages (changelog, roadmap, compare), per the v3 site frames:
 * a primary square + mono eyebrow, a 72px Newsreader title, an 18px lede, then projected extras.
 *   <app-site-hero eyebrow="Changelog" title="What's new in Trama" lede="…">links</app-site-hero>
 */
@Component({
  selector: 'app-site-hero',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block', '[class.border-b]': 'bordered()', '[class.border-border]': 'bordered()' },
  template: `
    <div class="flex flex-col items-start gap-5 pt-14 pb-10 sm:pt-20 lg:pt-24" [class]="padding()">
      <p class="flex items-center gap-2.5">
        <span class="bg-primary size-2 shrink-0" aria-hidden="true"></span>
        <span class="text-faint font-mono text-xs leading-none tracking-[1.2px] uppercase">{{
          eyebrow()
        }}</span>
      </p>
      <h1
        class="font-title text-foreground max-w-[1100px] text-[40px] leading-[1.04] tracking-[-1.5px] sm:text-[56px] lg:text-[72px] lg:leading-[73px]"
      >
        {{ title() }}
      </h1>
      <p class="text-muted-foreground max-w-[720px] text-base leading-[26px] sm:text-lg sm:leading-[29px]">
        {{ lede() }}
      </p>
      <ng-content />
    </div>
  `,
})
export class SiteHero {
  readonly eyebrow = input.required<string>();
  readonly title = input.required<string>();
  readonly lede = input.required<string>();
  /** Bottom hairline under the hero (the compare frame has none). */
  readonly bordered = input(true, { transform: booleanAttribute });
  /** 64px bottom padding instead of 56px. */
  readonly tall = input(false, { transform: booleanAttribute });
  protected readonly padding = computed(
    () => `${SITE_WRAP} ${this.tall() ? 'sm:pb-16' : 'sm:pb-14'}`,
  );
}
