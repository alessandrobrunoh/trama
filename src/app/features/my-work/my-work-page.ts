import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import {
  LucideArrowRight,
  LucideCheckCheck,
  LucideChevronRight,
  LucideDynamicIcon,
  LucideInbox,
  LucidePlus,
  LucideScale,
  type LucideIcon,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmTabsImports } from '@spartan-ng/helm/tabs';
import {
  ATTENTION_KIND_META,
  ATTENTION_KINDS,
  ISSUE_STATUS_META,
  NablaStore,
  UiStore,
  usePageShortcuts,
  type AttentionKind,
  type Decision,
  type Issue,
  type IssueStatus,
  type Workstream,
  type WorkstreamStatus,
} from '../../core';
import { TopBarActions } from '../../layout/page-chrome';
import { EmptyState } from '../../shared/empty-state';
import { Kbd } from '../../shared/kbd';
import { PageHeader } from '../../shared/page-header';
import { RelativeTimePipe } from '../../shared/pipes';
import { StatusIcon, statusLabel, type AnyStatus, type StatusEntity } from '../../shared/status';
import { ATTENTION_KIND_VIEW } from '../attention/attention-kinds';
import { formatDuration } from '../stats/insights';
import { weekSummary, type Lookup } from '../stats/perf';
import { buildWork } from '../stats/work';
import { MyIssueRow, MyWorkstreamRow } from './my-work-rows';

type Tab = 'assigned' | 'accountable' | 'contributing' | 'created';
const TABS: Tab[] = ['assigned', 'accountable', 'contributing', 'created'];

const ISSUE_ORDER: IssueStatus[] = ['in_progress', 'in_review', 'todo', 'backlog', 'done', 'canceled'];
const WS_ORDER: WorkstreamStatus[] = [
  'needs_input',
  'blocked',
  'ready_to_land',
  'in_review',
  'working',
  'planned',
  'draft',
  'shipped',
  'canceled',
];
const CLOSED = new Set<string>(['done', 'canceled', 'shipped']);

interface Group<T> {
  status: AnyStatus;
  label: string;
  closed: boolean;
  items: T[];
}

interface WsItem {
  ws: Workstream;
  reasons: string[];
}

/**
 * My Work (VISION §36): explicit, predictable lists — issues assigned to me (circles), workstreams I
 * am accountable for and ones I contribute to (hexagons), and what I created. Plus a "waiting on me"
 * summary that hands off to My Attention. `?tab=` selects the tab; keys 1–4 switch tabs.
 */
