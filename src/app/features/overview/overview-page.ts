import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideArrowRight, LucideCheckCheck, LucideDynamicIcon, LucidePlus } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import {
  ATTENTION_KIND_META,
  ATTENTION_KINDS,
  NablaStore,
  UiStore,
  WORKSTREAM_STATUS_FLOW,
  isOverdue,
  type Team,
  type Workstream,
  type WorkstreamStatus,
} from '../../core';
import { ActorAvatar } from '../../shared/actor-avatar';
import { EmptyState } from '../../shared/empty-state';
import { IssueKindLabel } from '../../shared/issue';
import { KeyChip } from '../../shared/key-chip';
import { PageHeader } from '../../shared/page-header';
import { ShortDatePipe } from '../../shared/pipes';
import { PriorityIcon } from '../../shared/priority-icon';
import { StatusIcon, statusLabel } from '../../shared/status';
import { ATTENTION_KIND_VIEW } from '../attention/attention-kinds';
import { AgoPipe } from './ago';
import { EventLine } from './event-line';

/** Static class names (Tailwind must see them) for the status distribution bar. */
const BAR: Record<WorkstreamStatus, string> = {
  draft: 'bg-status-draft',
  planned: 'bg-status-planned',
  working: 'bg-status-working',
  needs_input: 'bg-status-needs-input',
  in_review: 'bg-status-in-review',
  blocked: 'bg-status-blocked',
  ready_to_land: 'bg-status-ready-to-land',
  shipped: 'bg-status-shipped',
  canceled: 'bg-status-canceled',
};

/** Most urgent first, ending with the done states. */
const URGENCY: WorkstreamStatus[] = [
  'blocked',
  'needs_input',
  'ready_to_land',
  'in_review',
  'working',
  'planned',
  'draft',
  'shipped',
  'canceled',
];

const ACTIVE = (w: Workstream) => w.status !== 'shipped' && w.status !== 'canceled' && w.status !== 'draft';

interface WsRow {
  ws: Workstream;
  overdue: boolean;
  /** Linked issues that are done / all linked issues that are not canceled. */
  done: number;
  total: number;
}

interface TeamGroup {
  team: Team;
  rows: WsRow[];
}

/**
 * Workspace at a glance — a calm, Linear-like dashboard: what needs me, which outcomes are in
 * flight (by team, with issue progress), demand waiting for triage, what shipped, what was decided,
 * and the latest activity.
 */
