import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { format } from 'date-fns';
import { TimeEntriesStore, TramaStore, resolveStatusEntry, statusTypeOf } from '../../core';
import { StatusBar } from '../../layout/status-bar';
import { EmptyState } from '../../shared/empty-state';
import { PageHeader } from '../../shared/page-header';
import { PreviewLink } from '../issues/list-preview';
import { DEFAULT_IDLE_DAYS, activityLookup } from '../stats/flow-stats';
import { OverviewLinks, TONE_VAR } from './overview-links';
import {
  dailyFlow,
  deltaText,
  headline,
  lanes,
  plural,
  projectRows,
  pulse,
  trackScale,
  watchlist,
  weekTotals,
  type HeadlinePart,
  type OverviewContext,
} from './overview-model';
import { OverviewNow } from './overview-now';
import { OverviewProjects } from './overview-projects';
import { OverviewRiver } from './overview-river';
import { OverviewWatch } from './overview-watch';

/**
 * `/:workspace/overview`: the workspace read as a short briefing, top to bottom. A sentence that says where things
 * stand, the few things worth a look, who is on what right now, four weeks of closing and opening as a river, and
 * every project against its target. Everything is clickable: one click previews in the right pane, Enter or a double
 * click opens the full page. The Inbox stays home; this page is for the whole workspace, not just you.
 */
@Component({
  selector: 'app-overview-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    EmptyState,
    OverviewNow,
    OverviewProjects,
    OverviewRiver,
    OverviewWatch,
    PageHeader,
    PreviewLink,
    StatusBar,
  ],
  host: { class: 'block min-h-full' },
  template: `
    <app-page-header title="Overview" description="Where the workspace stands: what moves, what is stuck, what is late" />

    @if (!store.ready()) {
      <p class="text-muted-foreground px-4 py-8 text-sm sm:px-6">Loading…</p>
    } @else if (store.issues().length === 0 && store.projects().length === 0) {
      <app-empty-state
        class="py-16"
        title="Nothing to read yet"
        description="Create a project and a few tasks. The Overview turns them into a weekly briefing."
      />
    } @else {
      <div class="@container">
        <div
          class="mx-auto grid max-w-[74rem] grid-cols-1 gap-x-12 gap-y-10 px-4 pt-5 pb-14 sm:px-6 @5xl:grid-cols-[minmax(0,1fr)_19rem]"
        >
          <!-- 1. the sentence -->
          <section aria-labelledby="ov-pulse" class="@5xl:col-start-1">
            <p class="text-meta mb-2" id="ov-pulse">Workspace pulse · {{ today() }}</p>
            <h2 class="text-[22px] leading-[1.3] font-normal tracking-[-0.01em] text-balance sm:text-[26px]">
              @for (p of headlineParts(); track $index) {
                @if (p.target; as t) {
                  <a
                    [appPreviewLink]="links.route(t)"
                    (preview)="links.show(t)"
                    class="focus-visible:ring-ring/50 rounded-sm underline decoration-[color:var(--border-strong,currentColor)] decoration-dotted underline-offset-[5px] outline-none hover:decoration-solid focus-visible:ring-2"
                    [class.font-medium]="p.strong"
                    [style.color]="p.tone ? tone(p) : ''"
                    >{{ p.text }}</a
                  >
                } @else {
                  <span [class.font-medium]="p.strong" [style.color]="p.tone ? tone(p) : ''">{{ p.text }}</span>
                }
              }
            </h2>
            <p class="text-meta mt-3 flex flex-wrap items-center gap-x-5 gap-y-1">
              <span>
                <span class="text-foreground tabular-nums">{{ pulseNow().closedThisWeek }}</span> closed this week
                <span class="tabular-nums">· {{ delta(pulseNow().closedThisWeek, pulseNow().closedLastWeek) }}</span>
              </span>
              <span>
                <span class="text-foreground tabular-nums">{{ pulseNow().openedThisWeek }}</span> opened
                <span class="tabular-nums">· {{ delta(pulseNow().openedThisWeek, pulseNow().openedLastWeek) }}</span>
              </span>
              @if (pulseNow().waiting) {
                <span><span class="text-foreground tabular-nums">{{ pulseNow().waiting }}</span> waiting to start</span>
              }
            </p>
          </section>

          <!-- 2. worth a look -->
          <section aria-labelledby="ov-watch" class="@5xl:col-start-2 @5xl:row-span-4 @5xl:row-start-1 @5xl:border-s @5xl:ps-8">
            <div class="@5xl:sticky @5xl:top-4">
              <h3 id="ov-watch" class="text-muted-foreground mb-2 text-[13px]">Worth a look</h3>
              <app-overview-watch [items]="watch()" />
            </div>
          </section>

          <!-- 3. now -->
          <section aria-labelledby="ov-now" class="@5xl:col-start-1">
            <h3 id="ov-now" class="text-muted-foreground mb-3 flex items-baseline gap-2 text-[13px]">
              Now
              <span class="text-meta">{{ nowSummary() }}</span>
            </h3>
            <app-overview-now [lanes]="laneList()" [now]="nowMs()" />
          </section>

          <!-- 4. the river -->
          <section aria-labelledby="ov-river" class="@5xl:col-start-1">
            <h3 id="ov-river" class="text-muted-foreground mb-3 text-[13px]">Last four weeks</h3>
            <app-overview-river [days]="flow()" [weeks]="weeks()" />
          </section>

          <!-- 5. projects -->
          <section aria-labelledby="ov-projects" class="@5xl:col-start-1">
            <h3 id="ov-projects" class="text-muted-foreground mb-3 text-[13px]">Projects</h3>
            <app-overview-projects [rows]="rows()" [scale]="scale()" [now]="now()" />
          </section>
        </div>
      </div>
    }

    <app-status-bar>
      <span>{{ plural(openTasks(), 'open task') }}</span>
      <span>{{ plural(rows().length, 'open project') }}</span>
      <span end>Stuck means nothing happened for {{ idleDays }} days</span>
    </app-status-bar>
  `,
})
export class OverviewPage {
  protected readonly store = inject(TramaStore);
  protected readonly links = inject(OverviewLinks);
  private readonly time = inject(TimeEntriesStore);