@Component({
  selector: 'app-my-work-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    NgTemplateOutlet,
    RouterLink,
    LucideDynamicIcon,
    HlmButtonImports,
    HlmTabsImports,
    TopBarActions,
    PageHeader,
    EmptyState,
    Kbd,
    StatusIcon,
    RelativeTimePipe,
    MyIssueRow,
    MyWorkstreamRow,
  ],
  host: { class: 'flex min-h-full flex-col' },
  template: `
    <ng-template appTopBarActions>
      @if (canEdit()) {
        <button hlmBtn size="sm" variant="outline" (click)="newIssue()">
          <svg [lucideIcon]="plus" [size]="14"></svg>
          <span class="max-sm:hidden">New issue</span>
          <app-kbd keys="c" class="opacity-70 max-sm:hidden" />
        </button>
      }
    </ng-template>

    <app-page-header title="My Work" [description]="description()">
      <div class="border-b px-4 sm:px-6">
        <div class="flex min-w-0 flex-wrap items-end justify-between gap-x-5 gap-y-2">
          <hlm-tabs [tab]="tab()" (tabActivated)="setTab($event)" class="min-w-0 max-w-full">
            <hlm-tabs-list variant="line" class="-mb-px h-11 max-w-full overflow-x-auto p-0" aria-label="My work sections">
              @for (t of tabs; track t; let n = $index) {
                <button
                  [hlmTabsTrigger]="t"
                  class="shrink-0 gap-2 px-3"
                  [attr.title]="tabHint(t) + ' (' + (n + 1) + ')'"
                >
                  <span class="hidden lg:inline">{{ tabLabel(t) }}</span>
                  <span class="lg:hidden">{{ tabCompactLabel(t) }}</span>
                  <span class="rounded-full bg-muted px-1.5 py-0.5 text-[11px] leading-none tabular-nums">
                    {{ counts()[t] }}
                  </span>
                </button>
              }
            </hlm-tabs-list>
          </hlm-tabs>
          <label
            class="text-muted-foreground hover:text-foreground flex min-h-11 cursor-pointer items-center gap-2 pb-0.5 text-xs select-none"
            title="Include done, shipped and cancelled items in these lists"
          >
            <input type="checkbox" class="accent-primary size-3.5" [checked]="showClosed()" (change)="showClosed.set($any($event.target).checked)" />
            Show closed
          </label>
        </div>
        <p class="text-muted-foreground pb-3 pt-2 text-xs">{{ tabHint(tab()) }}</p>
      </div>
    </app-page-header>

    @if (waiting().total > 0) {
      <section class="border-b px-4 py-4 sm:px-6" aria-labelledby="my-work-attention-title">
        <div class="mb-3 flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 id="my-work-attention-title" class="text-sm font-medium">Needs your attention</h2>
            <p class="text-muted-foreground mt-1 text-xs">
              {{ waiting().total }} {{ waiting().total === 1 ? 'item needs' : 'items need' }} a response from you
            </p>
          </div>
          <a
            [routerLink]="['/', slug(), 'attention']"
            class="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-xs font-medium focus-visible:outline-2 focus-visible:outline-ring"
          >
            Review attention queue <svg [lucideIcon]="arrow" [size]="13"></svg>
          </a>
        </div>
        <div class="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
          @for (k of waiting().kinds; track k.kind) {
            <div class="bg-card flex min-h-14 items-center gap-3 rounded-lg border px-3 py-2">
              <svg [lucideIcon]="k.icon" [size]="16" [class]="k.color"></svg>
              <span class="text-base font-semibold tabular-nums">{{ k.count }}</span>
              <span class="text-muted-foreground text-xs leading-tight">{{ k.label }}</span>
            </div>
          }
        </div>
      </section>
    }

    @if (week(); as w) {
      <section class="border-b px-4 py-4 sm:px-6" aria-labelledby="my-work-week-title">
        <div class="mb-3 flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 id="my-work-week-title" class="text-sm font-medium">This week</h2>
            <p class="text-muted-foreground mt-1 text-xs">Last 7 days compared with the previous 7 days</p>
          </div>
          <a
            [routerLink]="['/', slug(), 'stats']"
            [queryParams]="{ scope: 'estimates', person: 'me' }"
            class="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-xs font-medium focus-visible:outline-2 focus-visible:outline-ring"
          >
            Personal insights <svg [lucideIcon]="arrow" [size]="13"></svg>
          </a>
        </div>
        <div class="grid grid-cols-2 gap-2 lg:grid-cols-4">
          <div class="bg-card min-h-20 rounded-lg border px-3 py-2.5">
            <p class="text-muted-foreground text-xs">Issues completed</p>
            <div class="mt-1 flex items-baseline gap-2">
              <span class="text-lg font-semibold tabular-nums">{{ w.doneThis }}</span>
              <span class="text-muted-foreground text-xs tabular-nums" [class.text-tone-green]="w.doneThis > w.doneLast" [class.text-tone-red]="w.doneThis < w.doneLast">
                {{ w.doneThis >= w.doneLast ? '+' : '−' }}{{ abs(w.doneThis - w.doneLast) }} vs last week
              </span>
            </div>
          </div>
          <div class="bg-card min-h-20 rounded-lg border px-3 py-2.5">
            <p class="text-muted-foreground text-xs">Estimate points completed</p>
            <div class="mt-1 flex items-baseline gap-2">
              <span class="text-lg font-semibold tabular-nums">{{ w.pointsThis }}</span>
              <span class="text-muted-foreground text-xs tabular-nums">{{ w.pointsLast }} last week</span>
            </div>
          </div>
          <div class="bg-card min-h-20 rounded-lg border px-3 py-2.5" title="Median time from issue start to completion">
            <p class="text-muted-foreground text-xs">Typical time to finish</p>
            <p class="mt-1 text-lg font-semibold tabular-nums">{{ w.medianCycle === undefined ? '—' : fmtDays(w.medianCycle) }}</p>
            <p class="text-muted-foreground text-[11px]">Completed issues this week</p>
          </div>
          <div class="bg-card min-h-20 rounded-lg border px-3 py-2.5" [attr.title]="w.draggingTitle">
            <p class="text-muted-foreground text-xs">Issues past typical time</p>
            <div class="mt-1 flex items-baseline gap-2">
              <span class="text-lg font-semibold tabular-nums" [class.text-tone-amber]="w.dragging > 0">{{ w.dragging }}</span>
              <span class="text-muted-foreground text-xs">active issues</span>
            </div>
          </div>
        </div>
      </section>
    }

    @switch (tab()) {
      @case ('assigned') {
        @if (issueGroups().length) {
          @for (g of issueGroups(); track g.status) {
            <ng-container *ngTemplateOutlet="groupHeader; context: { $implicit: g, entity: 'issue' }" />
            @if (!isFolded('i:' + g.status)) {
              @for (i of g.items; track i.id) {
                <app-my-issue-row [issue]="i" [focused]="ui.focusedRowId() === i.id" />
              }
            }
          }
        } @else {
          <app-empty-state
            class="m-auto"
            [icon]="inbox"
            title="No issues assigned to you"
            description="Issues are demand: a bug, request or incident. Pick something up from the backlog, or report what you have noticed."
          >
            <div class="flex flex-wrap justify-center gap-2">
              <a hlmBtn size="sm" variant="outline" [routerLink]="['/', slug(), 'issues']" [queryParams]="{ status: 'backlog' }">Browse backlog</a>
              @if (canEdit()) {
                <button hlmBtn size="sm" variant="ghost" (click)="newIssue()">New issue</button>
              }
            </div>
          </app-empty-state>
        }
      }

      @case ('accountable') {
        @if (accountableGroups().length) {
          @for (g of accountableGroups(); track g.status) {
            <ng-container *ngTemplateOutlet="groupHeader; context: { $implicit: g, entity: 'workstream' }" />
            @if (!isFolded('a:' + g.status)) {
              @for (r of g.items; track r.ws.id) {
                <app-my-workstream-row [ws]="r.ws" [reasons]="r.reasons" [focused]="ui.focusedRowId() === r.ws.id" />
              }
            }
          }
        } @else {
          <app-empty-state
            class="m-auto"
            [icon]="inbox"
            title="You are not accountable for any workstream"
            description="A workstream is an outcome that resolves one or more issues. The accountable person makes sure it lands."
          >
            <div class="flex flex-wrap justify-center gap-2">
              <a hlmBtn size="sm" variant="outline" [routerLink]="['/', slug(), 'workstreams']">Browse workstreams</a>
              @if (canEdit()) {
                <button hlmBtn size="sm" variant="ghost" (click)="newWorkstream()">New workstream</button>
              }
            </div>
          </app-empty-state>
        }
      }

      @case ('contributing') {
        @if (contributingGroups().length) {
          @for (g of contributingGroups(); track g.status) {
            <ng-container *ngTemplateOutlet="groupHeader; context: { $implicit: g, entity: 'workstream' }" />
            @if (!isFolded('c:' + g.status)) {
              @for (r of g.items; track r.ws.id) {
                <app-my-workstream-row [ws]="r.ws" [reasons]="r.reasons" [focused]="ui.focusedRowId() === r.ws.id" />
              }
            }
          }
        } @else {
          <app-empty-state
            class="m-auto"
            [icon]="inbox"
            title="Nothing you contribute to yet"
            description="Workstreams show up here when one of your teams takes part, an issue assigned to you is linked to them, or you authored one of their artifacts."
          />
        }
      }

      @case ('created') {
        @if (created().issues.length || created().workstreams.length || created().decisions.length) {
          @if (created().issues.length) {
            <ng-container *ngTemplateOutlet="sectionHeader; context: { $implicit: 'Issues', count: created().issues.length, key: 'ci' }" />
            @if (!isFolded('ci')) {
              @for (i of created().issues; track i.id) {
                <app-my-issue-row [issue]="i" [focused]="ui.focusedRowId() === i.id" />
              }
            }
          }
          @if (created().workstreams.length) {
            <ng-container *ngTemplateOutlet="sectionHeader; context: { $implicit: 'Workstreams', count: created().workstreams.length, key: 'cw' }" />
            @if (!isFolded('cw')) {
              @for (w of created().workstreams; track w.id) {
                <app-my-workstream-row [ws]="w" [focused]="ui.focusedRowId() === w.id" />
              }
            }
          }
          @if (created().decisions.length) {
            <ng-container *ngTemplateOutlet="sectionHeader; context: { $implicit: 'Decisions', count: created().decisions.length, key: 'cd' }" />
            @if (!isFolded('cd')) {
              @for (d of created().decisions; track d.id) {
                <a
                  [routerLink]="['/', slug(), 'decisions', d.key]"
                  [attr.data-row-id]="d.id"
                  [attr.data-focused]="ui.focusedRowId() === d.id ? '' : null"
                  class="hover:bg-hover data-[focused]:bg-accent/70 border-border/60 flex h-9 items-center gap-2.5 border-b px-4 outline-none sm:px-6"
                >
                  <span class="inline-flex size-4 items-center justify-center"><app-status-icon entity="other" [status]="d.status" /></span>
                  <span class="text-muted-foreground w-[4.25rem] shrink-0 truncate font-mono text-[11px]">{{ d.key }}</span>
                  <span class="min-w-0 flex-1 truncate text-sm">{{ d.title }}</span>
                  <span class="text-meta">{{ label(d.status) }}</span>
                  <span class="text-meta w-16 text-end">{{ d.updatedAt | relativeTime }}</span>
                </a>
              }
            }
          }
        } @else {
          <app-empty-state
            class="m-auto"
            [icon]="scale"
            title="You have not created anything yet"
            description="Issues you report, workstreams you start and decisions you propose are collected here."
          />
        }
      }
    }

    <ng-template #groupHeader let-g let-entity="entity">
      @let key = foldKey(g.status);
      <button
        type="button"
        class="bg-muted/40 hover:bg-muted/70 sticky top-0 z-[1] flex h-9 w-full items-center gap-2 border-b px-4 text-left text-xs sm:px-6"
        [attr.aria-expanded]="!isFolded(key)"
        (click)="toggleFold(key)"
      >
        <span class="inline-flex shrink-0 transition-transform" [class.rotate-90]="!isFolded(key)"><svg [lucideIcon]="chevron" [size]="12" class="text-muted-foreground"></svg></span>
        <app-status-icon [entity]="asEntity(entity)" [status]="g.status" />
        <span class="font-medium">{{ g.label }}</span>
        <span class="text-muted-foreground tabular-nums">{{ g.items.length }}</span>
      </button>
    </ng-template>

    <ng-template #sectionHeader let-title let-count="count" let-key="key">
      <button
        type="button"
        class="bg-muted/40 hover:bg-muted/70 sticky top-0 z-[1] flex h-9 w-full items-center gap-2 border-b px-4 text-left text-xs sm:px-6"
        [attr.aria-expanded]="!isFolded(key)"
        (click)="toggleFold(key)"
      >
        <span class="inline-flex shrink-0 transition-transform" [class.rotate-90]="!isFolded(key)"><svg [lucideIcon]="chevron" [size]="12" class="text-muted-foreground"></svg></span>
        <span class="font-medium">{{ title }}</span>
        <span class="text-muted-foreground tabular-nums">{{ count }}</span>
      </button>
    </ng-template>
  `,
})
export class MyWorkPage {
  readonly workspaceSlug = input<string>();
  /** `?tab=` query param. */
  readonly tabParam = input<string | undefined>(undefined, { alias: 'tab' });

