import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  LucideArrowRight,
  LucideCheck,
  LucideCopy,
  LucideDatabase,
  LucideDynamicIcon,
  LucideListChecks,
  LucideMessagesSquare,
  LucideRefreshCw,
  LucideRuler,
  LucideSparkles,
  LucideSquareKanban,
  LucideTerminal,
  LucideTimer,
  LucideTriangle,
  type LucideIcon,
} from '@lucide/angular';
import { TramaLogo } from '../../shared/trama-logo';
import { LandingProductShot } from './landing-product-shot';
import { SiteCta } from './site-cta';
import { SiteFooter } from './site-footer';
import { SiteHeader } from './site-header';

interface Step {
  n: string;
  title: string;
  body: string;
  chip: string;
  tick: string;
  chipDot: string;
}

interface Feature {
  icon: LucideIcon;
  title: string;
  body: string;
}

interface TerminalLine {
  prompt: string;
  text: string;
  tone: string;
}

const COMMAND = '/trama TRM-128';

/** Public landing page at `/`, available to signed-out and signed-in visitors (v3 frame 32). */
@Component({
  selector: 'app-landing-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    LucideDynamicIcon,
    TramaLogo,
    LandingProductShot,
    SiteCta,
    SiteFooter,
    SiteHeader,
  ],
  host: { class: 'bg-background text-foreground block min-h-svh overflow-x-clip leading-normal' },
  template: `
    <app-site-header />

    <main>
      <!-- Hero -->
      <section
        class="mx-auto flex w-full max-w-[1440px] flex-col gap-12 px-5 pt-14 md:gap-16 md:px-10 md:pt-28 xl:px-[120px]"
      >
        <div class="flex flex-col justify-between gap-12 lg:flex-row lg:items-end lg:gap-20">
          <div class="flex flex-col items-start gap-7 lg:max-w-[760px]">
            <a
              routerLink="/"
              fragment="delta"
              class="bg-card border-border hover:bg-hover flex max-w-full items-center gap-2.5 border py-[5px] pr-2.5 pl-1.5 transition-colors"
            >
              <span
                class="bg-primary/20 text-primary px-1.5 py-px font-mono text-[10.5px] tracking-[1px]"
                >NEW</span
              >
              <span class="text-muted-foreground truncate font-mono text-[12px]"
                >Built for delta.dev: type /trama in any thread</span
              >
              <svg
                [lucideIcon]="arrowIcon"
                [size]="12"
                class="text-muted-foreground shrink-0"
              ></svg>
            </a>
            <h1
              class="font-title text-foreground text-[clamp(44px,6.1vw,88px)] leading-none tracking-[-0.023em]"
            >
              Plan in Trama.<br />Work in Delta.
            </h1>
            <p class="text-muted-foreground max-w-[640px] text-[18px] leading-[29px]">
              Trama is the task hub for teams that build with Delta. Every task links one Delta
              thread: the agent reads the task with /trama, does the work in Delta, and syncs back a
              record that stays forever. Summary, decisions, files, PR.
            </p>
            <div class="flex flex-wrap items-center gap-3 pt-2">
              <a
                routerLink="/register"
                class="bg-primary text-primary-foreground hover:bg-primary-strong inline-flex items-center gap-2.5 py-[11px] pr-2.5 pl-4 font-mono text-[14px] leading-normal whitespace-nowrap transition-colors"
              >
                Get started free
                <span class="bg-white/15 px-1.5 py-px text-[11px] leading-normal" aria-hidden="true"
                  >G</span
                >
              </a>
              <button
                type="button"
                class="bg-card border-border hover:bg-hover flex items-center gap-3 border py-[11px] pr-3 pl-4 font-mono text-[14px] leading-normal whitespace-nowrap transition-colors"
                aria-label="Copy the /trama command"
                (click)="copyCommand()"
              >
                <span class="text-faint" aria-hidden="true">›</span>
                <span class="text-foreground">{{ command }}</span>
                <svg
                  [lucideIcon]="copied() ? checkIcon : copyIcon"
                  [size]="14"
                  class="text-muted-foreground"
                ></svg>
              </button>
            </div>
          </div>
          <dl class="flex flex-col gap-3.5 pb-2 lg:w-[300px] lg:shrink-0">
            @for (row of meta; track row.k) {
              <div class="border-border flex flex-col gap-1 border-b pb-3.5">
                <dt class="text-faint font-mono text-[10.5px] tracking-[1.2px]">{{ row.k }}</dt>
                <dd class="text-foreground text-[14px]">{{ row.v }}</dd>
              </div>
            }
          </dl>
        </div>

        <app-landing-product-shot />
      </section>

      <!-- Sources -->
      <section class="border-border border-b">
        <div
          class="mx-auto flex w-full max-w-[1440px] flex-col justify-between gap-6 px-5 py-10 md:px-10 lg:flex-row lg:items-center lg:gap-10 xl:px-[120px]"
        >
          <p class="text-faint font-mono text-[11px] tracking-[1.2px]">
            ISSUES IN → WORK IN DELTA → RECORD IN TRAMA
          </p>
          <ul
            class="text-muted-foreground flex flex-wrap items-center gap-x-8 gap-y-3 text-[15px] xl:gap-x-12"
          >
            <li class="flex items-center gap-2">
              <svg
                width="15"
                height="15"
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
              GitHub
            </li>
            <li class="flex items-center gap-2">
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path
                  d="m22 13.29-3.33-10a.42.42 0 0 0-.14-.18.38.38 0 0 0-.22-.11.39.39 0 0 0-.23.07.42.42 0 0 0-.14.18l-2.26 6.67H8.32L6.1 3.26a.42.42 0 0 0-.1-.18.38.38 0 0 0-.26-.08.39.39 0 0 0-.23.07.42.42 0 0 0-.14.18L2 13.29a.74.74 0 0 0 .27.83L12 21l9.69-6.88a.71.71 0 0 0 .31-.83Z"
                />
              </svg>
              GitLab
            </li>
            <li class="flex items-center gap-2">
              <svg [lucideIcon]="kanbanIcon" [size]="15"></svg>
              Jira
            </li>
            <li class="text-foreground flex items-center gap-2">
              <svg [lucideIcon]="triangleIcon" [size]="15" class="text-primary"></svg>
              Delta
            </li>
            <li class="flex items-center gap-2">
              <svg [lucideIcon]="terminalIcon" [size]="15"></svg>
              /trama skill
            </li>
            <li class="flex items-center gap-2">
              <svg [lucideIcon]="databaseIcon" [size]="15"></svg>
              DeltaDB
            </li>
          </ul>
        </div>
      </section>

      <!-- 01 How it works -->
      <section id="how" class="scroll-mt-16">
        <div
          class="mx-auto flex w-full max-w-[1440px] flex-col gap-10 px-5 pt-16 pb-14 md:gap-14 md:px-10 md:pt-[120px] md:pb-28 xl:px-[120px]"
        >
          <div class="flex flex-col justify-between gap-6 lg:flex-row lg:items-end">
            <div class="flex flex-col gap-4">
              <div class="flex items-center gap-2.5 font-mono text-[12px]">
                <span class="text-primary">01</span>
                <span class="text-faint tracking-[1.2px]">HOW IT WORKS</span>
              </div>
              <h2
                class="font-title text-foreground text-[clamp(36px,3.6vw,52px)] leading-[1.077] tracking-[-0.019em]"
              >
                Trama plans it.<br />Delta builds it.
              </h2>
            </div>
            <p class="text-muted-foreground max-w-[380px] text-[16px] leading-[26px]">
              Trama never runs agents. That happens in Delta. Trama keeps the task, the status and
              the record of every thread that worked on it.
            </p>
          </div>
          <div class="grid gap-y-10 md:grid-cols-3">
            @for (step of steps; track step.n) {
              <article class="border-border flex flex-col items-start gap-3.5 border-t pt-7 pr-8">
                <div class="flex items-center gap-3">
                  <span class="size-2" [class]="step.tick"></span>
                  <span class="text-faint font-mono text-[12px]">{{ step.n }}</span>
                </div>
                <h3 class="font-title text-foreground text-[32px] leading-tight">
                  {{ step.title }}
                </h3>
                <p class="text-muted-foreground text-[15px] leading-6">{{ step.body }}</p>
                <span
                  class="bg-secondary text-muted-foreground flex items-center gap-1.5 px-2 py-[3px] font-mono text-[11px]"
                >
                  <span class="size-1.5" [class]="step.chipDot"></span>
                  {{ step.chip }}
                </span>
              </article>
            }
          </div>
        </div>
      </section>

      <!-- 02 Inside Delta -->
      <section id="delta" class="bg-card border-border scroll-mt-16 border-y">
        <div
          class="mx-auto flex w-full max-w-[1440px] flex-col gap-12 px-5 py-16 md:px-10 md:py-28 lg:flex-row lg:items-center lg:gap-20 xl:px-[120px]"
        >
          <div class="flex flex-col gap-5 lg:w-[440px] lg:shrink-0">
            <div class="flex items-center gap-2.5 font-mono text-[12px]">
              <span class="text-primary">02</span>
              <span class="text-faint tracking-[1.2px]">INSIDE DELTA</span>
            </div>
            <h2
              class="font-title text-foreground text-[clamp(32px,3.1vw,44px)] leading-[1.09] tracking-[-0.018em]"
            >
              Type /trama in any Delta thread.
            </h2>
            <p class="text-muted-foreground text-[16px] leading-[26px]">
              The /trama skill gives the Delta agent three verbs. It works over the CLI or MCP, on
              the same machine as Delta, with a project token. No extra app to run.
            </p>
            <ul class="flex flex-col gap-2.5 pt-2">
              @for (bullet of bullets; track bullet) {
                <li class="text-foreground flex items-center gap-2.5 text-[14px]">
                  <svg [lucideIcon]="checkIcon" [size]="14" class="text-primary shrink-0"></svg>
                  {{ bullet }}
                </li>
              }
            </ul>
          </div>
          <div class="bg-background border-border min-w-0 flex-1 border">
            <div class="border-border flex items-center gap-2 border-b px-3.5 py-2.5">
              <span class="bg-line size-[9px]"></span>
              <span class="bg-line size-[9px]"></span>
              <span class="bg-line size-[9px]"></span>
              <span class="text-faint truncate font-mono text-[11px]"
                >delta — thread th_d93f10</span
              >
            </div>
            <div
              class="flex flex-col gap-[9px] overflow-x-auto px-6 pt-[22px] pb-[26px] font-mono text-[13px]"
            >
              @for (line of terminal; track $index) {
                <div class="flex gap-3 whitespace-nowrap">
                  <span class="text-faint w-2 shrink-0">{{ line.prompt }}</span>
                  <span [class]="line.tone">{{ line.text || ' ' }}</span>
                </div>
              }
            </div>
          </div>
        </div>
      </section>

      <!-- 03 Where things live -->
      <section
        class="mx-auto flex w-full max-w-[1440px] flex-col gap-10 px-5 pt-16 md:gap-12 md:px-10 md:pt-28 xl:px-[120px]"
      >
        <div class="flex flex-col justify-between gap-6 lg:flex-row lg:items-end">
          <div class="flex flex-col gap-4">
            <div class="flex items-center gap-2.5 font-mono text-[12px]">
              <span class="text-primary">03</span>
              <span class="text-faint tracking-[1.2px]">WHERE THINGS LIVE</span>
            </div>
            <h2
              class="font-title text-foreground text-[clamp(32px,3.1vw,44px)] leading-[1.2] tracking-[-0.018em]"
            >
              Nothing copied twice.
            </h2>
          </div>
          <p class="text-muted-foreground max-w-[420px] text-[16px] leading-[26px]">
            Trama links to the transcript in Delta. It keeps only what helps the next person
            understand and continue the work.
          </p>
        </div>
        <div class="border-border grid border lg:grid-cols-[1fr_239px_1fr]">
          <div class="bg-card">
            <div class="border-border flex items-center gap-3 border-b px-5 py-5 md:px-7">
              <app-trama-logo [size]="28" />
              <div class="flex flex-col gap-0.5">
                <span class="font-title text-foreground text-[24px] leading-tight">Trama</span>
                <span class="text-faint font-mono text-[11px]">web + mobile</span>
              </div>
            </div>
            @for (item of tramaItems; track item) {
              <div class="border-border flex items-center gap-2.5 border-b px-5 py-3.5 md:px-7">
                <span class="bg-primary size-1.5 shrink-0"></span>
                <span class="text-foreground text-[14.5px]">{{ item }}</span>
              </div>
            }
          </div>
          <div
            class="border-border flex flex-col items-center justify-center gap-3.5 border-y p-6 lg:border-x lg:border-y-0"
          >
            <span class="text-primary font-mono text-[12px]">/trama skill</span>
            @for (verb of verbs; track verb.cmd) {
              <div
                class="bg-secondary flex w-full max-w-[320px] justify-between px-3 py-2 lg:max-w-none"
              >
                <span class="text-foreground font-mono text-[12px]">{{ verb.cmd }}</span>
                <span class="text-faint font-mono text-[11px]">{{ verb.to }}</span>
              </div>
            }
            <span class="text-faint font-mono text-[10.5px]">CLI or MCP · same machine</span>
          </div>
          <div>
            <div class="border-border flex items-center gap-3 border-b px-5 py-5 md:px-7">
              <span class="border-border flex size-7 items-center justify-center border">
                <svg [lucideIcon]="triangleIcon" [size]="13" class="text-foreground"></svg>
              </span>
              <div class="flex flex-col gap-0.5">
                <span class="font-title text-foreground text-[24px] leading-tight">Delta</span>
                <span class="text-faint font-mono text-[11px]">delta.dev · where work happens</span>
              </div>
            </div>
            @for (item of deltaItems; track item) {
              <div class="border-border flex items-center gap-2.5 border-b px-5 py-3.5 md:px-7">
                <span class="bg-faint size-1.5 shrink-0"></span>
                <span class="text-foreground text-[14.5px]">{{ item }}</span>
              </div>
            }
          </div>
        </div>
      </section>

      <!-- 04 Everything else -->
      <section
        class="mx-auto flex w-full max-w-[1440px] flex-col gap-10 px-5 py-16 md:gap-12 md:px-10 md:py-28 xl:px-[120px]"
      >
        <div class="flex flex-col gap-4">
          <div class="flex items-center gap-2.5 font-mono text-[12px]">
            <span class="text-primary">04</span>
            <span class="text-faint tracking-[1.2px]">EVERYTHING ELSE</span>
          </div>
          <h2
            class="font-title text-foreground text-[clamp(32px,3.1vw,44px)] leading-[1.2] tracking-[-0.018em]"
          >
            A tracker that stays out of the way.
          </h2>
        </div>
        <div class="grid sm:grid-cols-2 lg:grid-cols-3">
          @for (feature of features; track feature.title) {
            <article class="border-border flex flex-col gap-3 border-t py-7 pr-10">
              <svg [lucideIcon]="feature.icon" [size]="16" class="text-muted-foreground"></svg>
              <h3 class="text-foreground text-[17px] font-semibold">{{ feature.title }}</h3>
              <p class="text-muted-foreground text-[14.5px] leading-[23px]">{{ feature.body }}</p>
            </article>
          }
        </div>
      </section>

      <app-site-cta />
    </main>

    <app-site-footer />
  `,
})
export class LandingPage {
  protected readonly command = COMMAND;
  protected readonly copied = signal(false);

