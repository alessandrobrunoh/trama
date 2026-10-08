import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideArrowRight, LucideDynamicIcon } from '@lucide/angular';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import { DECISION_STATUS_META } from '../../core';
import { IssueKindLabel } from '../../shared/issue';
import { PriorityIcon } from '../../shared/priority-icon';
import { StatusIcon } from '../../shared/status';
import { AgoPipe } from './ago';
import { EventLine } from './event-line';
import { OverviewModel } from './overview-model';

/** Quiet lists: backlog to triage, recently shipped, decisions to review and the latest activity. */
@Component({
  selector: 'app-overview-rail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, LucideDynamicIcon, HlmTooltip, IssueKindLabel, PriorityIcon, StatusIcon, EventLine, AgoPipe],
  host: { class: 'flex min-w-0 flex-col gap-8' },
  template: `
    <section aria-labelledby="ov-triage">
      <header class="mb-1 flex items-baseline gap-3 border-b pb-2">
        <h2 id="ov-triage" class="text-sm font-medium">Needs triage</h2>
        <span class="text-meta tabular-nums">{{ m.backlogCount() }}</span>
        <span class="flex-1"></span>
        <a [routerLink]="['/', m.slug(), 'issues']" [queryParams]="{ view: 'backlog' }" class="text-meta hover:text-foreground">Backlog</a>
      </header>
      <ul>
        @for (i of m.triage(); track i.id) {
          <li>
            <a [routerLink]="['/', m.slug(), 'issues', i.key]" class="hover:bg-hover -mx-2 flex h-8 items-center gap-2 rounded-md px-2">
              <app-priority-icon [priority]="i.priority" />
              <app-issue-kind [kind]="i.kind" />
              <span class="min-w-0 flex-1 truncate text-[13px]">{{ i.title }}</span>
              <span class="text-meta shrink-0 tabular-nums">{{ i.createdAt | ago }}</span>
            </a>
          </li>
        } @empty {
          <li class="text-meta py-2">The backlog is empty. New demand lands here until someone picks it up.</li>
        }
      </ul>
    </section>

    <section aria-labelledby="ov-shipped">
      <header class="mb-1 flex items-baseline gap-3 border-b pb-2">
        <h2 id="ov-shipped" class="text-sm font-medium">Recently shipped</h2>
        <span class="text-meta">last 30 days</span>
        <span class="flex-1"></span>
        <a [routerLink]="['/', m.slug(), 'workstreams']" [queryParams]="{ view: 'shipped' }" class="text-meta hover:text-foreground">All</a>
      </header>
      <ul>
        @for (w of m.shipped(); track w.id) {
          <li>
            <a [routerLink]="['/', m.slug(), 'workstreams', w.key]" class="hover:bg-hover -mx-2 flex h-8 items-center gap-2 rounded-md px-2">
              <app-status-icon entity="workstream" status="shipped" />
              <span class="text-muted-foreground w-[4.25rem] shrink-0 truncate font-mono text-[11px]">{{ w.key }}</span>
              <span class="min-w-0 flex-1 truncate text-[13px]">{{ w.title }}</span>
              <span class="text-meta shrink-0 tabular-nums">{{ w.shippedAt | ago }}</span>
            </a>
          </li>
        } @empty {
          <li class="text-meta py-2">Nothing shipped in the last 30 days.</li>
        }
      </ul>
    </section>

    <section aria-labelledby="ov-decisions">
      <header class="mb-1 flex items-baseline gap-3 border-b pb-2">
        <h2 id="ov-decisions" class="text-sm font-medium">Decisions to review</h2>
        @if (m.proposedCount() > 0) {
          <span class="text-status-needs-input text-xs tabular-nums">{{ m.proposedCount() }} proposed</span>
        }
        <span class="flex-1"></span>
        <a [routerLink]="['/', m.slug(), 'decisions']" class="text-meta hover:text-foreground">All</a>
      </header>
      <ul>
        @for (d of m.decisions(); track d.id) {
          <li>
            <a [routerLink]="['/', m.slug(), 'decisions', d.key]" class="hover:bg-hover -mx-2 flex h-8 items-center gap-2 rounded-md px-2">
              <app-status-icon entity="other" [status]="d.status" [hlmTooltip]="decisionLabel[d.status]" position="left" />
              <span class="text-muted-foreground w-[4.25rem] shrink-0 truncate font-mono text-[11px]">{{ d.key }}</span>
              <span class="min-w-0 flex-1 truncate text-[13px]">{{ d.title }}</span>
              <span class="text-meta shrink-0 tabular-nums">{{ d.decidedAt ?? d.createdAt | ago }}</span>
            </a>
          </li>
        } @empty {
          <li class="text-meta py-2">No decisions recorded yet.</li>
        }
      </ul>
    </section>

    <section aria-labelledby="ov-activity">
      <header class="mb-1 flex items-baseline gap-3 border-b pb-2">
        <h2 id="ov-activity" class="text-sm font-medium">Latest activity</h2>
        <span class="flex-1"></span>
        <a [routerLink]="['/', m.slug(), 'activity']" class="text-meta hover:text-foreground inline-flex items-center gap-1">
          View all <svg [lucideIcon]="arrow" [size]="12"></svg>
        </a>
      </header>
      <div class="flex flex-col">
        @for (e of m.events(); track e.id) {
          <app-event-line [event]="e" [slug]="m.slug()" compact hideDetail />
        } @empty {
          <p class="text-meta py-2">No activity yet.</p>
        }
      </div>
    </section>
  `,
})
export class OverviewRail {
  protected readonly m = inject(OverviewModel);
  protected readonly arrow = LucideArrowRight;
  protected readonly decisionLabel = Object.fromEntries(Object.entries(DECISION_STATUS_META).map(([k, v]) => [k, v.label])) as Record<string, string>;
}