  protected readonly store = inject(NablaStore);
  protected readonly ui = inject(UiStore);
  private readonly router = inject(Router);

  protected readonly plus = LucidePlus;
  protected readonly arrow = LucideArrowRight;
  protected readonly inbox = LucideInbox;
  protected readonly scale = LucideScale;
  protected readonly check = LucideCheckCheck;
  protected readonly chevron = LucideChevronRight;
  protected readonly tabs = TABS;
  protected readonly label = (s: AnyStatus) => statusLabel(s);

  protected readonly slug = computed(() => this.workspaceSlug() ?? this.store.slug() ?? '');
  protected readonly canEdit = computed(() => this.store.can('member'));
  protected readonly tab = signal<Tab>('assigned');
  protected readonly showClosed = signal(false);
  private readonly folded = signal<ReadonlySet<string>>(new Set());

  constructor() {
    this.ui.setFocusedRow(null);
    effect(() => {
      const t = this.tabParam();
      if (t && (TABS as string[]).includes(t)) untracked(() => this.tab.set(t as Tab));
    });
    usePageShortcuts(
      TABS.map((t, i) => ({
        keys: String(i + 1),
        label: `Show “${this.tabLabel(t)}”`,
        run: () => this.setTab(t),
      })),
    );
  }

  private readonly meId = computed(() => this.store.me()?.id ?? '');