  protected readonly arrowIcon = LucideArrowRight;
  protected readonly checkIcon = LucideCheck;
  protected readonly copyIcon = LucideCopy;
  protected readonly kanbanIcon = LucideSquareKanban;
  protected readonly triangleIcon = LucideTriangle;
  protected readonly terminalIcon = LucideTerminal;
  protected readonly databaseIcon = LucideDatabase;

  protected readonly meta: readonly { k: string; v: string }[] = [
    { k: 'WORKS WITH', v: 'delta.dev · Claude Code · any MCP client' },
    { k: 'ISSUES FROM', v: 'GitHub · GitLab · Jira · REST' },
    { k: 'LICENSE', v: 'Source-available · PolyForm Shield' },
  ];

  protected readonly steps: readonly Step[] = [
    {
      n: '01',
      title: 'Plan in Trama',
      body: 'An issue from GitHub, GitLab or Jira syncs in as a task. Split it into subtasks, set priority, assignee and due date. People own the status.',
      chip: 'github · acme/web#412',
      tick: 'bg-faint',
      chipDot: 'bg-primary',
    },
    {
      n: '02',
      title: 'Work in Delta',
      body: 'Open a Delta thread and type /trama TRM-128. The agent reads the task, its subtasks and past decisions, then links its own thread.',
      chip: 'delta · th_d93f10',
      tick: 'bg-primary',
      chipDot: 'bg-primary',
    },
    {
      n: '03',
      title: 'Keep the record',
      body: 'After each step the agent runs trama sync: summary, decisions, events, files and PR. When you close the task, the summary and time go back to the issue.',
      chip: 'record · synced 2m ago',
      tick: 'bg-faint',
      chipDot: 'bg-delta-line',
    },
  ];

