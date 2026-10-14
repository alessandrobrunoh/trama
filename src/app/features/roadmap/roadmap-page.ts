import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideArrowRight, LucideBan, LucideDynamicIcon } from '@lucide/angular';
import { PublicView } from '../views/public-view-page';
import { SiteFooter } from '../landing/site-footer';
import { SiteHeader } from '../landing/site-header';

/** `/roadmap`: public product direction from a link-shared issue view. */
@Component({
  selector: 'app-roadmap-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, LucideDynamicIcon, PublicView, SiteHeader, SiteFooter],
  host: {
    class: 'bg-background text-foreground relative isolate flex min-h-svh flex-col overflow-x-clip',
  },
  template: `
    <div
      aria-hidden="true"
      class="bg-primary/10 pointer-events-none absolute top-[-22rem] left-1/2 -z-10 h-[36rem] w-[60rem] max-w-[160vw] -translate-x-1/2 rounded-full blur-3xl"
    ></div>
    <app-site-header />

    <main class="w-full flex-1 pt-16 pb-24 sm:pt-24">
      <div class="mx-auto max-w-6xl px-4 sm:px-6">
        <div class="max-w-2xl">
          <p class="text-primary text-[13px] font-medium">Roadmap</p>
          <h1 class="mt-2 text-4xl font-semibold tracking-[-0.03em] sm:text-5xl">
            Where Trama is going
          </h1>
          <p class="text-muted-foreground mt-4 text-[15px] leading-relaxed">
            We're building an issue-first workspace where plans, decisions and human input stay
            attached to the work they concern. Dates are deliberately absent: we would rather ship
            when it's right than hit a number we made up.
          </p>
          <a
            routerLink="/changelog"
            class="text-primary mt-5 inline-flex items-center gap-1 text-[13px] font-medium"
          >
            See what already shipped <svg [lucideIcon]="arrowIcon" [size]="14"></svg>
          </a>
        </div>
      </div>

      <!-- The saved public view is the source of truth; its board stays read-only here. -->
      <div class="mx-auto mt-12 flex max-w-[78rem]">
        <app-public-view class="block min-w-0 w-full" [embedded]="true" [viewSource]="'roadmap'" />
      </div>

      <div class="mx-auto max-w-6xl px-4 sm:px-6">
        <section class="border-border mt-16 rounded-2xl border border-dashed p-6 sm:p-8">
          <div class="flex items-center gap-2">
            <svg [lucideIcon]="banIcon" [size]="16" class="text-muted-foreground"></svg>
            <h2 class="font-semibold">Deliberately not on the roadmap</h2>
          </div>
          <p class="text-muted-foreground mt-2 max-w-2xl text-[13px] leading-relaxed">
            Saying no keeps Trama focused. These come up often, and we think they would make the
            product worse.
          </p>
          <ul class="mt-5 grid gap-x-8 gap-y-2 text-[13px] sm:grid-cols-2">
            @for (no of notPlanned; track no) {
              <li class="text-muted-foreground flex gap-2">
                <span aria-hidden="true">—</span>{{ no }}
              </li>
            }
          </ul>
        </section>
      </div>
    </main>

    <app-site-footer />
  `,
})
export class RoadmapPage {
  protected readonly arrowIcon = LucideArrowRight;
  protected readonly banIcon = LucideBan;

  protected readonly notPlanned = [
    'Completion percentages that are not measured',
    'Agent telemetry and token-usage dashboards',
    'Scoring agents or people by “performance”',
    'Elaborate sprint analytics',
    'A general-purpose automation builder',
    'Mirroring full agent conversations inside Trama',
  ];
}
