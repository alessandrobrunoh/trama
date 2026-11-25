import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideArrowRight, LucideDynamicIcon } from '@lucide/angular';
import { SiteFooter } from '../landing/site-footer';
import { SiteHeader } from '../landing/site-header';
import { SiteWeave } from '../landing/site-weave';
import { BLOG_POSTS } from './blog-posts';

/** `/blog`: public list of posts, newest first, as a hairline index. */
@Component({
  selector: 'app-blog-index-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, RouterLink, LucideDynamicIcon, SiteHeader, SiteFooter, SiteWeave],
  host: { class: 'bg-background text-foreground block min-h-svh overflow-x-clip leading-normal' },
  template: `
    <app-site-header />

    <main>
      <section
        class="mx-auto flex w-full max-w-[1440px] flex-col gap-5 px-5 pt-14 pb-12 md:px-10 md:pt-24 md:pb-16 xl:px-[120px]"
      >
        <div class="flex items-center gap-2.5">
          <span class="bg-primary size-2" aria-hidden="true"></span>
          <p class="text-faint font-mono text-[12px] tracking-[1.2px]">BLOG</p>
        </div>
        <h1
          class="font-title text-foreground text-[clamp(44px,5vw,72px)] leading-none tracking-[-0.021em]"
        >
          Notes from the loom
        </h1>
        <p class="text-muted-foreground max-w-[720px] text-[18px] leading-[29px]">
          Product updates, ideas about how humans and coding agents work together, and honest
          comparisons with the tools you already use.
        </p>
      </section>

      <app-site-weave />

      <section
        class="mx-auto w-full max-w-[1440px] px-5 py-12 md:px-10 md:py-20 xl:px-[120px]"
        aria-label="Posts"
      >
        <ul class="flex flex-col">
          @for (post of posts; track post.slug; let first = $first) {
            <li class="border-border border-b" [class.border-t]="first">
              <a
                [routerLink]="['/blog', post.slug]"
                class="group hover:bg-card flex flex-col gap-4 py-8 transition-colors lg:flex-row lg:gap-16"
              >
                <div
                  class="text-faint flex shrink-0 items-center gap-3 font-mono text-[11px] tracking-[1.2px] lg:w-[260px] lg:flex-col lg:items-start lg:gap-2"
                >
                  <span class="text-primary">{{ post.tag.toUpperCase() }}</span>
                  <span class="flex items-center gap-2">
                    <time [attr.datetime]="post.date">{{ post.date | date: 'MMM d, y' }}</time>
                    <span aria-hidden="true">·</span>
                    {{ post.readingMinutes }} min read
                  </span>
                </div>
                <div class="flex min-w-0 flex-1 flex-col gap-3">
                  <h2
                    class="font-title text-foreground group-hover:text-primary text-[clamp(26px,3vw,36px)] leading-[1.15] tracking-[-0.014em] transition-colors"
                  >
                    {{ post.title }}
                  </h2>
                  <p class="text-muted-foreground max-w-[680px] text-[15px] leading-6">
                    {{ post.description }}
                  </p>
                  <span class="text-foreground mt-1 inline-flex items-center gap-1.5 font-mono text-[12px]">
                    Read post
                    <svg
                      [lucideIcon]="arrowIcon"
                      [size]="13"
                      class="transition-transform group-hover:translate-x-0.5"
                    ></svg>
                  </span>
                </div>
              </a>
            </li>
          }
        </ul>
      </section>
    </main>

    <app-site-footer />
  `,
})
export class BlogIndexPage {
  protected readonly posts = BLOG_POSTS;
  protected readonly arrowIcon = LucideArrowRight;
}