  protected readonly bullets: readonly string[] = [
    'trama show: task, subtasks and past decisions',
    'trama link: one thread per task, or a new subtask',
    'trama sync: a read-only record of what happened',
  ];

  protected readonly terminal: readonly TerminalLine[] = [
    { prompt: '›', text: '/trama TRM-128', tone: 'text-foreground' },
    {
      prompt: '',
      text: 'trama show → Rotate OAuth tokens before expiry · 2 subtasks',
      tone: 'text-muted-foreground',
    },
    {
      prompt: '',
      text: 'Past decision (TRM-97): rotate every 30 days, not 90',
      tone: 'text-primary',
    },
    {
      prompt: '',
      text: 'trama link th_d93f10 → linked to TRM-128',
      tone: 'text-muted-foreground',
    },
    { prompt: '', text: '', tone: 'text-faint' },
    { prompt: '›', text: 'trama sync', tone: 'text-foreground' },
    {
      prompt: '',
      text: '✓ Record synced · 3 decisions · 6 files · PR acme/web#431',
      tone: 'text-green',
    },
    { prompt: '', text: '✓ 1h 20m suggested from thread', tone: 'text-green' },
  ];

  protected readonly tramaItems: readonly string[] = [
    'Tasks, subtasks, status, assignees, due dates',
    'Two-way sync with GitHub, GitLab, Jira',
    'Thread records: summary, decisions, changes',
    'Ask across every record',
    'Time per task and subtask',
  ];

