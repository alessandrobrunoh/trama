import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideArrowRight, LucideDynamicIcon } from '@lucide/angular';
import { SiteFooter } from '../landing/site-footer';
import { SiteHeader } from '../landing/site-header';
import { BLOG_POSTS } from './blog-posts';

/** `/blog`: public list of posts, newest first. */
@Component({
  selector: 'app-blog-index-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, RouterLink, LucideDynamicIcon, SiteHeader, SiteFooter],
  host: {
    class: 'bg-background text-foreground relative isolate flex min-h-svh flex-col overflow-x-clip',
  },
  template: `
    <div
      aria-hidden="true"
      class="bg-primary/10 pointer-events-none absolute top-[-22rem] left-1/2 -z-10 h-[36rem] w-[60rem] max-w-[160vw] -translate-x-1/2 rounded-full blur-3xl"
    ></div>
    <app-site-header />

    <main class="mx-auto w-full max-w-3xl flex-1 px-4 pt-16 pb-24 sm:px-6 sm:pt-24">
      <p class="text-primary text-[13px] font-medium">Blog</p>
      <h1 class="mt-2 text-4xl font-semibold tracking-[-0.03em] sm:text-5xl">
        Notes from the loom
      </h1>
      <p class="text-muted-foreground mt-4 max-w-xl text-[15px] leading-relaxed">
        Product updates, ideas about how humans and coding agents work together, and honest
        comparisons with the tools you already use.
      </p>

      <ul class="border-border mt-12 flex flex-col border-t">
        @for (post of posts; track post.slug) {
          <li class="border-border border-b">
            <a [routerLink]="['/blog', post.slug]" class="group flex flex-col gap-2 py-7">
              <span class="text-muted-foreground flex items-center gap-2 text-xs">
                <span class="bg-primary/10 text-primary rounded-full px-2 py-0.5 font-medium">{{
                  post.tag
                }}</span>
                <time [attr.datetime]="post.date">{{ post.date | date: 'MMMM d, y' }}</time>
                <span aria-hidden="true">·</span>
                {{ post.readingMinutes }} min read
              </span>
              <h2
                class="group-hover:text-primary text-xl font-semibold tracking-tight transition-colors sm:text-2xl"
              >
                {{ post.title }}
              </h2>
              <p class="text-muted-foreground text-[14px] leading-relaxed">
                {{ post.description }}
              </p>
              <span
                class="text-primary mt-1 inline-flex items-center gap-1 text-[13px] font-medium"
              >
                Read post
                <svg
                  [lucideIcon]="arrowIcon"
                  [size]="14"
                  class="transition-transform group-hover:translate-x-0.5"
                ></svg>
              </span>
            </a>
          </li>
        }
      </ul>
    </main>

    <app-site-footer />
  `,
})
export class BlogIndexPage {
  protected readonly posts = BLOG_POSTS;
  protected readonly arrowIcon = LucideArrowRight;
}
