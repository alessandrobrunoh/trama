import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  LucideArrowRight,
  LucideBot,
  LucideCircleCheck,
  LucideCircleDot,
  LucideDynamicIcon,
  LucideGitPullRequest,
  LucideHand,
  LucideKeyRound,
  LucideLightbulb,
  LucideMessageCircleQuestion,
  LucideUsers,
  LucideWaypoints,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { BLOG_POSTS } from '../blog/blog-posts';
import { ComparisonTable } from './comparison-table';
import { SiteFooter } from './site-footer';
import { SiteHeader } from './site-header';

/** Public landing page at `/`, available to signed-out and signed-in visitors. */
@Component({
  selector: 'app-landing-page',
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
  host: { class: 'bg-background text-foreground relative isolate block min-h-svh overflow-x-clip' },
  template: `
    <div
      aria-hidden="true"
      class="bg-primary/12 pointer-events-none absolute top-[-22rem] left-1/2 -z-10 h-[40rem] w-[64rem] max-w-[160vw] -translate-x-1/2 rounded-full blur-3xl"
    ></div>

    <app-site-header />

    <main>
      <!-- Hero -->
      <section class="mx-auto max-w-6xl px-4 pt-16 pb-12 text-center sm:px-6 sm:pt-24">
        <a
          [routerLink]="['/blog', 'introducing-trama']"
          class="border-border bg-card/70 text-muted-foreground hover:text-foreground mx-auto inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs transition-colors"
        >
          <span class="bg-primary size-1.5 rounded-full"></span>
          Introducing Trama · source-available, built for humans and coding agents
          <svg [lucideIcon]="arrowIcon" [size]="12"></svg>
        </a>
        <h1
          class="mx-auto mt-6 max-w-3xl text-[clamp(2.25rem,6vw,4rem)] leading-[1.05] font-semibold tracking-[-0.035em] text-balance"
        >
          Issues describe problems.
          <span class="text-muted-foreground">Workstreams deliver outcomes.</span>
        </h1>
        <p
          class="text-muted-foreground mx-auto mt-5 max-w-2xl text-[15px] leading-relaxed text-pretty sm:text-base"
        >
          Trello, Jira and Linear treat every ticket as a unit of work. Trama keeps your issues, and
          adds what they are missing: <span class="text-foreground">workstreams</span> that solve
          many issues at once, <span class="text-foreground">decisions</span> that explain why, and
          <span class="text-foreground">artifacts</span> that prove what shipped, with humans and
          coding agents working side by side.
        </p>
        <div class="mt-8 flex flex-wrap items-center justify-center gap-3">
          <a hlmBtn size="lg" routerLink="/register">
            Create your workspace
            <svg [lucideIcon]="arrowIcon" [size]="15"></svg>
          </a>
          <a hlmBtn size="lg" variant="outline" routerLink="/" fragment="compare"
            >Compare with Jira & Linear</a
          >
        </div>

        <!-- Product preview -->
        <div class="relative mx-auto mt-14 max-w-5xl text-left sm:mt-20">
          <div
            aria-hidden="true"
            class="bg-primary/15 absolute inset-x-10 -top-6 -z-10 h-40 rounded-full blur-3xl"
          ></div>
          <div
            class="border-border/80 bg-card overflow-hidden rounded-xl border shadow-[0_30px_80px_-30px_rgb(0_0_0/0.35)]"
            role="img"
            aria-label="Preview of a Trama workstream grouping three issues, with acceptance criteria, an agent pull request and a decision"
          >
            <div class="border-border/70 flex h-9 items-center gap-1.5 border-b px-3.5">
              <span class="bg-border-strong size-2.5 rounded-full"></span>
              <span class="bg-border-strong size-2.5 rounded-full"></span>
              <span class="bg-border-strong size-2.5 rounded-full"></span>
              <span class="text-muted-foreground ml-3 truncate font-mono text-[11px]"
                >trama / acme / workstreams / AUTH-12</span
              >
            </div>
            <div class="flex">
              <aside
                class="bg-sidebar border-sidebar-border hidden w-48 shrink-0 border-r p-2.5 text-[12.5px] md:block"
              >
                @for (item of sidebar; track item.label) {
                  <div
                    class="flex items-center justify-between rounded-md px-2 py-1.5"
                    [class.bg-sidebar-accent]="item.active"
                    [class.text-sidebar-accent-foreground]="item.active"
                    [class.text-sidebar-foreground]="!item.active"
                  >
                    {{ item.label }}
                    @if (item.count) {
                      <span class="text-muted-foreground text-[11px]">{{ item.count }}</span>
                    }
                  </div>
                }
              </aside>
              <div class="min-w-0 flex-1 p-4 sm:p-6">
                <div class="flex flex-wrap items-center gap-2 text-xs">
                  <span class="text-entity-workstream inline-flex items-center gap-1 font-medium">
                    <svg [lucideIcon]="workstreamIcon" [size]="13"></svg> AUTH-12
                  </span>
                  <span
                    class="bg-tone-blue/12 text-tone-blue rounded-full px-2 py-0.5 text-[11px] font-medium"
                    >Active</span
                  >
                  <span class="text-muted-foreground hidden sm:inline"
                    >· 2 of 3 issues done · 1 PR merged · CI passing</span
                  >
                </div>
                <h2 class="mt-2 text-lg font-semibold tracking-tight sm:text-xl">
                  Stabilize authentication before v2
                </h2>
                <p class="text-muted-foreground mt-1 text-[13px]">
                  Three reports, one root cause: refresh tokens are not rotated consistently.
                </p>

                <div class="mt-5 grid gap-5 lg:grid-cols-[1.25fr_1fr]">
                  <div class="flex flex-col gap-4">
                    <div>
                      <p
                        class="text-muted-foreground mb-2 text-[11px] font-medium tracking-wide uppercase"
                      >
                        Linked issues
                      </p>
                      <ul
                        class="border-border/70 divide-border/70 divide-y rounded-lg border text-[13px]"
                      >
                        @for (issue of issues; track issue.key) {
                          <li class="flex items-center gap-2.5 px-3 py-2">
                            <svg
                              [lucideIcon]="issue.done ? doneIcon : openIcon"
                              [size]="14"
                              [class]="
                                issue.done
                                  ? 'text-tone-green shrink-0'
                                  : 'text-muted-foreground shrink-0'
                              "
                            ></svg>
                            <span
                              class="text-muted-foreground w-16 shrink-0 font-mono text-[11px]"
                              >{{ issue.key }}</span
                            >
                            <span class="truncate">{{ issue.title }}</span>
                          </li>
                        }
                      </ul>
                    </div>
                    <div>
                      <p
                        class="text-muted-foreground mb-2 text-[11px] font-medium tracking-wide uppercase"
                      >
                        Acceptance criteria
                      </p>
                      <ul class="flex flex-col gap-1.5 text-[13px]">
                        <li class="flex items-center gap-2">
                          <svg
                            [lucideIcon]="doneIcon"
                            [size]="14"
                            class="text-tone-green shrink-0"
                          ></svg>
                          No session loss during token rotation
                        </li>
                        <li class="flex items-center gap-2">
                          <svg
                            [lucideIcon]="openIcon"
                            [size]="14"
                            class="text-muted-foreground shrink-0"
                          ></svg>
                          OAuth login passes on Safari 18
                        </li>
                      </ul>
                    </div>
                  </div>
                  <div>
                    <p
                      class="text-muted-foreground mb-2 text-[11px] font-medium tracking-wide uppercase"
                    >
                      Activity
                    </p>
                    <ul class="flex flex-col gap-3 text-[12.5px]">
                      <li class="flex items-start gap-2">
                        <span
                          class="bg-primary/12 text-primary mt-px flex size-5 shrink-0 items-center justify-center rounded-full"
                        >
                          <svg [lucideIcon]="botIcon" [size]="12"></svg>
                        </span>
                        <span
                          ><b class="font-medium">claude-code</b
                          ><span class="text-muted-foreground"> opened </span>PR #318 · rotate
                          refresh tokens</span
                        >
                      </li>
                      <li class="flex items-start gap-2">
                        <span
                          class="bg-entity-decision/12 text-entity-decision mt-px flex size-5 shrink-0 items-center justify-center rounded-full"
                        >
                          <svg [lucideIcon]="decisionIcon" [size]="12"></svg>
                        </span>
                        <span
                          ><b class="font-medium">Marta</b
                          ><span class="text-muted-foreground"> accepted </span>DEC-7 · keep the old
                          token valid for 30s</span
                        >
                      </li>
                      <li class="flex items-start gap-2">
                        <span
                          class="bg-tone-amber/12 text-tone-amber mt-px flex size-5 shrink-0 items-center justify-center rounded-full"
                        >
                          <svg [lucideIcon]="questionIcon" [size]="12"></svg>
                        </span>
                        <span
                          ><b class="font-medium">codex</b
                          ><span class="text-muted-foreground"> asked </span>Drop support for Safari
                          16?</span
                        >
                      </li>
                      <li class="flex items-start gap-2">
                        <span
                          class="bg-tone-green/12 text-tone-green mt-px flex size-5 shrink-0 items-center justify-center rounded-full"
                        >
                          <svg [lucideIcon]="prIcon" [size]="12"></svg>
                        </span>
                        <span
                          ><b class="font-medium">PR #311</b
                          ><span class="text-muted-foreground"> merged · fixes </span>BUG-142,
                          BUG-153</span
                        >
                      </li>
                    </ul>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- The problem -->
      <section class="mx-auto max-w-6xl px-4 py-20 sm:px-6">
        <div class="max-w-2xl">
          <p class="text-primary text-[13px] font-medium">The problem</p>
          <h2 class="mt-2 text-3xl font-semibold tracking-[-0.025em] text-balance sm:text-4xl">
            Issue trackers assume one ticket is one piece of work. It rarely is anymore.
          </h2>
          <p class="text-muted-foreground mt-4 text-[15px] leading-relaxed">
            Five bug reports share one root cause. One fix spans three repositories. Two developers
            and an agent work in the same context. The ticket can't hold all of that, so the real
            story ends up scattered across comments, chats and pull requests.
          </p>
        </div>
        <div class="mt-12 grid gap-4 lg:grid-cols-2">
          <div class="border-border bg-card/60 rounded-xl border p-6">
            <p class="text-muted-foreground text-[13px] font-medium">Trello, Jira, Linear</p>
            <ol class="mt-5 flex flex-wrap items-center gap-2 font-mono text-[12px]">
              @for (s of ticketFlow; track s; let last = $last) {
                <li class="border-border bg-background rounded-md border px-2.5 py-1.5">{{ s }}</li>
                @if (!last) {
                  <li aria-hidden="true" class="text-muted-foreground">→</li>
                }
              }
            </ol>
            <p class="text-muted-foreground mt-5 text-[13px] leading-relaxed">
              The ticket is the request, the plan, the discussion and the status all at once. Agents
              become just another assignee, one ticket at a time.
            </p>
          </div>
          <div class="border-primary/30 bg-primary/5 rounded-xl border p-6">
            <p class="text-primary text-[13px] font-medium">Trama</p>
            <ol class="mt-5 flex flex-wrap items-center gap-2 font-mono text-[12px]">
              @for (s of tramaFlow; track s; let last = $last) {
                <li class="border-primary/25 bg-background rounded-md border px-2.5 py-1.5">
                  {{ s }}
                </li>
                @if (!last) {
                  <li aria-hidden="true" class="text-primary/60">→</li>
                }
              }
            </ol>
            <p class="text-muted-foreground mt-5 text-[13px] leading-relaxed">
              Demand and execution are separate. The workstream links the shared workspace where
              people and agents work, and keeps the decisions and artifacts attached to the outcome.
            </p>
          </div>
        </div>
      </section>

      <!-- Why Trama -->
      <section id="why" class="mx-auto max-w-6xl scroll-mt-20 px-4 py-20 sm:px-6">
        <div class="max-w-2xl">
          <p class="text-primary text-[13px] font-medium">Why Trama</p>
          <h2 class="mt-2 text-3xl font-semibold tracking-[-0.025em] text-balance sm:text-4xl">
            Six things your issue tracker doesn't do.
          </h2>
          <p class="text-muted-foreground mt-4 text-[15px] leading-relaxed">
            Everything you expect is still here: issues, statuses, priorities, estimates, teams,
            views, a timeline and a command palette. This is what's new.
          </p>
        </div>
        <div class="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          @for (d of differentiators; track d.title) {
            <article
              class="border-border/80 bg-card/60 hover:border-border-strong flex flex-col rounded-xl border p-5 transition-colors"
            >
              <span class="flex size-8 items-center justify-center rounded-lg" [class]="d.tint">
                <svg [lucideIcon]="d.icon" [size]="16"></svg>
              </span>
              <h3 class="mt-4 font-medium">{{ d.title }}</h3>
              <p class="text-muted-foreground mt-1.5 text-[13px] leading-relaxed">{{ d.body }}</p>
              <p
                class="text-muted-foreground/80 border-border/60 mt-4 border-t pt-3 text-[12px] leading-relaxed"
              >
                <span class="text-foreground/80 font-medium">Elsewhere:</span> {{ d.elsewhere }}
              </p>
            </article>
          }
        </div>
      </section>

      <!-- Compare -->
      <section id="compare" class="mx-auto max-w-6xl scroll-mt-20 px-4 py-20 sm:px-6">
        <div class="flex flex-wrap items-end justify-between gap-6">
          <div class="max-w-2xl">
            <p class="text-primary text-[13px] font-medium">Compare</p>
            <h2 class="mt-2 text-3xl font-semibold tracking-[-0.025em] text-balance sm:text-4xl">
              Trama, next to the tools you know.
            </h2>
            <p class="text-muted-foreground mt-4 text-[15px] leading-relaxed">
              Trello, Jira and Linear are great at tracking tickets. Trama is built for coordinating
              outcomes.
            </p>
          </div>
          <a hlmBtn variant="outline" [routerLink]="['/blog', 'trama-vs-trello-jira-linear']">
            Read the full comparison
            <svg [lucideIcon]="arrowIcon" [size]="15"></svg>
          </a>
        </div>
        <app-comparison-table class="mt-10" />
      </section>

      <!-- Agents -->
      <section id="agents" class="mx-auto max-w-6xl scroll-mt-20 px-4 py-20 sm:px-6">
        <div
          class="border-border bg-card grid items-center gap-10 rounded-2xl border p-6 sm:p-10 lg:grid-cols-2"
        >
          <div>
            <p class="text-primary text-[13px] font-medium">Agents</p>
            <h2 class="mt-2 text-3xl font-semibold tracking-[-0.025em] text-balance">
              Give agents a seat at the table, not the keys to everything.
            </h2>
            <p class="text-muted-foreground mt-4 text-[15px] leading-relaxed">
              Claude Code, Codex, Cursor or your own agents connect through the MCP server and the
              API. They join workstreams as contributors, attach artifacts, and ask a human when
              they're blocked.
            </p>
            <ul class="mt-5 flex flex-col gap-2 text-[14px]">
              @for (point of agentPoints; track point) {
                <li class="flex items-start gap-2">
                  <svg
                    [lucideIcon]="doneIcon"
                    [size]="16"
                    class="text-primary mt-0.5 shrink-0"
                  ></svg>
                  {{ point }}
                </li>
              }
            </ul>
            <a hlmBtn class="mt-7" routerLink="/register">
              Connect your first agent
              <svg [lucideIcon]="arrowIcon" [size]="15"></svg>
            </a>
          </div>
          <div
            class="border-border/80 bg-background overflow-x-auto rounded-xl border font-mono text-[12px]"
          >
            <div
              class="border-border/70 text-muted-foreground flex items-center gap-2 border-b px-4 py-2.5"
            >
              <svg [lucideIcon]="keyIcon" [size]="13"></svg>
              api-token · ci-agent
            </div>
            <table class="w-full">
              <thead class="text-muted-foreground text-left text-[11px]">
                <tr>
                  <th class="px-4 py-2 font-normal">resource</th>
                  <th class="px-2 py-2 font-normal">read</th>
                  <th class="px-2 py-2 font-normal">write</th>
                  <th class="px-2 py-2 font-normal">delete</th>
                </tr>
              </thead>
              <tbody>
                @for (row of permissions; track row.resource) {
                  <tr class="border-border/60 border-t">
                    <td class="px-4 py-2">{{ row.resource }}</td>
                    @for (allowed of row.actions; track $index) {
                      <td
                        class="px-2 py-2"
                        [class]="allowed ? 'text-tone-green' : 'text-muted-foreground/50'"
                      >
                        {{ allowed ? '✓' : '—' }}
                      </td>
                    }
                  </tr>
                }
              </tbody>
            </table>
            <div class="border-border/70 text-muted-foreground border-t px-4 py-2.5">
              limit · 500 requests / day
            </div>
          </div>
        </div>
      </section>

      <!-- Source-available -->
      <section class="mx-auto max-w-6xl px-4 py-20 sm:px-6">
        <div class="grid gap-10 lg:grid-cols-[1fr_1.1fr] lg:items-center">
          <div>
            <p class="text-primary text-[13px] font-medium">Source-available</p>
            <h2 class="mt-2 text-3xl font-semibold tracking-[-0.025em] text-balance sm:text-4xl">
              Your work, on your infrastructure.
            </h2>
            <p class="text-muted-foreground mt-4 text-[15px] leading-relaxed">
              Trama is source-available under PolyForm Shield and self-hostable. A web app, an API
              and PostgreSQL: no infrastructure zoo, no feature held hostage. The self-hosted
              edition is the real product.
            </p>
          </div>
          <dl
            class="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border"
          >
            @for (fact of facts; track fact.label) {
              <div class="bg-card p-5">
                <dt class="text-muted-foreground text-[12px]">{{ fact.label }}</dt>
                <dd class="mt-1 text-lg font-semibold tracking-tight">{{ fact.value }}</dd>
              </div>
            }
          </dl>
        </div>
      </section>

      <!-- Blog -->
      <section class="mx-auto max-w-6xl px-4 py-20 sm:px-6">
        <div class="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p class="text-primary text-[13px] font-medium">From the blog</p>
            <h2 class="mt-2 text-3xl font-semibold tracking-[-0.025em]">
              Read more about the idea
            </h2>
          </div>
          <a
            routerLink="/blog"
            class="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-[13px]"
          >
            All posts <svg [lucideIcon]="arrowIcon" [size]="14"></svg>
          </a>
        </div>
        <div class="mt-10 grid gap-4 md:grid-cols-2">
          @for (post of posts; track post.slug) {
            <a
              [routerLink]="['/blog', post.slug]"
              class="group border-border/80 bg-card/60 hover:border-border-strong flex flex-col rounded-xl border p-6 transition-colors"
            >
              <span class="text-muted-foreground flex items-center gap-2 text-xs">
                <span class="bg-primary/10 text-primary rounded-full px-2 py-0.5 font-medium">{{
                  post.tag
                }}</span>
                {{ post.date | date: 'MMM d, y' }}
              </span>
              <h3
                class="group-hover:text-primary mt-4 text-lg font-semibold tracking-tight transition-colors"
              >
                {{ post.title }}
              </h3>
              <p class="text-muted-foreground mt-2 text-[13px] leading-relaxed">
                {{ post.description }}
              </p>
            </a>
          }
        </div>
      </section>

      <!-- CTA -->
      <section class="mx-auto max-w-6xl px-4 pt-8 pb-24 text-center sm:px-6">
        <img src="/icons/trama-symbol-black.svg" alt="" class="mx-auto size-12 dark:hidden" />
        <img src="/icons/trama-symbol-white.svg" alt="" class="mx-auto hidden size-12 dark:block" />
        <h2
          class="mx-auto mt-6 max-w-xl text-3xl font-semibold tracking-[-0.025em] text-balance sm:text-4xl"
        >
          Weave your team's work together.
        </h2>
        <p class="text-muted-foreground mx-auto mt-3 max-w-md text-[15px]">
          Create a workspace in under a minute. Start with one issue and one workstream.
        </p>
        <div class="mt-8 flex flex-wrap items-center justify-center gap-3">
          <a hlmBtn size="lg" routerLink="/register">Get started</a>
          <a hlmBtn size="lg" variant="ghost" routerLink="/login">I already have an account</a>
        </div>
      </section>
    </main>

    <app-site-footer />
  `,
})
export class LandingPage {
  protected readonly arrowIcon = LucideArrowRight;
  protected readonly workstreamIcon = LucideWaypoints;
  protected readonly decisionIcon = LucideLightbulb;
  protected readonly botIcon = LucideBot;
  protected readonly prIcon = LucideGitPullRequest;
  protected readonly keyIcon = LucideKeyRound;
  protected readonly questionIcon = LucideMessageCircleQuestion;
  protected readonly openIcon = LucideCircleDot;
  protected readonly doneIcon = LucideCircleCheck;