@Component({
  selector: 'app-overview-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    LucideDynamicIcon,
    HlmButtonImports,
    HlmTooltip,
    PageHeader,
    EmptyState,
    KeyChip,
    StatusIcon,
    PriorityIcon,
    IssueKindLabel,
    ActorAvatar,
    EventLine,
    ShortDatePipe,
    AgoPipe,
  ],
  host: { class: 'block min-h-full' },
  template: `
    <app-page-header title="Overview" [description]="subtitle()" />

    <div class="mx-auto flex w-full max-w-[1240px] flex-col gap-8 px-4 py-6 sm:px-8">
      <!-- What needs me -->
      <section aria-label="Attention summary" class="flex flex-wrap items-center gap-x-5 gap-y-2">
        <a [routerLink]="['/', slug(), 'attention']" class="group flex items-center gap-2.5">
          @if (store.attentionCount() > 0) {
            <span
              class="bg-status-needs-input/15 text-status-needs-input flex h-6 min-w-6 items-center justify-center rounded-md px-1.5 text-sm font-semibold tabular-nums"
              >{{ store.attentionCount() }}</span
            >
            <span class="text-sm font-medium group-hover:underline">
              {{ store.attentionCount() === 1 ? 'thing needs' : 'things need' }} your attention
            </span>
          } @else {
            <svg [lucideIcon]="check" [size]="16" class="text-status-shipped"></svg>
            <span class="text-sm font-medium">Nothing needs you right now</span>
          }
        </a>
        <div class="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-1">
          @for (k of attentionKinds(); track k.kind) {
            <a
              [routerLink]="['/', slug(), 'attention']"
              class="text-muted-foreground hover:text-foreground flex items-center gap-1.5 text-xs"
            >
              <svg [lucideIcon]="k.icon" [size]="13" [class]="k.color"></svg>
              <span class="text-foreground font-medium tabular-nums">{{ k.count }}</span>
              {{ k.label.toLowerCase() }}
            </a>
          }
        </div>
        <a hlmBtn variant="ghost" size="sm" class="text-muted-foreground -me-2" [routerLink]="['/', slug(), 'my-work']">
          My work <svg [lucideIcon]="arrow" [size]="14"></svg>
        </a>
      </section>

      <div class="grid gap-x-12 gap-y-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <!-- Active workstreams grouped by owner team -->
        <section aria-label="Active workstreams" class="min-w-0">
          <header class="mb-1 flex items-baseline gap-3">
            <h2 class="text-sm font-medium">Active workstreams</h2>
            <span class="text-meta tabular-nums">{{ activeCount() }}</span>
            <span class="flex-1"></span>
            <a [routerLink]="['/', slug(), 'stats']" class="text-meta hover:text-foreground">Statistics</a>
            <a [routerLink]="['/', slug(), 'workstreams']" class="text-meta hover:text-foreground">All workstreams</a>
          </header>

          @if (distribution().total > 0) {
            <div class="mb-4">
              <div class="bg-foreground/[0.06] flex h-1.5 w-full gap-px overflow-hidden rounded-full" role="img" [attr.aria-label]="distributionLabel()">
                @for (s of distribution().rows; track s.status) {
                  <span [class]="s.bar" [style.flex-grow]="s.count" [hlmTooltip]="s.label + ': ' + s.count" position="bottom" class="min-w-1"></span>
                }
              </div>
              <ul class="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                @for (s of distribution().rows; track s.status) {
                  <li class="flex items-center gap-1.5 text-xs">
                    <app-status-icon entity="workstream" [status]="s.status" [size]="12" />
                    <span class="text-muted-foreground">{{ s.label }}</span>
                    <span class="tabular-nums">{{ s.count }}</span>
                  </li>
                }
              </ul>
            </div>
          }

          @if (teamGroups().length === 0) {
            <app-empty-state title="No active workstreams" description="A workstream is an outcome that resolves one or more issues. Start one to coordinate the work.">
              <button hlmBtn size="sm" (click)="ui.openCreate('workstream')">
                <svg [lucideIcon]="plus" [size]="14"></svg> New workstream
              </button>
            </app-empty-state>
          } @else {
            <div class="flex flex-col gap-5">
              @for (g of teamGroups(); track g.team.id) {
                <div>
                  <a
                    [routerLink]="['/', slug(), 'teams', g.team.key]"
                    class="text-muted-foreground hover:text-foreground flex h-8 items-center gap-2 border-b text-xs font-medium"
                  >
                    <app-actor-avatar [actor]="{ type: 'team', id: g.team.id }" [size]="16" />
                    <span class="text-foreground">{{ g.team.name }}</span>
                    <span class="tabular-nums">{{ g.rows.length }}</span>
                  </a>
                  <ul>
                    @for (r of g.rows; track r.ws.id) {
                      <li>
                        <a
                          [routerLink]="['/', slug(), 'workstreams', r.ws.key]"
                          class="hover:bg-hover -mx-2 grid h-9 grid-cols-[auto_auto_minmax(0,1fr)_auto] items-center gap-x-2.5 rounded-md px-2"
                        >
                          <app-status-icon entity="workstream" [status]="r.ws.status" [hlmTooltip]="label(r.ws.status)" position="left" />
                          <app-key-chip [value]="r.ws.key" class="w-[4.25rem] max-sm:hidden" />
                          <span class="truncate text-sm">{{ r.ws.title }}</span>
                          <span class="flex items-center gap-3">
                            @if (r.total > 0) {
                              <span class="flex items-center gap-1.5 max-sm:hidden" [hlmTooltip]="r.done + ' of ' + r.total + ' linked issues done'" position="top">
                                <span class="bg-foreground/[0.08] h-1 w-12 overflow-hidden rounded-full">
                                  <span class="bg-status-shipped block h-full rounded-full" [style.width.%]="(r.done / r.total) * 100"></span>
                                </span>
                                <span class="text-meta w-8 tabular-nums">{{ r.done }}/{{ r.total }}</span>
                              </span>
                            } @else {
                              <span class="text-meta w-[4.75rem] max-sm:hidden">no issues</span>
                            }
                            <span class="flex w-5 justify-center">
                              @if (r.ws.accountableUserId) {
                                <app-actor-avatar [actor]="{ type: 'user', id: r.ws.accountableUserId }" [size]="18" />
                              }
                            </span>
                            <span class="text-meta w-12 text-end tabular-nums max-sm:hidden" [class.text-status-blocked]="r.overdue">{{ r.ws.targetDate | shortDate }}</span>
                          </span>
                        </a>
                      </li>
                    }
                  </ul>
                </div>
              }
            </div>
          }
        </section>

        <!-- Side column -->
        <div class="flex min-w-0 flex-col gap-9">
          <section aria-label="Needs triage">
            <header class="mb-1 flex items-baseline gap-3 border-b pb-2">
              <h2 class="text-sm font-medium">Needs triage</h2>
              <span class="text-meta tabular-nums">{{ store.backlogIssueCount() }}</span>
              <span class="flex-1"></span>
              <a [routerLink]="['/', slug(), 'issues']" [queryParams]="{ status: 'backlog' }" class="text-meta hover:text-foreground">Backlog</a>
            </header>
            <ul>
              @for (i of triage(); track i.id) {
                <li>
                  <a [routerLink]="['/', slug(), 'issues', i.key]" class="hover:bg-hover -mx-2 flex h-8 items-center gap-2 rounded-md px-2">
                    <app-priority-icon [priority]="i.priority" />
                    <app-issue-kind [kind]="i.kind" />
                    <span class="text-muted-foreground w-[4.5rem] shrink-0 truncate font-mono text-[11px]">{{ i.key }}</span>
                    <span class="min-w-0 flex-1 truncate text-sm">{{ i.title }}</span>
                    <span class="text-meta shrink-0 tabular-nums">{{ i.createdAt | ago }}</span>
                  </a>
                </li>
              } @empty {
                <li class="text-meta py-2">Backlog is empty. New issues land here until someone picks them up.</li>
              }
            </ul>
          </section>

          <section aria-label="Recently shipped">
            <header class="mb-1 flex items-baseline gap-3 border-b pb-2">
              <h2 class="text-sm font-medium">Recently shipped</h2>
              <span class="flex-1"></span>
              <a [routerLink]="['/', slug(), 'workstreams']" [queryParams]="{ status: 'shipped' }" class="text-meta hover:text-foreground">All</a>
            </header>
            <ul>
              @for (w of shipped(); track w.id) {
                <li>
                  <a [routerLink]="['/', slug(), 'workstreams', w.key]" class="hover:bg-hover -mx-2 flex h-8 items-center gap-2 rounded-md px-2">
                    <app-status-icon entity="workstream" status="shipped" />
                    <span class="text-muted-foreground w-[4.25rem] shrink-0 truncate font-mono text-[11px]">{{ w.key }}</span>
                    <span class="min-w-0 flex-1 truncate text-sm">{{ w.title }}</span>
                    <span class="text-meta shrink-0 tabular-nums">{{ w.shippedAt ?? w.updatedAt | ago }}</span>
                  </a>
                </li>
              } @empty {
                <li class="text-meta py-2">Nothing shipped yet.</li>
              }
            </ul>
          </section>

          <section aria-label="Recent decisions">
            <header class="mb-1 flex items-baseline gap-3 border-b pb-2">
              <h2 class="text-sm font-medium">Recent decisions</h2>
              <span class="flex-1"></span>
              <a [routerLink]="['/', slug(), 'decisions']" class="text-meta hover:text-foreground">All</a>
            </header>
            <ul>
              @for (d of decisions(); track d.id) {
                <li>
                  <a [routerLink]="['/', slug(), 'decisions', d.key]" class="hover:bg-hover -mx-2 flex h-8 items-center gap-2 rounded-md px-2">
                    <app-status-icon entity="other" [status]="d.status" [hlmTooltip]="label(d.status)" position="left" />
                    <span class="text-muted-foreground w-[4.25rem] shrink-0 truncate font-mono text-[11px]">{{ d.key }}</span>
                    <span class="min-w-0 flex-1 truncate text-sm">{{ d.title }}</span>
                    <span class="text-meta shrink-0 tabular-nums">{{ d.decidedAt ?? d.updatedAt | ago }}</span>
                  </a>
                </li>
              } @empty {
                <li class="text-meta py-2">No decisions recorded yet.</li>
              }
            </ul>
          </section>

          <section aria-label="Latest activity">
            <header class="mb-1 flex items-baseline gap-3 border-b pb-2">
              <h2 class="text-sm font-medium">Latest activity</h2>
              <span class="flex-1"></span>
              <a [routerLink]="['/', slug(), 'activity']" class="text-meta hover:text-foreground flex items-center gap-1">
                View all activity <svg [lucideIcon]="arrow" [size]="12"></svg>
              </a>
            </header>
            <div class="flex flex-col">
              @for (e of events(); track e.id) {
                <app-event-line [event]="e" [slug]="slug()" compact hideDetail />
              } @empty {
                <p class="text-meta py-2">No activity yet.</p>
              }
            </div>
          </section>
        </div>
      </div>
    </div>
  `,
})
export class OverviewPage {
  /** From the parent `:workspaceSlug` route segment. */
  readonly workspaceSlug = input<string>();

