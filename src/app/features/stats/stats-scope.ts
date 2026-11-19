import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { format, subDays } from 'date-fns';
import { ISSUE_STATUS_META, TimeEntriesStore, TramaStore, type Issue, type Project } from '../../core';
import type { Option } from '../../shared/app-select';
import { DEFAULT_IDLE_DAYS, IDLE_CHOICES, activityLookup, trackedByIssue } from './flow-stats';
import { staleTasks } from './stats-work';
import {
  DATE_KEY,
  DEFAULT_PERIOD,
  PERIOD_CHOICES,
  buckets,
  previousRange,
  resolveRange,
  sampleTimes,
  type PeriodId,
} from './stats-range';
import { mySpans } from './stats-time';

export const TABS = ['flow', 'work', 'time', 'projects', 'people'] as const;
export type StatsTab = (typeof TABS)[number];
export const TAB_LABEL: Record<StatsTab, string> = {
  flow: 'Flow',
  work: 'Work',
  time: 'Time',
  projects: 'Projects',
  people: 'People',
};
export const TAB_HINT: Record<StatsTab, string> = {
  flow: 'How much gets created and closed, and how long it takes',
  work: 'What is open today, how old it is and what has gone stale',
  time: 'The time you tracked with the timer, against your estimates',
  projects: 'Progress, projected end dates and milestones',
  people: 'Who has what, and who closed what',
};

/**
 * The period, project and stale-after choice every tab shares, kept in the address (`?tab=flow&period=90d&project=…`) so a
 * view can be linked. Provided by the page, so each tab reads the same numbers.
 */
@Injectable()
export class StatsScope {
  readonly store = inject(TramaStore);
  private readonly timeStore = inject(TimeEntriesStore);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly query = toSignal(this.route.queryParamMap, { initialValue: this.route.snapshot.queryParamMap });

  /** Re-read once a minute so "idle for" and the newest bar do not go stale in a tab left open. */
  readonly now = signal(Date.now());

  constructor() {
    void this.timeStore.load();
    const tick = setInterval(() => this.now.set(Date.now()), 60_000);
    inject(DestroyRef).onDestroy(() => clearInterval(tick));
  }

  // ── what the address says
  readonly tab = computed<StatsTab>(() => {
    const t = this.query().get('tab');
    return (TABS as readonly string[]).includes(t ?? '') ? (t as StatsTab) : 'flow';
  });
  readonly periodId = computed<PeriodId>(() => {
    const p = this.query().get('period');
    return PERIOD_CHOICES.some((x) => x.id === p) ? (p as PeriodId) : DEFAULT_PERIOD;
  });
  readonly fromKey = computed(() => this.query().get('from') ?? format(subDays(this.now(), 29), DATE_KEY));
  readonly toKey = computed(() => this.query().get('to') ?? format(this.now(), DATE_KEY));
  readonly idleDays = computed(() => {
    const d = Number(this.query().get('idle'));
    return (IDLE_CHOICES as readonly number[]).includes(d) ? d : DEFAULT_IDLE_DAYS;
  });
  readonly projectId = computed(() => {
    const id = this.query().get('project');
    return id && this.store.getProject(id) ? id : null;
  });

  // ── the period
  readonly range = computed(() => resolveRange(this.periodId(), this.now(), this.fromKey(), this.toKey()));
  readonly prevRange = computed(() => previousRange(this.range()));
  /** Buckets for counts of tasks: a bar per day up to two weeks, then per week. */
  readonly bucketSet = computed(() => buckets(this.range(), 14));
  /** Buckets for tracked time: a bar per day up to a month, then per week. */
  readonly timeBucketSet = computed(() => buckets(this.range(), 31));
  /** Moments (end of day) the "over time" charts are sampled at. */
  readonly times = computed(() => sampleTimes(this.range(), this.now()));

  // ── the data
  readonly slug = computed(() => this.store.slug() ?? '');
  readonly allIssues = this.store.issues;
  /** The tasks the page looks at: all of them, or one project's. */
  readonly issues = computed<readonly Issue[]>(() => {
    const id = this.projectId();
    const all = this.store.issues();
    return id ? all.filter((i) => i.projectId === id) : all;
  });
  readonly projects = computed<readonly Project[]>(() => {
    const id = this.projectId();
    const all = this.store.projects();
    return id ? all.filter((p) => p.id === id) : all;
  });
  readonly projectOptions = computed<Option[]>(() => [
    { value: 'all', label: 'All projects' },
    ...this.store.projects().map((p) => ({ value: p.id, label: p.name })),
  ]);
  readonly idleOptions: Option[] = IDLE_CHOICES.map((d) => ({ value: String(d), label: `${d} days` }));

  /** The entries the API returns are the signed-in person's own: this is "my" tracked time. */
  readonly entries = this.timeStore.entries;
  readonly myId = computed(() => this.store.me()?.id ?? null);
  /** Finished entries of mine, of the chosen project when there is one. */
  readonly spans = computed(() => {
    const byId = this.store.issueById();
    const project = this.projectId();
    const all = mySpans(this.entries(), this.myId(), (e) => e.projectId ?? (e.issueId ? (byId.get(e.issueId)?.projectId ?? null) : null));
    return project ? all.filter((s) => s.projectId === project) : all;
  });
  /** Tracked time per task over everything I tracked. */
  readonly tracked = computed(() => trackedByIssue(this.entries()));
  readonly runningTimers = computed(() => this.entries().filter((e) => !e.endedAt).length);

  readonly activityAt = computed(() =>
    activityLookup({
      events: this.store.eventsBySubject(),
      artifacts: this.store.artifactsByIssue(),
      entries: this.entries(),
      now: this.now(),
    }),
  );
  readonly stale = computed(() => staleTasks(this.issues(), this.now(), this.idleDays(), this.activityAt()));
  /** Ids of stale tasks: they are counted on their own and never enter an average. */
  readonly staleIds = computed<ReadonlySet<string>>(() => new Set(this.stale().map((s) => s.issue.id)));

  // ── names
  readonly estimateScale = this.store.estimateScale;
  statusLabel(status: string): string {
    return ISSUE_STATUS_META[status as keyof typeof ISSUE_STATUS_META]?.label ?? status;
  }
  personName(id: string | undefined): string {
    return id ? (this.store.getUser(id)?.name ?? 'Unknown') : 'Unassigned';
  }
  projectName(id: string | undefined): string {
    return id ? (this.store.getProject(id)?.name ?? 'Unknown project') : 'No project';
  }

  // ── changing the address
  navigate(params: Record<string, string | null>): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: params,
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }
  setTab(tab: string | null | undefined): void {
    if (tab && (TABS as readonly string[]).includes(tab)) this.navigate({ tab: tab === 'flow' ? null : tab });
  }
  setPeriod(id: unknown): void {
    if (!PERIOD_CHOICES.some((x) => x.id === id)) return;
    if (id === 'custom') {
      this.navigate({ period: 'custom', from: this.fromKey(), to: this.toKey() });
    } else {
      this.navigate({ period: id === DEFAULT_PERIOD ? null : (id as string), from: null, to: null });
    }
  }
  setRange(from: string, to: string): void {
    this.navigate({ period: 'custom', from, to });
  }
  setProject(id: string): void {
    this.navigate({ project: !id || id === 'all' ? null : id });
  }
  setIdle(value: string): void {
    this.navigate({ idle: Number(value) === DEFAULT_IDLE_DAYS ? null : value });
  }
}
