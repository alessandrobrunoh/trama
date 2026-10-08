import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  LucideArrowRight,
  LucideCheckCheck,
  LucideDynamicIcon,
  LucideInbox,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import {
  ATTENTION_KIND_META,
  ATTENTION_KINDS,
  NablaStore,
  WORKSTREAM_STATUS_FLOW,
  isOverdue,
  type ActorRef,
  type Team,
  type Workstream,
  type WorkstreamStatus,
} from '../../core';
import {
  ActorAvatar,
  AvatarStack,
  EmptyState,
  KeyChip,
  PageHeader,
  ShortDatePipe,
  StatusBadge,
  StatusIcon,
  statusLabel,
} from '../../shared';
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

/** Ordering of the distribution bar: most urgent first, ending with the done states. */
const BAR_ORDER: WorkstreamStatus[] = [
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

interface TeamGroup {
  team: Team;
  items: { ws: Workstream; performers: ActorRef[]; overdue: boolean }[];
}

/** Workspace at a glance: attention summary, status distribution, active work by team, shipped, decisions, activity. */
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
    StatusBadge,
    StatusIcon,
    ActorAvatar,
    AvatarStack,
    EventLine,
    ShortDatePipe,
    AgoPipe,
  ],
  host: { class: 'block min-h-full' },
  template: `
    <app-page-header
      [title]="store.workspace()?.name ?? 'Overview'"
      [description]="subtitle()"
    />

    <div class="mx-auto flex w-full max-w-[1320px] flex-col gap-5 px-4 py-4 sm:px-6">
      <!-- Attention strip -->
      <section aria-label="Attention summary" class="rounded-lg border">
        <div class="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2.5">
          <a
            [routerLink]="['/', slug(), 'attention']"
            class="hover:bg-accent -mx-1 flex items-center gap-2 rounded-md px-1 py-1"
          >
            @if (store.attentionCount() > 0) {
              <span
                class="bg-status-needs-input/15 text-status-needs-input flex h-6 min-w-6 items-center justify-center rounded-md px-1.5 text-sm font-semibold tabular-nums"
                >{{ store.attentionCount() }}</span
              >
              <span class="text-sm font-medium">need your attention</span>
            } @else {
              <svg [lucideIcon]="check" [size]="16" class="text-status-shipped"></svg>
              <span class="text-sm font-medium">Nothing needs you right now</span>
            }
          </a>
          <div class="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
            @for (k of attentionKinds(); track k.kind) {
              <a
                [routerLink]="['/', slug(), 'attention']"
                class="hover:bg-accent text-muted-foreground hover:text-foreground flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs"
              >
                <svg [lucideIcon]="k.icon" [size]="13" [class]="k.color"></svg>
                <span class="text-foreground font-medium tabular-nums">{{ k.count }}</span>
                <span>{{ k.label }}</span>
              </a>
            }
          </div>
          <a
            hlmBtn
            variant="ghost"
            size="sm"
            class="ms-auto"
            [routerLink]="['/', slug(), 'attention']"
          >
            My Attention <svg [lucideIcon]="arrow" [size]="14"></svg>
          </a>
        </div>
      </section>

      <!-- Status distribution -->
      <section aria-label="Workstream status distribution" class="rounded-lg border px-3 py-3">
        <div class="mb-2.5 flex items-baseline justify-between gap-2">
          <h2 class="text-sm font-medium">Workstreams</h2>
          <a [routerLink]="['/', slug(), 'workstreams']" class="text-meta hover:text-foreground"
            >{{ store.workstreams().length }} total</a
          >
        </div>
        @if (distribution().total === 0) {
          <p class="text-meta py-2">No workstreams yet.</p>
        } @else {
          <div class="bg-muted flex h-2 w-full gap-px overflow-hidden rounded-full" role="img" [attr.aria-label]="distributionLabel()">
            @for (s of distribution().rows; track s.status) {
              <span
                [class]="s.bar"
                [style.flex-grow]="s.count"
                [hlmTooltip]="s.label + ': ' + s.count"
                position="bottom"
                class="min-w-1"
              ></span>
            }
          </div>
          <ul class="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
            @for (s of distribution().rows; track s.status) {
              <li class="flex items-center gap-1.5 text-xs">
                <app-status-icon [status]="s.status" [size]="13" />
                <span class="text-muted-foreground">{{ s.label }}</span>
                <span class="font-medium tabular-nums">{{ s.count }}</span>
              </li>
            }
          </ul>
        }
      </section>

      <div class="grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
        <!-- Active workstreams grouped by owner team -->
        <section aria-label="Active workstreams" class="min-w-0">
          <div class="mb-2 flex items-baseline justify-between">
            <h2 class="text-sm font-medium">Active workstreams</h2>
            <span class="text-meta">{{ activeCount() }} in flight</span>
          </div>
          @if (teamGroups().length === 0) {
            <div class="rounded-lg border">
              <app-empty-state
                title="No active workstreams"
                description="Create a workstream to start coordinating work."
              >
                <a hlmBtn size="sm" [routerLink]="['/', slug(), 'workstreams']">Open workstreams</a>
              </app-empty-state>
            </div>
          } @else {
            <div class="flex flex-col gap-4">
              @for (g of teamGroups(); track g.team.id) {
                <div class="rounded-lg border">
                  <a
                    [routerLink]="['/', slug(), 'teams', g.team.key]"
                    class="hover:bg-accent/50 flex h-9 items-center gap-2 rounded-t-lg border-b px-3"
                  >
                    <app-actor-avatar [actor]="{ type: 'team', id: g.team.id }" [size]="18" />
                    <span class="text-sm font-medium">{{ g.team.name }}</span>
                    <app-key-chip [value]="g.team.key" />
                    <span class="text-meta ms-auto tabular-nums">{{ g.items.length }}</span>
                  </a>
                  <ul class="divide-y">
                    @for (r of g.items; track r.ws.id) {
                      <li>
                        <a
                          [routerLink]="['/', slug(), 'workstreams', r.ws.key]"
                          class="hover:bg-accent/50 grid min-h-9 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-3 py-1.5 max-sm:grid-cols-[minmax(0,1fr)_auto]"
                        >
                          <app-key-chip class="w-14 max-sm:hidden" [value]="r.ws.key" />
                          <span class="flex min-w-0 items-center gap-2">
                            <app-key-chip class="sm:hidden" [value]="r.ws.key" />
                            <span class="truncate text-sm">{{ r.ws.title }}</span>
                          </span>
                          <span class="flex items-center justify-end gap-3 max-sm:col-span-full max-sm:justify-start">
                            <app-status-badge [status]="r.ws.status" />
                            @if (r.performers.length) {
                              <app-avatar-stack [actors]="r.performers" [max]="3" [size]="18" />
                            }
                            @if (r.ws.accountableUserId) {
                              <app-actor-avatar [actor]="{ type: 'user', id: r.ws.accountableUserId }" [size]="18" />
                            } @else {
                              <span class="size-[18px]"></span>
                            }
                            <span
                              class="text-meta w-14 text-end tabular-nums"
                              [class.text-status-blocked]="r.overdue"
                              >{{ r.ws.targetDate | shortDate }}</span
                            >
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
        <div class="flex min-w-0 flex-col gap-5">
          <section aria-label="Recently shipped">
            <div class="mb-2 flex items-baseline justify-between">
              <h2 class="text-sm font-medium">Recently shipped</h2>
            </div>
            <ul class="divide-y rounded-lg border">
              @for (w of shipped(); track w.id) {
                <li>
                  <a
                    [routerLink]="['/', slug(), 'workstreams', w.key]"
                    class="hover:bg-accent/50 flex min-h-9 items-center gap-2 px-3 py-1.5"
                  >
                    <app-status-icon status="shipped" [size]="14" />
                    <app-key-chip [value]="w.key" />
                    <span class="min-w-0 flex-1 truncate text-sm">{{ w.title }}</span>
                    <span class="text-meta shrink-0 tabular-nums">{{ (w.shippedAt ?? w.updatedAt) | ago }}</span>
                  </a>
                </li>
              } @empty {
                <li class="text-meta px-3 py-3">Nothing shipped yet.</li>
              }
            </ul>
          </section>

          <section aria-label="Recent decisions">
            <div class="mb-2 flex items-baseline justify-between">
              <h2 class="text-sm font-medium">Recent decisions</h2>
              <a [routerLink]="['/', slug(), 'decisions']" class="text-meta hover:text-foreground">All</a>
            </div>
            <ul class="divide-y rounded-lg border">
              @for (d of decisions(); track d.id) {
                <li>
                  <a
                    [routerLink]="['/', slug(), 'decisions', d.key]"
                    class="hover:bg-accent/50 flex min-h-9 items-center gap-2 px-3 py-1.5"
                  >
                    <app-status-icon [status]="d.status" [size]="14" />
                    <app-key-chip [value]="d.key" />
                    <span class="min-w-0 flex-1 truncate text-sm">{{ d.title }}</span>
                    <span class="text-meta shrink-0 tabular-nums">{{ (d.decidedAt ?? d.updatedAt) | ago }}</span>
                  </a>
                </li>
              } @empty {
                <li class="text-meta px-3 py-3">No decisions recorded.</li>
              }
            </ul>
          </section>

          <section aria-label="Latest activity">
            <div class="mb-1 flex items-baseline justify-between">
              <h2 class="text-sm font-medium">Latest activity</h2>
            </div>
            <div class="rounded-lg border px-3 py-1">
              @for (e of events(); track e.id) {
                <app-event-line [event]="e" [slug]="slug()" class="not-last:border-b" />
              } @empty {
                <p class="text-meta py-3">No activity yet.</p>
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
  protected readonly slug = computed(() => this.workspaceSlug() ?? this.store.slug() ?? '');
  protected readonly check = LucideCheckCheck;
  protected readonly arrow = LucideArrowRight;
  protected readonly inbox = LucideInbox;

  protected readonly subtitle = computed(() => {
    const w = this.store.workstreams();
    const active = w.filter((x) => x.status !== 'shipped' && x.status !== 'canceled' && x.status !== 'draft').length;
    return `${active} active workstream${active === 1 ? '' : 's'} · ${this.store.teams().length} teams · ${this.store.agents().length} agents`;
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
    const rows = BAR_ORDER.filter((s) => (counts.get(s) ?? 0) > 0).map((status) => ({
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
    const urgency = (s: WorkstreamStatus) => BAR_ORDER.indexOf(s);
    const groups: TeamGroup[] = [];
    for (const team of store.teams()) {
      const own = (store.workstreamsByOwnerTeam().get(team.id) ?? []).filter(
        (w) => w.status !== 'shipped' && w.status !== 'canceled' && w.status !== 'draft',
      );
      if (!own.length) continue;
      const items = own
        .map((ws) => ({
          ws,
          performers: ws.accountableUserId ? [{ type: 'user' as const, id: ws.accountableUserId }] : [],
          overdue: isOverdue(ws.targetDate),
        }))
        .sort(
          (a, b) =>
            urgency(a.ws.status) - urgency(b.ws.status) ||
            flow(a.ws.status) - flow(b.ws.status) ||
            a.ws.number - b.ws.number,
        );
      groups.push({ team, items });
    }
    return groups.sort((a, b) => b.items.length - a.items.length || a.team.name.localeCompare(b.team.name));
  });
  protected readonly activeCount = computed(() => this.teamGroups().reduce((n, g) => n + g.items.length, 0));

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

  protected readonly events = computed(() => this.store.events().slice(0, 14));
}