  protected readonly deltaItems: readonly string[] = [
    'Threads and agents',
    'Chat, run, review and merge code',
    'DeltaDB and the full transcript',
    'Subagents and parallel sessions',
    'Your repo, on your machine',
  ];

  protected readonly verbs: readonly { cmd: string; to: string }[] = [
    { cmd: 'trama show', to: '← context' },
    { cmd: 'trama link', to: '→ 1 thread' },
    { cmd: 'trama sync', to: '→ record' },
  ];

  protected readonly features: readonly Feature[] = [
    {
      icon: LucideListChecks,
      title: 'Tasks & subtasks',
      body: 'Keyboard-first list and board. C to create, / to search, ⌘K for everything.',
    },
    {
      icon: LucideMessagesSquare,
      title: 'Delta thread records',
      body: 'Summary, decisions, events, files and PR for every linked thread. Read-only, flagged when stale.',
    },
    {
      icon: LucideSparkles,
      title: 'Ask',
      body: 'Ask across every Delta thread record and save the answers that matter.',
    },
    {
      icon: LucideRefreshCw,
      title: 'Issue sync',
      body: 'Two-way with GitHub, GitLab and Jira. Close in Trama, and the summary posts back to the issue.',
    },
    {
      icon: LucideTimer,
      title: 'Time tracking',
      body: 'Start a timer from any row, or accept the time Trama suggests from the Delta thread.',
    },
    {
      icon: LucideRuler,
      title: 'Estimates',
      body: 'Points or hours, per project. Compare estimate to actual at a glance.',
    },
  ];

  protected copyCommand(): void {
    void navigator.clipboard?.writeText(COMMAND).then(
      () => {
        this.copied.set(true);
        setTimeout(() => this.copied.set(false), 1500);
      },
      () => undefined,
    );
  }
}
