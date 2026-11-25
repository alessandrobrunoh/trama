import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideArrowRight, LucideDynamicIcon, LucideX } from '@lucide/angular';
import { SITE_WRAP, SiteHero } from '../../shared/site-hero';
import { SiteFooter } from '../landing/site-footer';
import { SiteHeader } from '../landing/site-header';
import { RoadmapBoard } from './roadmap-board';

/** `/roadmap`: public product direction from a link-shared issue view (v3 frame 36). */
@Component({
  selector: 'app-roadmap-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, LucideDynamicIcon, SiteHero, SiteHeader, SiteFooter, RoadmapBoard],
  host: { class: 'bg-background text-foreground flex min-h-svh flex-col overflow-x-clip' },
  template: `
    <app-site-header />

    <main class="flex-1">
      <app-site-hero
        eyebrow="Roadmap"
        title="Where Trama is going"
        lede="A task-first workspace where plans and context stay attached to the work. Dates are deliberately absent: we'd rather ship when it's right than hit a number we made up."
      >
        <a
          routerLink="/changelog"
          class="text-primary flex items-center gap-2 pt-1 font-mono text-[13px] leading-none hover:underline"
        >
          See what already shipped <svg [lucideIcon]="arrowIcon" [size]="14"></svg>
        </a>
      </app-site-hero>

      <!-- The saved public view is the source of truth; the board stays read-only here. -->
      <app-roadmap-board [class]="wrap" class="pt-12" />

      <section
        [class]="wrap"
        class="flex flex-col gap-10 py-16 sm:py-24 lg:flex-row lg:gap-20"
      >
        <div class="flex flex-col gap-4 lg:w-[440px] lg:shrink-0">
          <h2
            class="font-title text-foreground text-[32px] leading-[1.1] tracking-[-0.6px] sm:text-[40px] sm:leading-[44px]"
          >
            Deliberately not on the roadmap
          </h2>
          <p class="text-muted-foreground text-base leading-[26px]">
            Saying no keeps Trama focused. These come up often, and we think they would make the
            product worse.
          </p>
        </div>
        <ul class="flex min-w-0 flex-1 flex-col">
          @for (no of notPlanned; track no) {
            <li class="border-border flex items-center gap-4 border-b py-[18px]">
              <svg
                [lucideIcon]="xIcon"
                [size]="14"
                class="text-faint shrink-0"
                aria-hidden="true"
              ></svg>
              <span class="text-foreground text-base leading-snug sm:text-[17px]">{{ no }}</span>
            </li>
          }
        </ul>
      </section>
    </main>

    <app-site-footer />
  `,
})
export class RoadmapPage {
  protected readonly wrap = SITE_WRAP;
  protected readonly arrowIcon = LucideArrowRight;
  protected readonly xIcon = LucideX;

  protected readonly notPlanned = [
    'Completion percentages that are not measured',
    'Agent telemetry and token-usage dashboards',
    'Scoring agents or people by “performance”',
    'Elaborate sprint analytics',
    'A general-purpose automation builder',
    'Mirroring full agent conversations inside Trama',
  ];
}
