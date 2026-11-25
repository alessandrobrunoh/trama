import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideArrowRight, LucideCheck, LucideDynamicIcon } from '@lucide/angular';
import { TramaLogo } from '../../shared/trama-logo';
import { SITE_WRAP, SiteHero } from '../../shared/site-hero';
import { SiteFooter } from '../landing/site-footer';
import { SiteHeader } from '../landing/site-header';

interface CompareRow {
  label: string;
  trello: string;
  jira: string;
  linear: string;
  trama: string;
}

interface FlowStep {
  label: string;
  /** Steps that happen in Trama or Delta are tinted with the accent. */
  accent?: boolean;
}

interface Flow {
  who: string;
  /** Trama's own row is set in the title face. */
  own?: boolean;
  steps: FlowStep[];
  note: string;
}

/** `/compare`: Trama next to Trello, Jira and Linear (v3 frame 37). Copy is the frame's own. */
@Component({
  selector: 'app-compare-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, LucideDynamicIcon, SiteHero, SiteHeader, SiteFooter, TramaLogo],
  host: { class: 'bg-background text-foreground flex min-h-svh flex-col overflow-x-clip' },
  template: `
    <app-site-header />

    <main class="flex-1">
      <app-site-hero
        eyebrow="Compare"
        title="Trama, next to the tools you know."
        lede="Trello, Jira and Linear are great at tracking tickets. Trama is built for coordinating outcomes, between people and the agents that do the work in Delta."
        [bordered]="false"
        [tall]="true"
      />

      <div [class]="wrap" class="pb-16 sm:pb-24">
        <div class="border-border border" role="table" aria-label="Trama compared with Trello, Jira and Linear">
          <div
            class="border-border hidden border-b md:grid md:grid-cols-[240px_repeat(4,minmax(0,1fr))]"
            role="row"
          >
            <div role="presentation"></div>
            @for (tool of tools; track tool) {
              <div
                class="border-border text-muted-foreground flex items-center border-l px-5 py-[18px] text-[15px] leading-none font-medium"
                role="columnheader"
              >
                {{ tool }}
              </div>
            }
            <div
              class="bg-primary-soft border-primary -mt-px flex items-center gap-2.5 border-t-2 border-l px-5 py-[18px]"
              role="columnheader"
            >
              <app-trama-logo [size]="20" />
              <span class="font-title text-foreground text-xl leading-none">Trama</span>
            </div>
          </div>

          @for (row of rows; track row.label; let last = $last) {
            <div
              class="border-border md:grid md:grid-cols-[240px_repeat(4,minmax(0,1fr))]"
              [class.border-b]="!last"
              role="row"
            >
              <div
                class="text-faint px-4 pt-4 pb-1 font-mono text-xs leading-[1.2] md:px-5 md:py-[18px]"
                role="rowheader"
              >
                {{ row.label }}
              </div>
              <div [class]="cell" role="cell">
                <span [class]="toolTag">Trello</span>
                <span class="text-muted-foreground text-sm leading-[21px]">{{ row.trello }}</span>
              </div>
              <div [class]="cell" role="cell">
                <span [class]="toolTag">Jira</span>
                <span class="text-muted-foreground text-sm leading-[21px]">{{ row.jira }}</span>
              </div>
              <div [class]="cell" role="cell">
                <span [class]="toolTag">Linear</span>
                <span class="text-muted-foreground text-sm leading-[21px]">{{ row.linear }}</span>
              </div>
              <div
                class="bg-primary-soft border-primary flex flex-col gap-1 border-l px-4 py-3 md:px-5 md:py-[18px]"
                role="cell"
              >
                <span [class]="toolTag">Trama</span>
                <span class="flex items-start gap-2.5">
                  <svg
                    [lucideIcon]="checkIcon"
                    [size]="12"
                    class="text-primary mt-[5px] shrink-0"
                    aria-hidden="true"
                  ></svg>
                  <span class="text-foreground min-w-0 text-sm leading-[21px]">{{ row.trama }}</span>
                </span>
              </div>
            </div>
          }
        </div>
      </div>

      <section class="bg-card border-border border-y">
        <div [class]="wrap" class="flex flex-col gap-5 py-16 sm:py-24">
          <h2
            class="font-title text-foreground text-[32px] leading-[1.15] tracking-[-0.6px] sm:text-[40px]"
          >
            Where the work actually goes
          </h2>
          <div class="flex flex-col">
            @for (flow of flows; track flow.who) {
              <div
                class="border-border flex flex-col gap-4 border-t py-6 md:flex-row md:items-center md:gap-10"
              >
                <span
                  class="md:w-[200px] md:shrink-0"
                  [class]="
                    flow.own
                      ? 'font-title text-foreground text-[22px] leading-none'
                      : 'text-muted-foreground text-base leading-none'
                  "
                  >{{ flow.who }}</span
                >
                <ol class="flex flex-wrap items-center gap-2.5">
                  @for (step of flow.steps; track $index; let first = $first) {
                    @if (!first) {
                      <li aria-hidden="true" class="flex">
                        <svg [lucideIcon]="arrowIcon" [size]="12" class="text-faint"></svg>
                      </li>
                    }
                    <li
                      class="border px-3 py-1.5 font-mono text-[12.5px] leading-none"
                      [class]="
                        step.accent
                          ? 'bg-primary/20 border-primary/40 text-primary'
                          : 'bg-secondary border-border text-foreground'
                      "
                    >
                      {{ step.label }}
                    </li>
                  }
                </ol>
                <p class="text-muted-foreground min-w-0 flex-1 text-sm leading-[22px]">
                  {{ flow.note }}
                </p>
              </div>
            }
          </div>
        </div>
      </section>

      <section class="bg-primary-soft border-border border-t">
        <div
          class="mx-auto flex max-w-[1200px] flex-col items-center gap-8 px-4 py-20 text-center sm:px-8 sm:py-[120px]"
        >
          <h2
            class="font-title text-foreground text-[56px] leading-none tracking-[-1.5px] sm:text-[80px] lg:text-[96px] lg:tracking-[-2.5px]"
          >
            Pull the thread.
          </h2>
          <p class="text-muted-foreground text-base sm:text-lg">
            Free for small teams. Works with delta.dev out of the box.
          </p>
          <div class="flex flex-wrap items-center justify-center gap-3">
            <a
              routerLink="/register"
              class="bg-primary text-primary-foreground flex items-center gap-2.5 py-[11px] pr-2.5 pl-4 font-mono text-sm leading-none"
            >
              Get started free
              <span class="bg-white/15 px-1.5 py-px text-[11px] leading-[15px]">G</span>
            </a>
            <a
              [href]="docsUrl"
              class="bg-secondary border-border text-foreground border px-4 py-[11px] font-mono text-sm leading-none"
            >
              Read the docs
            </a>
          </div>
        </div>
      </section>
    </main>

    <app-site-footer />
  `,
})
export class ComparePage {
  protected readonly wrap = SITE_WRAP;
  protected readonly checkIcon = LucideCheck;
  protected readonly arrowIcon = LucideArrowRight;
  protected readonly docsUrl = 'https://github.com/alessandrobrunoh/trama#readme';

