import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideArrowRight, LucideBan, LucideDynamicIcon } from '@lucide/angular';
import {
  Kanban,
  KanbanItemDirective,
  KanbanLabelDirective,
  type KanbanColumn,
} from '../../shared/kanban';
import { StatusIcon } from '../../shared/status';
import type { WorkstreamStatus } from '../../core/contracts/domain';
import { SiteFooter } from '../landing/site-footer';
import { SiteHeader } from '../landing/site-header';

type Horizon = 'shipped' | 'now' | 'next' | 'later';

interface RoadmapItem {
  id: string;
  title: string;
  body: string;
  area: string;
}

/** Each horizon reads like a workstream status on the in-app board. */
const HORIZONS: Record<Horizon, { label: string; status: WorkstreamStatus }> = {
  shipped: { label: 'Shipped', status: 'shipped' },
  now: { label: 'Now', status: 'working' },
  next: { label: 'Next', status: 'planned' },
  later: { label: 'Later', status: 'draft' },
};

/** `/roadmap`: public, hand-curated product direction (Now / Next / Later). */
@Component({
  selector: 'app-roadmap-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    LucideDynamicIcon,
    Kanban,
    KanbanItemDirective,
    KanbanLabelDirective,
    StatusIcon,
    SiteHeader,
    SiteFooter,
  ],
  host: {
    class: 'bg-background text-foreground relative isolate flex min-h-svh flex-col overflow-x-clip',
  },
  template: `
    <div
      aria-hidden="true"
      class="bg-primary/10 pointer-events-none absolute top-[-22rem] left-1/2 -z-10 h-[36rem] w-[60rem] max-w-[160vw] -translate-x-1/2 rounded-full blur-3xl"
    ></div>
    <app-site-header />

    <main class="w-full flex-1 pt-16 pb-24 sm:pt-24">
      <div class="mx-auto max-w-6xl px-4 sm:px-6">
        <div class="max-w-2xl">
          <p class="text-primary text-[13px] font-medium">Roadmap</p>
          <h1 class="mt-2 text-4xl font-semibold tracking-[-0.03em] sm:text-5xl">
            Where Trama is going
          </h1>
          <p class="text-muted-foreground mt-4 text-[15px] leading-relaxed">
            Our first goal is to prove the workstream model in real teams. Everything else comes
            after. Dates are deliberately absent: we would rather ship when it's right than hit a
            number we made up.
          </p>
          <a
            routerLink="/changelog"
            class="text-primary mt-5 inline-flex items-center gap-1 text-[13px] font-medium"
          >
            See what already shipped <svg [lucideIcon]="arrowIcon" [size]="14"></svg>
          </a>
        </div>
      </div>

      <!-- Same board as the app's issue / workstream views, read-only; a little wider than the text. -->
      <div class="mx-auto mt-12 flex max-w-[78rem]">
        <app-kanban
          class="min-w-0"
          [columns]="columns"
          [disabled]="true"
          prefix="roadmap"
          emptyText="Nothing here yet"
        >
          <ng-template kanbanItem let-item>
            <article class="bg-card border-border rounded-lg border px-3 py-2.5 shadow-xs">
              <div class="flex h-5 items-center">
                <span class="text-muted-foreground font-mono text-xs">{{ item.id }}</span>
                <span class="text-muted-foreground ml-auto text-[11px]">{{ item.area }}</span>
              </div>
              <h3 class="mt-1 text-[13px] leading-snug font-medium">{{ item.title }}</h3>
              <p class="text-muted-foreground mt-1.5 text-[12px] leading-relaxed">
                {{ item.body }}
              </p>
            </article>
          </ng-template>
          <ng-template kanbanLabel let-key>
            @let h = horizon(key);
            <app-status-icon entity="workstream" [status]="h.status" />
            <span class="font-medium">{{ h.label }}</span>
          </ng-template>
        </app-kanban>
      </div>

      <div class="mx-auto max-w-6xl px-4 sm:px-6">
        <section class="border-border mt-16 rounded-2xl border border-dashed p-6 sm:p-8">
          <div class="flex items-center gap-2">
            <svg [lucideIcon]="banIcon" [size]="16" class="text-muted-foreground"></svg>
            <h2 class="font-semibold">Deliberately not on the roadmap</h2>
          </div>
          <p class="text-muted-foreground mt-2 max-w-2xl text-[13px] leading-relaxed">
            Saying no keeps Trama focused. These come up often, and we think they would make the
            product worse.
          </p>
          <ul class="mt-5 grid gap-x-8 gap-y-2 text-[13px] sm:grid-cols-2">
            @for (no of notPlanned; track no) {
              <li class="text-muted-foreground flex gap-2">
                <span aria-hidden="true">—</span>{{ no }}
              </li>
            }
          </ul>
        </section>
      </div>
    </main>

    <app-site-footer />
  `,
})
export class RoadmapPage {
  protected readonly arrowIcon = LucideArrowRight;
  protected readonly banIcon = LucideBan;
  protected horizon(key: string): (typeof HORIZONS)[Horizon] {
    return HORIZONS[key as Horizon];
  }

