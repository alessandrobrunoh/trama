import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  LucideArrowRight,
  LucideChevronDown,
  LucideDynamicIcon,
  LucideList,
  LucideRss,
} from '@lucide/angular';
import { ApiClient } from '../../core/api/api-client';
import { SITE_WRAP, SiteHero } from '../../shared/site-hero';
import { SiteFooter } from '../landing/site-footer';
import { SiteHeader } from '../landing/site-header';
import { CHANGELOG, type ChangeKind } from './changelog-entries';

const REPO_URL = 'https://github.com/alessandrobrunoh/trama';
/** Releases shown before "Older releases" is opened. */
const INITIAL_RELEASES = 3;

/** `/changelog`: curated release notes, newest first (v3 frame 35). */
@Component({
  selector: 'app-changelog-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, RouterLink, LucideDynamicIcon, SiteHero, SiteHeader, SiteFooter],
  host: { class: 'bg-background text-foreground flex min-h-svh flex-col overflow-x-clip' },
  template: `
    <app-site-header />

    <main class="flex-1">
      <app-site-hero
        eyebrow="Changelog"
        title="What's new in Trama"
        lede="Release history, newest first. Each entry describes Trama as it was when that change shipped."
      >
        <a
          routerLink="/roadmap"
          class="text-primary flex items-center gap-2 pt-1 font-mono text-[13px] leading-none hover:underline"
        >
          See what's coming next <svg [lucideIcon]="arrowIcon" [size]="14"></svg>
        </a>
        <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
          <a
            [href]="repoUrl + '/releases.atom'"
            class="border-border text-muted-foreground hover:text-foreground flex items-center gap-1.5 border px-2.5 py-[5px] font-mono text-[11.5px] leading-none"
          >
            <svg [lucideIcon]="rssIcon" [size]="12"></svg>RSS feed
          </a>
          <a
            [href]="repoUrl + '/releases'"
            class="border-border text-muted-foreground hover:text-foreground flex items-center gap-1.5 border px-2.5 py-[5px] font-mono text-[11.5px] leading-none"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path
                d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"
              />
              <path d="M9 18c-4.51 2-5-2-7-2" />
            </svg>
            Releases on GitHub
          </a>
          @if (sharedViewToken(); as token) {
            <a
              [routerLink]="['/shared', token]"
              class="border-border text-muted-foreground hover:text-foreground flex items-center gap-1.5 border px-2.5 py-[5px] font-mono text-[11.5px] leading-none"
            >
              <svg [lucideIcon]="listIcon" [size]="12"></svg>Open as a shared view
            </a>
          }
        </div>
      </app-site-hero>

      <div [class]="wrap" class="pb-16 sm:pb-24">
        <ol class="flex flex-col">
          @for (entry of visible(); track entry.title) {
            <li
              class="border-border grid gap-x-16 gap-y-4 border-b py-10 sm:py-14 md:grid-cols-[220px_1fr]"
            >
              <div class="flex flex-col items-start gap-2">
                <time
                  [attr.datetime]="entry.date"
                  class="text-foreground font-mono text-[13px] leading-none"
                  >{{ entry.date | date: 'MMMM d, y' }}</time
                >
                @if (entry.version) {
                  <span
                    class="bg-secondary text-muted-foreground px-1.5 py-px font-mono text-[11px] leading-[15px]"
                    >{{ entry.version }}</span
                  >
                }
              </div>
              <article class="flex min-w-0 flex-col items-start gap-4">
                <h2
                  class="font-title text-foreground text-[26px] leading-[1.15] tracking-[-0.5px] sm:text-[34px] sm:leading-normal"
                >
                  {{ entry.title }}
                </h2>
                <p class="text-muted-foreground text-base leading-[26px]">{{ entry.summary }}</p>
                <ul class="flex w-full flex-col pt-2">
                  @for (c of entry.changes; track c.text) {
                    <li class="border-border flex items-start gap-4 border-t py-2.5">
                      <span class="w-[80px] shrink-0">
                        <span
                          class="inline-block px-1.5 py-px font-mono text-[10px] leading-[15px] tracking-[0.8px] uppercase"
                          [class]="badge[c.kind]"
                          >{{ label[c.kind] }}</span
                        >
                      </span>
                      <span class="text-foreground min-w-0 flex-1 text-[14.5px] leading-[22px]">{{
                        c.text
                      }}</span>
                    </li>
                  }
                </ul>
              </article>
            </li>
          }
        </ol>

        @if (older() > 0 && !showAll()) {
          <div class="flex items-center pt-8 md:pl-[284px]">
            <button
              type="button"
              class="text-muted-foreground hover:text-foreground flex items-center gap-2 font-mono text-[12.5px] leading-none"
              (click)="showAll.set(true)"
            >
              Older releases <svg [lucideIcon]="chevronIcon" [size]="14"></svg>
            </button>
          </div>
        }
      </div>
    </main>

    <app-site-footer />
  `,
})
export class ChangelogPage {
  private readonly api = inject(ApiClient);

  protected readonly wrap = SITE_WRAP;
  protected readonly repoUrl = REPO_URL;
  protected readonly arrowIcon = LucideArrowRight;
  protected readonly rssIcon = LucideRss;
  protected readonly listIcon = LucideList;
  protected readonly chevronIcon = LucideChevronDown;

  protected readonly label: Record<ChangeKind, string> = {
    new: 'New',
    improved: 'Improved',
    fixed: 'Fixed',
  };
  protected readonly badge: Record<ChangeKind, string> = {
    new: 'bg-primary/20 text-primary',
    improved: 'bg-delta-line/15 text-delta-line',
    fixed: 'bg-green/15 text-green',
  };

  protected readonly showAll = signal(false);
  protected readonly visible = computed(() =>
    this.showAll() ? CHANGELOG : CHANGELOG.slice(0, INITIAL_RELEASES),
  );
  protected readonly older = computed(() => Math.max(0, CHANGELOG.length - INITIAL_RELEASES));

  /** Token of the workspace's changelog Shared View (live list of completed tasks), when configured. */
  protected readonly sharedViewToken = signal<string | null>(null);

  constructor() {
    this.api
      .publicConfig()
      .then((config) => this.sharedViewToken.set(config.changelogViewToken))
      .catch(() => this.sharedViewToken.set(null));
  }
}