  /** Stacked layout below `md`: every cell names its tool, the header row is hidden. */
  protected readonly cell =
    'border-border flex flex-col gap-1 px-4 py-3 md:border-l md:px-5 md:py-[18px]';
  protected readonly toolTag = 'text-faint font-mono text-[10.5px] leading-none uppercase md:hidden';

  protected readonly tools: readonly string[] = ['Trello', 'Jira', 'Linear'];

  protected readonly rows: readonly CompareRow[] = [
    {
      label: 'Unit of work',
      trello: 'A card on a board',
      jira: 'An issue in an epic → story → sub-task tree',
      linear: 'An issue, grouped into projects and cycles',
      trama: 'Tasks are the unit of work, each linked to one Delta thread',
    },
    {
      label: 'Many issues, one fix',
      trello: 'Labels or a dedicated list',
      jira: 'Epics and issue links',
      linear: 'Projects and issue relations',
      trama: 'Related tasks stay linked and grouped under a project',
    },
    {
      label: 'Why it was done this way',
      trello: 'Card comments',
      jira: 'Comments, or a page in Confluence',
      linear: 'Comments and project docs',
      trama: 'Thread records keep the decisions from Delta, forever',
    },
    {
      label: 'What was delivered',
      trello: 'Power-Ups',
      jira: 'Development panel per issue',
      linear: 'Linked pull requests per issue',
      trama: 'PRs and builds linked to the task, with CI and review state',
    },
    {
      label: 'Progress',
      trello: 'Where the card sits',
      jira: 'Story points and burndown',
      linear: 'Cycle and project progress',
      trama: 'Burn-up from facts: tasks done, PRs merged, time tracked',
    },
    {
      label: 'Coding agents',
      trello: 'Third-party automations',
      jira: 'An assignee on a ticket',
      linear: 'An assignee on a ticket',
      trama: 'Agents read the task with /trama and sync back what they did',
    },
    {
      label: 'Source & self-hosting',
      trello: 'No',
      jira: 'Data Center only (paid, closed)',
      linear: 'No',
      trama: 'Source-available (PolyForm Shield), on your own PostgreSQL',
    },
  ];

  protected readonly flows: readonly Flow[] = [
    {
      who: 'Trello, Jira, Linear',
      steps: [
        { label: 'Issue' },
        { label: 'Assignee' },
        { label: 'Branch' },
        { label: 'PR' },
        { label: 'Done' },
      ],
      note: 'The ticket is the request, the plan, the discussion and the status at once. Agents become just another assignee.',
    },
    {
      who: 'Trama + Delta',
      own: true,
      steps: [
        { label: 'Task' },
        { label: '/trama in Delta', accent: true },
        { label: 'Thread record', accent: true },
        { label: 'PR' },
        { label: 'Done' },
      ],
      note: 'The task holds the problem. The agent works in a Delta thread, and the record of what it decided comes back to the task.',
    },
  ];
}