  // ── assigned issues ──
  private readonly assigned = computed(() => {
    const me = this.meId();
    return me ? this.store.issues().filter((i) => i.assigneeId === me) : [];
  });
  protected readonly issueGroups = computed(() => this.groupIssues(this.assigned()));

  // ── accountable workstreams ──
  private readonly accountable = computed<WsItem[]>(() => this.store.myWorkstreams().map((ws) => ({ ws, reasons: [] })));
  protected readonly accountableGroups = computed(() => this.groupWorkstreams(this.accountable()));

  // ── contributing workstreams ──
  private readonly contributing = computed<WsItem[]>(() => {
    const me = this.meId();
    if (!me) return [];
    const myTeams = this.store.myTeamIds();
    const myIssuesByWs = new Map<string, number>();
    for (const i of this.assigned()) for (const w of i.workstreamIds) myIssuesByWs.set(w, (myIssuesByWs.get(w) ?? 0) + 1);
    const authored = new Set(
      this.store
        .artifacts()
        .filter((a) => a.authorRef?.type === 'user' && a.authorRef.id === me)
        .map((a) => a.workstreamId),
    );
    const out: WsItem[] = [];
    for (const ws of this.store.workstreams()) {
      if (ws.accountableUserId === me) continue;
      const reasons: string[] = [];
      const teams = [ws.ownerTeamId, ...ws.participatingTeamIds].filter((t) => myTeams.has(t));
      if (teams.length) {
        const keys = teams.map((t) => this.store.getTeam(t)?.key).filter(Boolean);
        reasons.push(`${keys.slice(0, 2).join(', ')} team${keys.length > 1 ? 's' : ''}`);
      }
      const n = myIssuesByWs.get(ws.id);
      if (n) reasons.push(`${n} of your issue${n === 1 ? '' : 's'}`);
      if (authored.has(ws.id)) reasons.push('your artifacts');
      if (reasons.length) out.push({ ws, reasons });
    }
    return out;
  });
  protected readonly contributingGroups = computed(() => this.groupWorkstreams(this.contributing()));

