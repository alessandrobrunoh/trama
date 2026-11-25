import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { LucideArrowLeft, LucideDynamicIcon } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { TramaLogo } from '../../shared/trama-logo';
import { ComparisonTable } from '../landing/comparison-table';
import { SiteFooter } from '../landing/site-footer';
import { SiteHeader } from '../landing/site-header';
import { SiteWeave } from '../landing/site-weave';
import { BLOG_POSTS, findPost } from './blog-posts';

/** `/blog/:slug`: one post, editorial layout. Unknown slugs show a short not-found message. */
@Component({
  selector: 'app-blog-post-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    RouterLink,
    HlmButtonImports,
    LucideDynamicIcon,
    ComparisonTable,
    SiteHeader,
    SiteFooter,
    SiteWeave,
    TramaLogo,
  ],
  host: { class: 'bg-background text-foreground block min-h-svh overflow-x-clip leading-normal' },
  template: `
    <app-site-header />

    <main>
      @if (post(); as p) {
        <article (click)="followInternalLink($event)">
          <header
            class="mx-auto flex w-full max-w-[1440px] flex-col items-start gap-5 px-5 pt-10 pb-12 md:px-10 md:pt-16 md:pb-16 xl:px-[120px]"
          >
            <a
              routerLink="/blog"
              class="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 font-mono text-[12px]"
            >
              <svg [lucideIcon]="backIcon" [size]="13"></svg>
              All posts
            </a>
            <div class="mt-4 flex items-center gap-2.5">
              <span class="bg-primary size-2" aria-hidden="true"></span>
              <p class="text-faint font-mono text-[12px] tracking-[1.2px]">
                {{ p.tag.toUpperCase() }} ·
                <time [attr.datetime]="p.date">{{ p.date | date: 'MMM d, y' }}</time>
                · {{ p.readingMinutes }} MIN READ
              </p>
            </div>
            <h1
              class="font-title text-foreground max-w-[1000px] text-[clamp(38px,5.5vw,72px)] leading-[1.03] tracking-[-0.021em] text-balance"
            >
              {{ p.title }}
            </h1>
            <p class="text-muted-foreground max-w-[720px] text-[18px] leading-[29px] text-pretty">
              {{ p.description }}
            </p>
            @if (p.slug === 'introducing-trama') {
              <p
                class="bg-card border-border text-muted-foreground max-w-[720px] border px-3.5 py-2.5 font-mono text-[12px] leading-5"
              >
                Historical launch announcement (October 2026). This article describes Trama at
                launch; today, Tasks are granular units of work.
              </p>
            }
            <p class="text-faint flex items-center gap-2.5 font-mono text-[12px]">
              <app-trama-logo [size]="20" />
              The Trama team
            </p>
          </header>

          <app-site-weave />

          <div
            class="mx-auto w-full max-w-[1440px] px-5 pt-6 pb-16 md:px-10 md:pb-24 xl:px-[120px]"
          >
            <div class="max-w-[720px] text-[17px] leading-[1.75]">
              @for (block of p.blocks; track $index) {
                @switch (block.type) {
                  @case ('p') {
                    <p class="prose-inline text-text-2 mt-5" [innerHTML]="block.html"></p>
                  }
                  @case ('h2') {
                    <h2
                      [id]="block.id"
                      class="font-title text-foreground mt-14 scroll-mt-24 text-[32px] leading-[1.15] tracking-[-0.014em]"
                    >
                      {{ block.text }}
                    </h2>
                  }
                  @case ('list') {
                    <ul
                      class="text-text-2 marker:text-primary mt-5 flex list-square flex-col gap-2 pl-5"
                    >
                      @for (item of block.items; track $index) {
                        <li class="prose-inline pl-1" [innerHTML]="item"></li>
                      }
                    </ul>
                  }
                  @case ('quote') {
                    <blockquote
                      class="border-primary font-title text-foreground mt-10 border-l-2 pl-6 text-[28px] leading-[1.25] tracking-[-0.014em] text-balance"
                    >
                      {{ block.text }}
                    </blockquote>
                  }
                  @case ('code') {
                    <pre
                      class="bg-card border-border text-text-2 mt-6 overflow-x-auto border px-4 py-3.5 font-mono text-[13px] leading-relaxed"
                    ><code>{{ block.text }}</code></pre>
                  }
                  @case ('comparison') {
                    <app-comparison-table class="mt-6 text-[14px] leading-normal" />
                  }
                }
              }
            </div>
          </div>
        </article>

        <section class="bg-primary-soft border-border border-y">
          <div
            class="mx-auto flex w-full max-w-[1440px] flex-col items-start gap-5 px-5 py-14 md:px-10 md:py-[72px] xl:px-[120px]"
          >
            <h2
              class="font-title text-foreground text-[clamp(30px,4vw,44px)] leading-[1.1] tracking-[-0.014em]"
            >
              Try Trama with your team
            </h2>
            <p class="text-muted-foreground max-w-[520px] text-[16px] leading-[26px]">
              Create a workspace, start with a task, and invite an agent.
            </p>
            <div class="flex flex-wrap gap-3">
              <a
                routerLink="/register"
                class="bg-primary text-primary-foreground hover:bg-primary-strong inline-flex items-center gap-2.5 py-[11px] pr-2.5 pl-4 font-mono text-[14px] leading-normal whitespace-nowrap transition-colors"
              >
                Get started free
                <span class="bg-white/15 px-1.5 py-px text-[11px]" aria-hidden="true">G</span>
              </a>
              <a
                routerLink="/login"
                class="bg-secondary border-border text-foreground hover:bg-hover inline-flex border px-4 py-[11px] font-mono text-[14px] leading-normal whitespace-nowrap transition-colors"
                >Sign in</a
              >
            </div>
          </div>
        </section>

        @if (others().length) {
          <nav
            class="mx-auto w-full max-w-[1440px] px-5 py-14 md:px-10 md:py-20 xl:px-[120px]"
            aria-label="More posts"
          >
            <p class="text-faint font-mono text-[12px] tracking-[1.2px]">KEEP READING</p>
            <div class="mt-5 grid gap-x-8 sm:grid-cols-2">
              @for (o of others(); track o.slug) {
                <a
                  [routerLink]="['/blog', o.slug]"
                  class="group border-border hover:bg-card flex flex-col gap-2 border-t py-6 pr-6 transition-colors"
                >
                  <span
                    class="font-title text-foreground group-hover:text-primary text-[24px] leading-tight transition-colors"
                    >{{ o.title }}</span
                  >
                  <span class="text-muted-foreground text-[14px] leading-[22px]">{{
                    o.description
                  }}</span>
                </a>
              }
            </div>
          </nav>
        }
      } @else {
        <section
          class="mx-auto flex w-full max-w-[1440px] flex-col items-start gap-5 px-5 py-24 md:px-10 xl:px-[120px]"
        >
          <p class="text-faint font-mono text-[12px] tracking-[1.2px]">BLOG · 404</p>
          <h1 class="font-title text-foreground text-[clamp(38px,5vw,56px)] leading-none">
            Post not found
          </h1>
          <p class="text-muted-foreground text-[16px]">It may have moved, or the link is mistyped.</p>
          <a hlmBtn routerLink="/blog">Back to the blog</a>
        </section>
      }
    </main>

    <app-site-footer />
  `,
  styles: `
    .prose-inline ::ng-deep a {
      color: var(--primary);
      text-decoration: underline;
      text-underline-offset: 3px;
    }
    .prose-inline ::ng-deep code {
      font-family: var(--font-mono);
      font-size: 0.875em;
      padding: 0.1em 0.35em;
      background: var(--secondary);
    }
    .prose-inline ::ng-deep strong {
      font-weight: 600;
      color: var(--foreground);
    }
  `,
})
export class BlogPostPage {
  private readonly router = inject(Router);

  /** Route param `:slug`. */
  readonly slug = input<string>();

  protected readonly backIcon = LucideArrowLeft;
  protected readonly post = computed(() => findPost(this.slug()));
  protected readonly others = computed(() => BLOG_POSTS.filter((p) => p.slug !== this.slug()));

  /** Same-origin links inside post HTML navigate through the router instead of reloading. */
  protected followInternalLink(ev: MouseEvent): void {
    const a = (ev.target as HTMLElement).closest('a');
    const href = a?.getAttribute('href');
    if (!href?.startsWith('/') || href.startsWith('//') || ev.metaKey || ev.ctrlKey || ev.shiftKey)
      return;
    ev.preventDefault();
    void this.router.navigateByUrl(href);
  }
}