  protected readonly plural = plural;
  protected readonly idleDays = DEFAULT_IDLE_DAYS;

  /** Refreshed every minute so ages and the running timer stay current. */
  protected readonly now = signal(new Date());
  protected readonly nowMs = computed(() => this.now().getTime());

  constructor() {
    void this.time.load();
    const tick = setInterval(() => this.now.set(new Date()), 60_000);
    inject(DestroyRef).onDestroy(() => clearInterval(tick));
  }

  private readonly context = computed<OverviewContext>(() => {
    const statuses = this.store.settings().statuses;
    const now = this.now();
    return {
      now,
      issues: this.store.issues(),
      projects: this.store.projects(),
      milestones: this.store.milestones(),
      issueType: (s) => statusTypeOf(statuses.issue, s),
      projectType: (s) => statusTypeOf(statuses.project, s),
      issueLabel: (s) => resolveStatusEntry(statuses.issue, s)?.name ?? s,
      activityAt: activityLookup({
        events: this.store.eventsBySubject(),
        artifacts: this.store.artifactsByIssue(),
        entries: this.time.entries(),
        now: now.getTime(),
      }),
      idleDays: DEFAULT_IDLE_DAYS,
      attention: this.store.openAttention(),
      timers: this.time
        .entries()
        .filter((e) => !e.endedAt && e.issueId)
        .map((e) => ({ issueId: e.issueId as string, userId: e.userId, startedAt: e.startedAt })),
    };
  });

  protected readonly flow = computed(() => dailyFlow(this.context()));
  protected readonly weeks = computed(() => weekTotals(this.flow()));
  protected readonly pulseNow = computed(() => pulse(this.context(), this.flow()));
  protected readonly rows = computed(() => projectRows(this.context()));
  protected readonly scale = computed(() => trackScale(this.rows(), this.now()));
  protected readonly laneList = computed(() => lanes(this.context()));
  protected readonly watch = computed(() => watchlist(this.context(), this.rows()));
  protected readonly headlineParts = computed(() => headline(this.pulseNow(), this.rows()));

  protected readonly today = computed(() => format(this.now(), 'EEEE d MMMM'));

  protected readonly openTasks = computed(() => {
    const issues = this.store.issues();
    const types = this.store.settings().statuses.issue;
    return issues.filter((i) => {
      const t = statusTypeOf(types, i.status);
      return t !== 'done' && t !== 'canceled';
    }).length;
  });

  protected readonly nowSummary = computed(() => {
    const p = this.pulseNow();
    const total = p.moving + p.stuck;
    if (total === 0) return '';
    return `${plural(total, 'task')} in progress${p.stuck ? `, ${p.stuck} quiet` : ''}`;
  });

  protected tone(p: HeadlinePart): string {
    return p.tone ? TONE_VAR[p.tone] : '';
  }

  protected delta(now: number, before: number): string {
    return deltaText(now, before);
  }
}