  // ── created by me ──
  protected readonly created = computed(() => {
    const me = this.meId();
    const closed = !this.showClosed();
    const newest = <T extends { createdAt: string }>(a: T, b: T) => b.createdAt.localeCompare(a.createdAt);
    if (!me) return { issues: [] as Issue[], workstreams: [] as Workstream[], decisions: [] as Decision[] };
    return {
      issues: this.store
        .issues()
        .filter((i) => i.reporterId === me && !(closed && CLOSED.has(i.status)))
        .sort(newest),
      workstreams: this.store
        .workstreams()
        .filter((w) => w.createdById === me && !(closed && CLOSED.has(w.status)))
        .sort(newest),
      decisions: this.store
        .decisions()
        .filter((d) => d.proposedBy.type === 'user' && d.proposedBy.id === me)
        .sort(newest),
    };
  });

  protected readonly counts = computed<Record<Tab, number>>(() => {
    const open = (s: string) => !CLOSED.has(s);
    const c = this.created();
    return {
      assigned: this.assigned().filter((i) => open(i.status)).length,
      accountable: this.accountable().filter((r) => open(r.ws.status)).length,
      contributing: this.contributing().filter((r) => open(r.ws.status)).length,
      created:
        c.issues.filter((i) => open(i.status)).length +
        c.workstreams.filter((w) => open(w.status)).length +
        c.decisions.filter((d) => d.status === 'proposed').length,
    };
  });

  protected readonly waiting = computed(() => {
    const counts = this.store.attentionCounts();
    const kinds = ATTENTION_KINDS.filter((k) => counts[k] > 0)
      .map((kind: AttentionKind) => ({
        kind,
        count: counts[kind],
        label: ATTENTION_KIND_META[kind].label.toLowerCase(),
        icon: ATTENTION_KIND_VIEW[kind].icon as LucideIcon,
        color: ATTENTION_KIND_VIEW[kind].color,
      }));
    return { total: this.store.attentionCount(), kinds };
  });

  protected readonly abs = Math.abs;
  protected readonly fmtDays = formatDuration;