  protected readonly posts = BLOG_POSTS;

  protected readonly sidebar = [
    { label: 'Overview', count: 0, active: false },
    { label: 'My Attention', count: 3, active: false },
    { label: 'Issues', count: 42, active: false },
    { label: 'Workstreams', count: 6, active: true },
    { label: 'Decisions', count: 9, active: false },
    { label: 'Graph', count: 0, active: false },
    { label: 'Timeline', count: 0, active: false },
  ];

  protected readonly issues = [
    { key: 'BUG-142', title: 'Session expires unexpectedly', done: true },
    { key: 'BUG-148', title: 'OAuth callback loops on Safari', done: false },
    { key: 'BUG-153', title: 'Logout leaves a stale authentication cookie', done: true },
  ];

  protected readonly ticketFlow = ['Issue', 'Assignee', 'Branch', 'PR', 'Done'];
  protected readonly tramaFlow = [
    'Issues',
    'Workstream',
    'Shared workspace',
    'Artifacts',
    'Outcome',
  ];

  protected readonly differentiators = [
    {
      icon: LucideWaypoints,
      tint: 'bg-entity-workstream/12 text-entity-workstream',
      title: 'Many issues, one workstream',
      body: 'Group the reports that share a root cause into one outcome, with an objective, acceptance criteria and its own lifecycle. Issue status and outcome status move independently.',
      elsewhere: 'epics and projects group scope or timelines, not causes.',
    },
    {
      icon: LucideLightbulb,
      tint: 'bg-entity-decision/12 text-entity-decision',
      title: 'Decisions that outlive the chat',
      body: 'Durable choices become decisions: proposed, accepted or superseded, linked to the work they shaped. Six months later, the why is one click away.',
      elsewhere: 'buried in comments or a wiki page nobody finds.',
    },
    {
      icon: LucideGitPullRequest,
      tint: 'bg-tone-green/12 text-tone-green',
      title: 'Artifacts with traceability',
      body: 'Pull requests, docs and releases attach to the workstream with CI and review state, traced back to the issues they fixed. Why does this PR exist? Now you know.',
      elsewhere: 'PR links scattered across individual tickets.',
    },
    {
      icon: LucideCircleCheck,
      tint: 'bg-tone-blue/12 text-tone-blue',
      title: 'Facts, not fake progress',
      body: 'Status is derived from what actually happened: issues resolved, PRs merged, criteria met. No percentages someone typed to look busy.',
      elsewhere: 'story points, burndowns and manual status updates.',
    },
    {
      icon: LucideUsers,
      tint: 'bg-primary/12 text-primary',
      title: 'Contributors, not just assignees',
      body: 'One accountable owner, several contributors and participating teams. Agents sit next to people on the same workstream and share the same context.',
      elsewhere: 'one assignee per ticket, human or bot.',
    },
    {
      icon: LucideHand,
      tint: 'bg-tone-amber/12 text-tone-amber',
      title: 'An inbox for what needs you',
      body: 'When an agent is blocked it opens an input request. My Attention collects those, reviews and stale work, so humans step in exactly where it matters.',
      elsewhere: 'a firehose of notifications for every field change.',
    },
  ];

  protected readonly agentPoints = [
    'Scoped tokens: permissions per resource and action, never all-or-nothing',
    'Usage caps per token, so a runaway loop stays a small problem',
    'Input requests route questions to the right human',
    'Works without AI too: agent-native, not agent-dependent',
  ];

  protected readonly permissions = [
    { resource: 'issues', actions: [true, true, false] },
    { resource: 'workstreams', actions: [true, true, false] },
    { resource: 'decisions', actions: [true, false, false] },
    { resource: 'members', actions: [false, false, false] },
  ];

  protected readonly facts = [
    { label: 'License', value: 'PolyForm Shield' },
    { label: 'Database', value: 'PostgreSQL' },
    { label: 'Agent protocol', value: 'MCP + REST' },
    { label: 'Vendor lock-in', value: 'None' },
  ];
}
