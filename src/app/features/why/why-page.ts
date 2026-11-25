import { ChangeDetectionStrategy, Component } from '@angular/core';
import { SiteCta } from '../landing/site-cta';
import { SiteFooter } from '../landing/site-footer';
import { SiteHeader } from '../landing/site-header';

interface Need {
  n: string;
  text: string;
}

interface Difference {
  n: string;
  title: string;
  body: string;
  elsewhere: string;
}

/** Public "Why Trama" page at `/why` (v3 frame 38). */
@Component({
  selector: 'app-why-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SiteHeader, SiteFooter, SiteCta],
  host: { class: 'bg-background text-foreground block min-h-svh overflow-x-clip leading-normal' },
  template: `
    <app-site-header />

    <main>
      <!-- Hero -->
      <section
        class="mx-auto flex w-full max-w-[1440px] flex-col gap-5 px-5 pt-16 pb-12 md:px-10 md:pt-24 md:pb-16 xl:px-[120px]"
      >
        <div class="flex items-center gap-2.5">
          <span class="bg-primary size-2" aria-hidden="true"></span>
          <p class="text-faint font-mono text-[12px] tracking-[1.2px]">WHY TRAMA</p>
        </div>
        <h1
          class="font-title text-foreground max-w-[1100px] text-[clamp(40px,7vw,72px)] leading-[1.014] tracking-[-0.021em]"
        >
          Tasks describe problems.<br class="max-sm:hidden" />
          Agents work directly from Tasks.
        </h1>
        <p class="text-muted-foreground max-w-[720px] text-[18px] leading-[29px]">
          Trama keeps one problem per Task, without forcing a session that spans several Tasks into
          a second project-management object.
        </p>
      </section>

      <!-- The problem -->
      <section class="border-border border-t">
        <div
          class="mx-auto flex w-full max-w-[1440px] flex-col gap-10 px-5 py-14 md:px-10 md:py-20 lg:flex-row lg:gap-20 xl:px-[120px]"
        >
          <div class="flex flex-col gap-4 lg:w-[520px] lg:shrink-0">
            <p class="text-faint font-mono text-[12px] tracking-[1.2px]">THE PROBLEM</p>
            <h2
              class="font-title text-foreground text-[clamp(28px,4vw,38px)] leading-[1.16] tracking-[-0.013em]"
            >
              Issue trackers assume one ticket is one piece of work. It rarely is anymore.
            </h2>
          </div>
          <div class="flex min-w-0 flex-1 flex-col">
            <p class="text-muted-foreground text-[16px] leading-[26px]">
              Five bug reports share one root cause. One fix spans three repositories. Two
              developers and an agent work in the same context. Work with coding agents needs:
            </p>
            <ol class="mt-4">
              @for (need of needs; track need.n) {
                <li class="border-border flex gap-4 border-t py-3.5">
                  <span class="text-primary font-mono text-[12px]">{{ need.n }}</span>
                  <span class="text-foreground flex-1 text-[15px] leading-[23px]">{{
                    need.text
                  }}</span>
                </li>
              }
            </ol>
          </div>
        </div>
      </section>

      <!-- Quote -->
      <section class="bg-primary-soft border-border border-y">
        <div
          class="mx-auto flex w-full max-w-[1440px] flex-col gap-4 px-5 py-12 md:px-10 md:py-[72px] xl:px-[120px]"
        >
          <blockquote
            class="font-title text-foreground max-w-[1000px] text-[clamp(26px,3.6vw,44px)] leading-[1.16] tracking-[-0.014em]"
          >
            “A Task is the unit of work. A session can work across Tasks without a second status to
            maintain.”
          </blockquote>
          <p class="text-faint font-mono text-[11px] tracking-[1.2px]">FROM THE TRAMA README</p>
        </div>
      </section>

      <!-- Six things -->
      <section
        class="mx-auto flex w-full max-w-[1440px] flex-col gap-10 px-5 py-16 md:px-10 md:py-24 xl:px-[120px]"
      >
        <div class="flex flex-col justify-between gap-4 lg:flex-row lg:items-end lg:gap-10">
          <h2
            class="font-title text-foreground text-[clamp(30px,3.6vw,44px)] leading-[1.16] tracking-[-0.014em]"
          >
            Six things your issue tracker doesn't do.
          </h2>
          <p class="text-muted-foreground max-w-[400px] text-[15px] leading-6 lg:shrink-0">
            Everything you expect is still here: statuses, priorities, estimates, views, a timeline
            and a command palette.
          </p>
        </div>
        <div class="grid gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
          @for (item of differences; track item.n) {
            <article class="border-border flex flex-col gap-3 border-t py-6 pr-8">
              <span class="text-primary font-mono text-[12px]">{{ item.n }}</span>
              <h3 class="text-foreground text-[18px] font-semibold">{{ item.title }}</h3>
              <p class="text-muted-foreground text-[14.5px] leading-[23px]">{{ item.body }}</p>
              <p class="text-faint font-mono text-[11.5px] leading-[17px]">{{ item.elsewhere }}</p>
            </article>
          }
        </div>
      </section>

      <app-site-cta />
    </main>

    <app-site-footer />
  `,
})
export class WhyPage {
  protected readonly needs: readonly Need[] = [
    {
      n: '01',
      text: 'Granular Tasks that can be worked on together without duplicating their status.',
    },
    {
      n: '02',
      text: 'A coding agent that does a large part of the work, and delegates to subagents.',
    },
    {
      n: '03',
      text: 'Changes tied to a repository and a project, so the reviewer sees what was produced.',
    },
    {
      n: '04',
      text: 'The why behind a choice, which today lives in a chat thread nobody can find in a month.',
    },
  ];

  protected readonly differences: readonly Difference[] = [
    {
      n: '01',
      title: 'Tasks are the unit of work',
      body: 'Each task tracks one piece of work, with its own status, estimate, Delta thread and pull requests.',
      elsewhere: 'Elsewhere: tickets overloaded with requests, plans and discussion.',
    },
    {
      n: '02',
      title: 'Decisions that outlive the chat',
      body: 'Every Delta thread syncs a record: summary, decisions, events, files. Six months later, the why is one click away.',
      elsewhere: 'Elsewhere: buried in comments or a wiki page nobody finds.',
    },
    {
      n: '03',
      title: 'Artifacts with traceability',
      body: 'Pull requests and builds link to the task they address, with CI and review state.',
      elsewhere: 'Elsewhere: PR links scattered across tickets.',
    },
    {
      n: '04',
      title: 'Facts, not fake progress',
      body: 'Burn-up from tasks done, PRs merged and time tracked, not from how long a card sat in a column.',
      elsewhere: 'Elsewhere: story points and manual status updates.',
    },
    {
      n: '05',
      title: 'Contributors, not just assignees',
      body: 'People and agents both work on tasks. Accountability stays with a human.',
      elsewhere: 'Elsewhere: one assignee per ticket, human or bot.',
    },
    {
      n: '06',
      title: 'An inbox for what needs you',
      body: 'Blocked agents, reviews and stale records land in one place, so humans step in where it matters.',
      elsewhere: 'Elsewhere: a firehose of notifications for every field change.',
    },
  ];
}
