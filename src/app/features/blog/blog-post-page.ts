import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { LucideArrowLeft, LucideDynamicIcon } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { ComparisonTable } from '../landing/comparison-table';
import { SiteFooter } from '../landing/site-footer';
import { SiteHeader } from '../landing/site-header';
import { BLOG_POSTS, findPost } from './blog-posts';

/** `/blog/:slug`: one post. Unknown slugs show a short not-found message. */
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
  ],
  host: {
    class: 'bg-background text-foreground relative isolate flex min-h-svh flex-col overflow-x-clip',
  },
  template: `
    <div
      aria-hidden="true"
      class="bg-primary/10 pointer-events-none absolute top-[-24rem] left-1/2 -z-10 h-[36rem] w-[60rem] max-w-[160vw] -translate-x-1/2 rounded-full blur-3xl"
    ></div>
    <app-site-header />

    <main class="mx-auto w-full max-w-3xl flex-1 px-4 pt-12 pb-24 sm:px-6 sm:pt-16">
      <a
        routerLink="/blog"
        class="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-[13px]"
      >
        <svg [lucideIcon]="backIcon" [size]="14"></svg>
        All posts
      </a>

      @if (post(); as p) {
        <article (click)="followInternalLink($event)">
          <header class="mt-8">
            <p class="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
              <span class="bg-primary/10 text-primary rounded-full px-2 py-0.5 font-medium">{{
                p.tag
              }}</span>
              <time [attr.datetime]="p.date">{{ p.date | date: 'MMMM d, y' }}</time>
              <span aria-hidden="true">·</span>
              {{ p.readingMinutes }} min read
            </p>
            <h1
              class="mt-4 text-[clamp(2rem,5vw,2.75rem)] leading-[1.1] font-semibold tracking-[-0.03em] text-balance"
            >
              {{ p.title }}
            </h1>
            <p class="text-muted-foreground mt-4 text-[17px] leading-relaxed text-pretty">
              {{ p.description }}
            </p>
            <p class="text-muted-foreground mt-6 flex items-center gap-2 text-[13px]">
              <img src="/icons/trama-symbol-black.svg" alt="" class="size-5 dark:hidden" />
              <img src="/icons/trama-symbol-white.svg" alt="" class="hidden size-5 dark:block" />
              The Trama team
            </p>
          </header>

          <div class="border-border mt-10 border-t pt-4 text-[16px] leading-[1.75]">
            @for (block of p.blocks; track $index) {
              @switch (block.type) {
                @case ('p') {
                  <p class="prose-inline mt-5" [innerHTML]="block.html"></p>
                }
                @case ('h2') {
                  <h2
                    [id]="block.id"
                    class="mt-12 scroll-mt-20 text-2xl font-semibold tracking-[-0.02em]"
                  >
                    {{ block.text }}
                  </h2>
                }
                @case ('list') {
                  <ul class="mt-5 flex list-disc flex-col gap-2 pl-5 marker:text-muted-foreground">
                    @for (item of block.items; track $index) {
                      <li class="prose-inline pl-1" [innerHTML]="item"></li>
                    }
                  </ul>
                }
                @case ('quote') {
                  <blockquote
                    class="border-primary mt-8 border-l-2 pl-5 text-xl leading-snug font-medium tracking-tight text-balance"
                  >
                    {{ block.text }}
                  </blockquote>
                }
                @case ('code') {
                  <pre
                    class="border-border bg-muted mt-6 overflow-x-auto rounded-lg border px-4 py-3.5 font-mono text-[13px] leading-relaxed"
                  ><code>{{ block.text }}</code></pre>
                }
                @case ('comparison') {
                  <app-comparison-table class="mt-6 text-[14px] leading-normal" />
                }
              }
            }
          </div>
        </article>

        <aside class="border-border bg-card mt-16 rounded-2xl border p-6 text-center sm:p-8">
          <h2 class="text-xl font-semibold tracking-tight">Try Trama with your team</h2>
          <p class="text-muted-foreground mx-auto mt-2 max-w-md text-[14px]">
            Create a workspace, group your first issues into a workstream, and invite an agent.
          </p>
          <div class="mt-5 flex flex-wrap justify-center gap-2">
            <a hlmBtn routerLink="/register">Get started</a>
            <a hlmBtn variant="ghost" routerLink="/login">Sign in</a>
          </div>
        </aside>

        @if (others().length) {
          <nav class="mt-14" aria-label="More posts">
            <p class="text-muted-foreground text-[13px] font-medium">Keep reading</p>
            @for (o of others(); track o.slug) {
              <a
                [routerLink]="['/blog', o.slug]"
                class="group border-border mt-3 block rounded-xl border p-5 transition-colors hover:border-border-strong"
              >
                <span class="group-hover:text-primary font-medium transition-colors">{{
                  o.title
                }}</span>
                <span class="text-muted-foreground mt-1 block text-[13px] leading-relaxed">{{
                  o.description
                }}</span>
              </a>
            }
          </nav>
        }
      } @else {
        <div class="py-24 text-center">
          <h1 class="text-2xl font-semibold tracking-tight">Post not found</h1>
          <p class="text-muted-foreground mt-2 text-[14px]">
            It may have moved, or the link is mistyped.
          </p>
          <a hlmBtn class="mt-6" routerLink="/blog">Back to the blog</a>
        </div>
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
      border-radius: 4px;
      background: var(--muted);
    }
    .prose-inline ::ng-deep strong {
      font-weight: 600;
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