  protected readonly store = inject(NablaStore);
  protected readonly ui = inject(UiStore);
  protected readonly slug = computed(() => this.workspaceSlug() ?? this.store.slug() ?? '');
  protected readonly check = LucideCheckCheck;
  protected readonly arrow = LucideArrowRight;
  protected readonly plus = LucidePlus;
  protected readonly label = statusLabel;

  protected readonly subtitle = computed(() => {
    const active = this.store.workstreams().filter(ACTIVE).length;
    const open = this.store.issues().filter((i) => i.status !== 'done' && i.status !== 'canceled').length;
    return `${active} active workstream${active === 1 ? '' : 's'} · ${open} open issue${open === 1 ? '' : 's'}`;
  });

  protected readonly attentionKinds = computed(() => {
    const counts = this.store.attentionCounts();
    return ATTENTION_KINDS.filter((k) => counts[k] > 0).map((kind) => ({
      kind,
      count: counts[kind],
      label: ATTENTION_KIND_META[kind].label,
      icon: ATTENTION_KIND_VIEW[kind].icon,
      color: ATTENTION_KIND_VIEW[kind].color,
    }));
  });

  protected readonly distribution = computed(() => {
    const counts = new Map<WorkstreamStatus, number>();
    for (const w of this.store.workstreams()) counts.set(w.status, (counts.get(w.status) ?? 0) + 1);
    const rows = URGENCY.filter((s) => (counts.get(s) ?? 0) > 0).map((status) => ({
      status,
      count: counts.get(status) ?? 0,
      label: statusLabel(status),
      bar: BAR[status],
    }));
    return { rows, total: this.store.workstreams().length };
  });
  protected readonly distributionLabel = computed(() =>
    this.distribution()
      .rows.map((r) => `${r.count} ${r.label}`)
      .join(', '),
  );

