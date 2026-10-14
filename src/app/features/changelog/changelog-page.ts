import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideArrowRight, LucideDynamicIcon } from '@lucide/angular';
import { PublicView } from '../views/public-view-page';
import { CHANGELOG, type ChangeKind } from './changelog-entries';
import { SiteFooter } from '../landing/site-footer';
import { SiteHeader } from '../landing/site-header';

/** `/changelog`: curated release notes plus a live list of completed issues. */
@Component({
  selector: 'app-changelog-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, RouterLink, LucideDynamicIcon, PublicView, SiteHeader, SiteFooter],
  host: {
    class: 'bg-background text-foreground relative isolate flex min-h-svh flex-col overflow-x-clip',
  },
  template: `
    <div
      aria-hidden="true"
      class="bg-primary/10 pointer-events-none absolute top-[-22rem] left-1/2 -z-10 h-[36rem] w-[60rem] max-w-[160vw] -translate-x-1/2 rounded-full blur-3xl"
    ></div>
    <app-site-header />

    <main class="mx-auto w-full max-w-4xl flex-1 px-4 pt-16 pb-24 sm:px-6 sm:pt-24">
      <p class="text-primary text-[13px] font-medium">Changelog</p>
      <h1 class="mt-2 text-4xl font-semibold tracking-[-0.03em] sm:text-5xl">
        What's new in Trama
      </h1>
      <p class="text-muted-foreground mt-4 max-w-xl text-[15px] leading-relaxed">
        Every user-visible change, newest first.
      </p>
      <a
        routerLink="/roadmap"
        class="text-primary mt-5 inline-flex items-center gap-1 text-[13px] font-medium"
      >
        See what's coming next <svg [lucideIcon]="arrowIcon" [size]="14"></svg>
      </a>

      <ol class="mt-14 flex flex-col">
        @for (entry of entries; track entry.title) {
          <li class="border-border grid gap-4 border-t py-10 sm:grid-cols-[10rem_1fr] sm:gap-8">
            <time [attr.datetime]="entry.date" class="text-muted-foreground text-[13px] sm:pt-1.5">
              {{ entry.date | date: 'MMMM d, y' }}
            </time>
            <article>
              <h2 class="text-2xl font-semibold tracking-[-0.02em]">{{ entry.title }}</h2>
              <p class="text-muted-foreground mt-2 text-[15px] leading-relaxed">
                {{ entry.summary }}
              </p>
              <ul class="mt-5 flex flex-col gap-2.5 text-[14px] leading-relaxed">
                @for (c of entry.changes; track c.text) {
                  <li class="flex items-start gap-3">
                    <span
                      class="mt-0.5 w-[4.5rem] shrink-0 rounded-full px-2 py-0.5 text-center text-[11px] font-medium"
                      [class]="badge[c.kind]"
                      >{{ label[c.kind] }}</span
                    >
                    <span>{{ c.text }}</span>
                  </li>
                }
              </ul>
            </article>
          </li>
        }
      </ol>

      <section class="border-border mt-12 border-t pt-8">
        <h2 class="text-2xl font-semibold tracking-[-0.02em]">Completed issues</h2>
        <p class="text-muted-foreground mt-2 text-[14px] leading-relaxed">
          Issues currently marked done in the Trama project.
        </p>
        <app-public-view class="mt-5 block w-full" [embedded]="true" [viewSource]="'changelog'" />
      </section>
    </main>

    <app-site-footer />
  `,
})
export class ChangelogPage {
  protected readonly arrowIcon = LucideArrowRight;
  protected readonly label: Record<ChangeKind, string> = {
    new: 'New',
    improved: 'Improved',
    fixed: 'Fixed',
  };
  protected readonly badge: Record<ChangeKind, string> = {
    new: 'bg-primary/12 text-primary',
    improved: 'bg-tone-blue/12 text-tone-blue',
    fixed: 'bg-tone-green/12 text-tone-green',
  };

  protected readonly entries = CHANGELOG;
}