  /** Cards are numbered RM-1… in board order, like issue keys. */
  protected readonly columns: KanbanColumn<RoadmapItem>[] = numbered([
    {
      key: 'shipped',
      items: [
        {
          area: 'Agents',
          title: 'Scoped API tokens',
          body: 'Resource × action permissions and usage caps for every token an agent or integration uses.',
        },
        {
          area: 'Workstreams',
          title: 'Milestones, dependencies and input requests',
          body: 'Plan and sequence outcomes, and let agents ask a human when they are blocked.',
        },
        {
          area: 'Assistant',
          title: 'Ask Trama',
          body: 'An assistant in the command palette and a popup, with chat history.',
        },
        {
          area: 'Adoption',
          title: 'Import and link GitHub Issues and Linear',
          body: 'Keep your current tracker and add Trama next to it: import with a mapping you can edit, or link one issue and see its status. Trama only reads.',
        },
      ],
    },
    {
      key: 'now',
      items: [
        {
          area: 'Agents',
          title: 'MCP server',
          body: 'A standalone MCP server so any agent can read and update workstreams, issues and decisions with a scoped token.',
        },
        {
          area: 'Integrations',
          title: 'Automatic artifact discovery',
          body: 'Pull and merge requests from GitHub and GitLab attach to the right workstream on their own, with live CI and review state.',
        },
        {
          area: 'Workstreams',
          title: 'Shared workspace links',
          body: 'First-class links to the Delta thread or other workspace where the implementation happens, so handoffs start from context.',
        },
      ],
    },
    {
      key: 'next',
      items: [
        {
          area: 'Adoption',
          title: 'Jira, and automatic sync of linked issues',
          body: 'Link Jira issues too, and keep the status of linked GitHub and Linear issues up to date in the background instead of on demand.',
        },
        {
          area: 'Workstreams',
          title: 'Context exchange with agent workspaces',
          body: 'Exchange objective, decisions and artifacts with the shared workspace, instead of copying conversations around.',
        },
        {
          area: 'Self-hosting',
          title: 'One-command deployment',
          body: 'A packaged web app, API and PostgreSQL setup that a small team can run and upgrade without an ops team.',
        },
        {
          area: 'Collaboration',
          title: 'Smarter notifications',
          body: 'Notify about outcomes that changed and questions waiting for you, not about every field edit.',
        },
      ],
    },
    {
      key: 'later',
      items: [
        {
          area: 'Delivery',
          title: 'Deployments as artifacts',
          body: 'Connect CI and deployment systems so a workstream can show where its outcome is actually running.',
        },
        {
          area: 'Agents',
          title: 'More execution providers',
          body: 'Deeper support for additional coding agents, without making any single provider a dependency.',
        },
        {
          area: 'Hosting',
          title: 'Managed cloud',
          body: 'A hosted option for teams that prefer not to run Trama themselves, with the same core as the self-hosted edition.',
        },
      ],
    },
  ]);

  protected readonly notPlanned = [
    'Completion percentages that are not measured',
    'Agent telemetry and token-usage dashboards',
    'Scoring agents or people by “performance”',
    'Elaborate sprint analytics',
    'A general-purpose automation builder',
    'Mirroring full agent conversations inside Trama',
  ];
}

function numbered(
  columns: { key: Horizon; items: Omit<RoadmapItem, 'id'>[] }[],
): KanbanColumn<RoadmapItem>[] {
  let n = 0;
  return columns.map((c) => ({
    key: c.key,
    items: c.items.map((item) => ({ ...item, id: `RM-${++n}` })),
  }));
}