  protected readonly teamGroups = computed<TeamGroup[]>(() => {
    const store = this.store;
    const flow = (s: WorkstreamStatus) => WORKSTREAM_STATUS_FLOW.indexOf(s);
    const urgency = (s: WorkstreamStatus) => URGENCY.indexOf(s);
    const byWs = store.issuesByWorkstream();
    const groups: TeamGroup[] = [];
    for (const team of store.teams()) {
      const own = (store.workstreamsByOwnerTeam().get(team.id) ?? []).filter(ACTIVE);
      if (!own.length) continue;
      const rows = own
        .map((ws) => {
          const issues = (byWs.get(ws.id) ?? []).filter((i) => i.status !== 'canceled');
          return {
            ws,
            overdue: isOverdue(ws.targetDate),
            done: issues.filter((i) => i.status === 'done').length,
            total: issues.length,
          };
        })
        .sort(
          (a, b) =>
            urgency(a.ws.status) - urgency(b.ws.status) || flow(a.ws.status) - flow(b.ws.status) || a.ws.number - b.ws.number,
        );
      groups.push({ team, rows });
    }
    const mine = store.myTeamIds();
    return groups.sort(
      (a, b) =>
        Number(mine.has(b.team.id)) - Number(mine.has(a.team.id)) ||
        b.rows.length - a.rows.length ||
        a.team.name.localeCompare(b.team.name),
    );
  });
  protected readonly activeCount = computed(() => this.teamGroups().reduce((n, g) => n + g.rows.length, 0));

  protected readonly triage = computed(() =>
    [...this.store.backlogIssues()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 6),
  );

  protected readonly shipped = computed(() =>
    this.store
      .workstreams()
      .filter((w) => w.status === 'shipped')
      .sort((a, b) => (b.shippedAt ?? b.updatedAt).localeCompare(a.shippedAt ?? a.updatedAt))
      .slice(0, 5),
  );

  protected readonly decisions = computed(() =>
    [...this.store.decisions()]
      .sort((a, b) => (b.decidedAt ?? b.updatedAt).localeCompare(a.decidedAt ?? a.updatedAt))
      .slice(0, 5),
  );

  protected readonly events = computed(() => this.store.events().slice(0, 10));
}