  /** Last 7 days vs the 7 before, from real start/finish dates; hidden when there is nothing to say. */
  protected readonly week = computed(() => {
    const me = this.meId();
    if (!me) return null;
    const look: Lookup = { user: (id) => this.store.getUser(id)?.name ?? 'Unknown', team: (id) => this.store.getTeam(id)?.name ?? 'No team' };
    const w = weekSummary(buildWork(this.store, this.store.issues(), []).issues, me, Date.now(), this.store.estimateScale(), look);
    const running = this.assigned().some((i) => i.status === 'in_progress' || i.status === 'in_review');
    if (!w.doneThis && !w.doneLast && !running) return null;
    return {
      ...w,
      dragging: w.dragging.length,
      draggingTitle: w.dragging.length
        ? w.dragging.slice(0, 5).map((d) => `${d.key} ${d.title} (${formatDuration(d.age)}, typical up to ${formatDuration(d.p75)})`).join('\n')
        : 'Nothing of yours is running past the typical time for its estimate',
    };
  });

  protected readonly description = computed(() => {
    const c = this.counts();
    return `${c.assigned} open issue${c.assigned === 1 ? '' : 's'} assigned to you · ${c.accountable} workstream${c.accountable === 1 ? '' : 's'} you own`;
  });

  // ── helpers ──

  private groupIssues(list: readonly Issue[]): Group<Issue>[] {
    const show = this.showClosed();
    return ISSUE_ORDER.filter((s) => show || !CLOSED.has(s))
      .map((status) => ({
        status: status as AnyStatus,
        label: ISSUE_STATUS_META[status].label,
        closed: CLOSED.has(status),
        items: list
          .filter((i) => i.status === status)
          .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || b.updatedAt.localeCompare(a.updatedAt)),
      }))
      .filter((g) => g.items.length > 0);
  }

  private groupWorkstreams(list: readonly WsItem[]): Group<WsItem>[] {
    const show = this.showClosed();
    return WS_ORDER.filter((s) => show || !CLOSED.has(s))
      .map((status) => ({
        status: status as AnyStatus,
        label: statusLabel(status),
        closed: CLOSED.has(status),
        items: list
          .filter((r) => r.ws.status === status)
          .sort((a, b) => priorityRank(a.ws.priority) - priorityRank(b.ws.priority) || a.ws.key.localeCompare(b.ws.key)),
      }))
      .filter((g) => g.items.length > 0);
  }

  protected foldKey(status: string): string {
    const prefix = this.tab() === 'assigned' ? 'i' : this.tab() === 'accountable' ? 'a' : 'c';
    return `${prefix}:${status}`;
  }
  protected isFolded(key: string): boolean {
    return this.folded().has(key);
  }
  protected toggleFold(key: string): void {
    this.folded.update((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }
  protected asEntity(e: string): StatusEntity {
    return e === 'issue' ? 'issue' : 'workstream';
  }

  protected tabLabel(t: Tab): string {
    switch (t) {
      case 'assigned':
        return 'Assigned issues';
      case 'accountable':
        return 'Workstreams you own';
      case 'contributing':
        return 'Workstreams you contribute to';
      case 'created':
        return 'Created by you';
    }
  }
  protected tabCompactLabel(t: Tab): string {
    switch (t) {
      case 'assigned':
        return 'Assigned';
      case 'accountable':
        return 'Own';
      case 'contributing':
        return 'Contribute';
      case 'created':
        return 'Created';
    }
  }
  protected tabHint(t: Tab): string {
    switch (t) {
      case 'assigned':
        return 'Open issues assigned to you';
      case 'accountable':
        return 'Open workstreams you are responsible for delivering';
      case 'contributing':
        return 'Open workstreams linked to your teams, issues or contributions';
      case 'created':
        return 'Open issues, workstreams and decisions you created';
    }
  }

  protected setTab(v: unknown): void {
    const t = (TABS as unknown[]).includes(v) ? (v as Tab) : 'assigned';
    this.tab.set(t);
    this.ui.setFocusedRow(null);
    void this.router.navigate([], { queryParams: { tab: t === 'assigned' ? null : t }, queryParamsHandling: 'merge', replaceUrl: true });
  }

  protected newIssue(): void {
    const me = this.meId();
    this.ui.openCreate('issue', me ? { assigneeId: me, status: 'todo' } : {});
  }
  protected newWorkstream(): void {
    const me = this.meId();
    this.ui.openCreate('workstream', me ? { accountableUserId: me } : {});
  }
}

function priorityRank(p: string): number {
  return ({ urgent: 0, high: 1, medium: 2, low: 3, none: 4 } as Record<string, number>)[p] ?? 5;
}
