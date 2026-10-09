import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideDynamicIcon, LucideX } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { format } from 'date-fns';
import { ISSUE_STATUS_META, type DurationStats, type FlowDuration, type InsightItem, type InsightWipRow, type InsightsReport } from '../../core';
import { BarList, type BarRow } from './charts/bar-list';
import { ChartCard } from './charts/chart-card';
import type { ChartSeries } from './charts/chart-utils';
import { KpiTile, type KpiDelta } from './charts/kpi-tile';
import { TimeChart } from './charts/time-chart';
import { InsightItems } from './insight-items';
import { formatAge } from './insights-model';
import { pctDelta } from './insights';
import { ISSUE_COLOR } from './stats-colors';

export type FlowDrill = 'cycle' | 'lead' | 'workstream' | 'aging';

interface Tile {
  /** Tiles with a drill open the items behind the number. */
  drill?: FlowDrill;
  label: string;
  value: string;
  hint: string;
  delta?: KpiDelta;
}

/** Few samples make percentiles shaky: say so instead of presenting them as solid. */
const MIN_SAMPLES = 5;

/**
 * How work flows: cycle and lead time (p50/p85), throughput, aging work in progress, WIP per person
 * and agent, and the cumulative flow of issues per status. Tiles open the items behind them.
 */
@Component({
  selector: 'app-flow-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, LucideDynamicIcon, HlmButtonImports, BarList, ChartCard, InsightItems, KpiTile, TimeChart],
  host: { class: 'flex flex-col gap-6' },
  template: `
    <ul class="grid grid-cols-[repeat(auto-fit,minmax(10.5rem,1fr))] gap-3" aria-label="Flow figures">
      @for (t of tiles(); track t.label) {
        <li class="flex">
          @if (t.drill; as id) {
            <button
              type="button"
              class="focus-visible:ring-ring/50 flex w-full rounded-lg text-start outline-none focus-visible:ring-2"
              [attr.aria-pressed]="drill() === id"
              [attr.aria-label]="t.label + ': ' + t.value + '. Show the items behind it'"
              (click)="toggle(id)"
            >
              <app-kpi-tile
                class="hover:bg-hover w-full transition-colors"
                [class.ring-2]="drill() === id"
                [class.ring-ring]="drill() === id"
                [label]="t.label"
                [value]="t.value"
                [delta]="t.delta"
                [hint]="t.hint"
              />
            </button>
          } @else {
            <app-kpi-tile class="w-full" [label]="t.label" [value]="t.value" [delta]="t.delta" [hint]="t.hint" />
          }
        </li>
      }
    </ul>

    @if (drillView(); as d) {
      <section class="bg-card rounded-lg border p-4" [attr.aria-label]="d.title">
        <header class="mb-1 flex items-start gap-2">
          <div class="min-w-0 flex-1">
            <h3 class="text-sm font-medium">{{ d.title }}</h3>
            <p class="text-meta mt-0.5 text-[11px]">{{ d.subtitle }}</p>
          </div>
          <button hlmBtn variant="ghost" size="icon-sm" aria-label="Close the list" (click)="toggle(d.id)">
            <svg [lucideIcon]="closeIcon" [size]="14"></svg>
          </button>
        </header>
        <app-insight-items [items]="d.items" [slug]="slug()" [empty]="d.empty" />
      </section>
    }

    <div class="grid gap-4 lg:grid-cols-3">
      <app-chart-card
        class="lg:col-span-2"
        title="Throughput"
        [subtitle]="throughputSubtitle()"
        [empty]="throughputEmpty() ? 'Nothing was finished in this range.' : undefined"
      >
        <app-time-chart mode="bars" [series]="throughput().series" [labels]="throughput().labels" [tooltipTitles]="throughput().titles" ariaLabel="Issues done and workstreams shipped over time" />
      </app-chart-card>

      <app-chart-card
        title="How long work takes"
        [subtitle]="durationSubtitle()"
        [note]="sampleNote()"
        [empty]="histogramEmpty() ? 'No finished issues in this range.' : undefined"
      >
        <app-time-chart mode="bars" [series]="histogram().series" [labels]="histogram().labels" [tooltipTitles]="histogram().titles" [height]="170" ariaLabel="Finished issues by cycle and lead time" />
      </app-chart-card>
    </div>

    <div class="grid gap-4 lg:grid-cols-2">
      <app-chart-card
        title="Aging work in progress"
        [subtitle]="agingSubtitle()"
        [note]="agingNote()"
        [empty]="r().flow.aging.items.length ? undefined : 'No issue is in progress or in review.'"
      >
        <ul class="flex flex-col" aria-label="Issues in progress by age">
          @for (a of agingRows(); track a.id) {
            <li>
              <a
                [routerLink]="a.link"
                class="hover:bg-hover focus-visible:ring-ring/50 -mx-2 grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)_4.5rem] items-center gap-3 rounded-md px-2 py-1.5 text-xs outline-none focus-visible:ring-2"
                [attr.title]="a.detail"
              >
                <span class="flex min-w-0 items-baseline gap-1.5">
                  <span class="text-meta shrink-0 font-mono text-[10px]">{{ a.key }}</span>
                  <span class="truncate">{{ a.title }}</span>
                </span>
                <span class="border-border-strong relative h-4 border-s">
                  <span class="absolute inset-y-[5px] start-0 rounded-e-[4px]" [style.width.%]="a.width" [style.min-width.px]="3" [style.background]="a.color"></span>
                  @if (a.baselineAt !== null) {
                    <span class="border-foreground/50 absolute inset-y-0 border-s border-dashed" [style.inset-inline-start.%]="a.baselineAt" aria-hidden="true"></span>
                  }
                </span>
                <span class="text-end tabular-nums">
                  <span class="font-medium">{{ a.age }}</span>
                  @if (a.over) {
                    <span class="text-tone-red block text-[10px]">over p85</span>
                  }
                </span>
              </a>
            </li>
          }
        </ul>
      </app-chart-card>

      <app-chart-card
        title="Work in progress per person"
        [subtitle]="'Issues in progress or review, and workstreams a person is accountable for (limits ' + r().flow.wip.limits.issues + ' and ' + r().flow.wip.limits.workstreams + ')'"
        [empty]="peopleIssueRows().length || peopleWsRows().length ? undefined : 'Nobody has work in progress.'"
      >
        <h4 class="text-muted-foreground mb-1 text-xs">Issues</h4>
        <app-bar-list [rows]="peopleIssueRows()" [interactive]="true" empty="No issues in progress." ariaLabel="Issues in progress per person" (rowClick)="pickWip($event)" />
        <h4 class="text-muted-foreground mt-4 mb-1 text-xs">Workstreams</h4>
        <app-bar-list [rows]="peopleWsRows()" [interactive]="true" defaultColor="var(--chart-2)" empty="No accountable workstreams in flight." ariaLabel="Workstreams in flight per accountable person" (rowClick)="pickWip($event)" />
      </app-chart-card>
    </div>

    @if (wipView(); as w) {
      <section class="bg-card rounded-lg border p-4" [attr.aria-label]="'Work in progress of ' + w.actor.name">
        <header class="mb-1 flex items-start gap-2">
          <div class="min-w-0 flex-1">
            <h3 class="text-sm font-medium">{{ w.actor.name }}</h3>
            <p class="text-meta mt-0.5 text-[11px]">
              {{ w.issues }} issues in progress or review · {{ w.workstreams }} workstreams in flight@if (w.overloaded) { · over the limit }
            </p>
          </div>
          <button hlmBtn variant="ghost" size="icon-sm" aria-label="Close the list" (click)="wipWho.set(null)">
            <svg [lucideIcon]="closeIcon" [size]="14"></svg>
          </button>
        </header>
        <app-insight-items [items]="w.items" [slug]="slug()" [showWaiting]="false" />
      </section>
    }

    <div class="grid gap-4 lg:grid-cols-3">
      <app-chart-card
        class="lg:col-span-2"
        title="Cumulative flow"
        subtitle="Issues by status at the end of each day, canceled and draft excluded"
        [note]="cfdNote"
        [empty]="cfdEmpty() ? 'No issues to chart yet.' : undefined"
      >
        <app-time-chart mode="stacked" [series]="cfd().series" [labels]="cfd().labels" [tooltipTitles]="cfd().titles" ariaLabel="Issues by status over time" />
      </app-chart-card>

      <app-chart-card
        title="Agents at work"
        subtitle="Open workstreams an agent touched in the last 7 days"
        [note]="'Agents are actors, not assignees: this is activity, not assignment.'"
        [empty]="agentRows().length ? undefined : 'No agent touched a workstream in flight this week.'"
      >
        <app-bar-list [rows]="agentRows()" defaultColor="var(--chart-4)" ariaLabel="Workstreams touched per agent" />
      </app-chart-card>
    </div>
  `,
})
export class FlowView {
  readonly report = input.required<InsightsReport>();
  readonly slug = input.required<string>();
  readonly drillChange = output<FlowDrill | null>();
  readonly drillId = input<FlowDrill | null>(null, { alias: 'drill' });

  protected readonly closeIcon = LucideX;
  protected readonly cfdNote = 'Counts rebuild each status from the activity log. Issues finished before the log starts sit in Done.';

  protected readonly r = computed(() => this.report());
  protected readonly drill = computed(() => this.drillId());

  /** A person's WIP opened from the charts. A peek, not part of the URL. */
  protected readonly wipWho = signal<string | null>(null);

  protected readonly tiles = computed<Tile[]>(() => {
    const f = this.report().flow;
    const thisDone = f.throughput.reduce((n, b) => n + b.issuesDone, 0);
    const thisShipped = f.throughput.reduce((n, b) => n + b.workstreamsShipped, 0);
    const over = f.aging.items.filter((i) => i.overBaseline).length;
    const against = `vs the previous ${this.report().range.days} days`;
    const stat = (d: FlowDuration, noun: string) =>
      d.stats.count ? `p85 ${this.fmt(d.stats.p85)} · ${d.stats.count} ${noun}` : `no ${noun} in range`;
    return [
      { drill: 'cycle', label: 'Cycle time (median)', value: this.fmt(f.issueCycle.stats.p50), hint: stat(f.issueCycle, 'issues'), delta: this.durationDelta(f.issueCycle, against) },
      { drill: 'lead', label: 'Lead time (median)', value: this.fmt(f.issueLead.stats.p50), hint: stat(f.issueLead, 'issues'), delta: this.durationDelta(f.issueLead, against) },
      { drill: 'workstream', label: 'Workstream lead time', value: this.fmt(f.workstreamLead.stats.p50), hint: stat(f.workstreamLead, 'workstreams'), delta: this.durationDelta(f.workstreamLead, against) },
      {
        drill: 'aging',
        label: 'Slow work in progress',
        value: f.aging.baselineDays === undefined ? '—' : String(over),
        hint: f.aging.baselineDays === undefined ? `needs ${MIN_SAMPLES} finished issues` : `older than p85 (${formatAge(f.aging.baselineDays)})`,
      },
      {
        label: 'Issues done',
        value: String(thisDone),
        hint: thisShipped ? `${thisShipped} workstreams shipped` : 'no workstream shipped',
        delta: pctDelta(thisDone, f.previousThroughput.issuesDone, 'up', against),
      },
    ];
  });

  protected readonly drillView = computed(() => {
    const id = this.drill();
    const f = this.report().flow;
    switch (id) {
      case 'cycle':
        return { id, title: 'Slowest finished issues (cycle time)', subtitle: 'Started to done, longest first: what stretches the tail.', items: f.issueCycle.slowest, empty: 'No finished issues in this range.' };
      case 'lead':
        return { id, title: 'Slowest finished issues (lead time)', subtitle: 'Created to done, longest first.', items: f.issueLead.slowest, empty: 'No finished issues in this range.' };
      case 'workstream':
        return { id, title: 'Slowest shipped workstreams', subtitle: 'Created to shipped, longest first.', items: f.workstreamLead.slowest, empty: 'No workstream shipped in this range.' };
      case 'aging':
        return { id, title: 'Oldest work in progress', subtitle: 'Issues in progress or review, longest first.', items: f.aging.items as InsightItem[], empty: 'No issue is in progress.' };
      default:
        return null;
    }
  });

  protected readonly throughput = computed(() => {
    const t = this.report().flow.throughput;
    const weekly = this.report().range.days > 30;
    const series: ChartSeries[] = [
      { key: 'issues', label: 'Issues done', color: 'var(--chart-2)', values: t.map((b) => b.issuesDone) },
      { key: 'workstreams', label: 'Workstreams shipped', color: 'var(--chart-1)', values: t.map((b) => b.workstreamsShipped) },
    ];
    return {
      series,
      labels: t.map((b) => format(new Date(b.start), 'MMM d')),
      titles: t.map((b) => (weekly ? `${format(new Date(b.start), 'MMM d')} – ${format(new Date(new Date(b.end).getTime() - 1), 'MMM d')}` : format(new Date(b.start), 'EEE, MMM d'))),
    };
  });
  protected readonly throughputEmpty = computed(() => this.throughput().series.every((s) => s.values.every((v) => !v)));
  protected readonly throughputSubtitle = computed(() => {
    const t = this.report().flow.throughput;
    return `${this.report().range.days > 30 ? 'Per week' : 'Per day'}, last ${this.report().range.days} days · ${t.reduce((n, b) => n + b.issuesDone, 0)} issues done`;
  });

  protected readonly histogram = computed(() => {
    const f = this.report().flow;
    return {
      labels: f.issueCycle.histogram.map((b) => b.label),
      titles: f.issueCycle.histogram.map((b) => `Finished in ${b.label}`),
      series: [
        { key: 'cycle', label: 'Cycle (started to done)', color: 'var(--chart-1)', values: f.issueCycle.histogram.map((b) => b.count) },
        { key: 'lead', label: 'Lead (created to done)', color: 'var(--chart-2)', values: f.issueLead.histogram.map((b) => b.count) },
      ] as ChartSeries[],
    };
  });
  protected readonly histogramEmpty = computed(() => this.histogram().series.every((s) => s.values.every((v) => !v)));
  protected readonly durationSubtitle = computed(() => {
    const f = this.report().flow;
    const c = f.issueCycle.stats;
    const l = f.issueLead.stats;
    return [c.count ? `cycle p50 ${this.fmt(c.p50)} · p85 ${this.fmt(c.p85)}` : '', l.count ? `lead p50 ${this.fmt(l.p50)} · p85 ${this.fmt(l.p85)}` : ''].filter(Boolean).join('  |  ') || 'Finished issues by duration';
  });
  protected readonly sampleNote = computed(() => {
    const n = Math.max(this.report().flow.issueCycle.stats.count, this.report().flow.issueLead.stats.count);
    return n > 0 && n < MIN_SAMPLES ? `Only ${n} finished ${n === 1 ? 'issue' : 'issues'} in this range: the percentiles are indicative, not solid.` : undefined;
  });

  protected readonly agingRows = computed(() => {
    const aging = this.report().flow.aging;
    const max = Math.max(1, aging.baselineDays ? aging.baselineDays * 1.15 : 0, ...aging.items.map((i) => i.inProgressDays));
    return aging.items.map((i) => ({
      id: i.id,
      key: i.key ?? '',
      title: i.title,
      detail: i.detail,
      link: ['/', this.slug(), 'issues', i.key ?? i.id],
      width: (i.inProgressDays / max) * 100,
      baselineAt: aging.baselineDays === undefined ? null : (aging.baselineDays / max) * 100,
      age: formatAge(i.inProgressDays),
      over: i.overBaseline,
      color: i.overBaseline ? 'var(--tone-red)' : 'var(--chart-1)',
    }));
  });
  protected readonly agingSubtitle = computed(() => {
    const a = this.report().flow.aging;
    return a.baselineDays === undefined ? 'Issues in progress or review, oldest first' : `Dashed line: p85 cycle time of the last 90 days (${formatAge(a.baselineDays)})`;
  });
  protected readonly agingNote = computed(() => {
    const a = this.report().flow.aging;
    return a.baselineDays === undefined ? `No baseline yet: it needs ${5} finished issues in the last 90 days, there are ${a.baselineSamples}.` : undefined;
  });

  private readonly wipRows = computed(() => [...this.report().flow.wip.people, ...this.report().flow.wip.agents]);
  protected readonly peopleIssueRows = computed<BarRow[]>(() =>
    this.report().flow.wip.people.filter((p) => p.issues > 0).map((p) => this.wipRow(p, p.issues, this.report().flow.wip.limits.issues)),
  );
  protected readonly peopleWsRows = computed<BarRow[]>(() =>
    this.report().flow.wip.people.filter((p) => p.workstreams > 0).map((p) => this.wipRow(p, p.workstreams, this.report().flow.wip.limits.workstreams)),
  );
  protected readonly agentRows = computed<BarRow[]>(() =>
    this.report().flow.wip.agents.map((a) => ({
      key: a.actor.id,
      label: a.actor.name,
      hint: 'agent',
      value: a.workstreams,
      detail: `${a.actor.name} touched ${a.workstreams} workstreams in flight this week`,
    })),
  );

  protected readonly wipView = computed<InsightWipRow | null>(() => {
    const who = this.wipWho();
    return who ? (this.wipRows().find((r) => r.actor.id === who) ?? null) : null;
  });

  protected readonly cfd = computed(() => {
    const c = this.report().flow.cumulativeFlow;
    const order = ['done', 'in_review', 'in_progress', 'todo', 'backlog'] as const;
    if (!c) return { labels: [], titles: [], series: [] as ChartSeries[] };
    return {
      labels: c.days.map((d) => format(new Date(d), 'MMM d')),
      titles: c.days.map((d) => format(new Date(d), 'EEE, MMM d')),
      series: order.map((s) => ({
        key: s,
        label: ISSUE_STATUS_META[s].label,
        color: ISSUE_COLOR[s],
        values: c.series.find((x) => x.status === s)?.values ?? [],
      })) as ChartSeries[],
    };
  });
  protected readonly cfdEmpty = computed(() => this.cfd().series.every((s) => s.values.every((v) => !v)));

  protected toggle(id: FlowDrill): void {
    this.drillChange.emit(this.drill() === id ? null : id);
  }

  protected pickWip(row: BarRow): void {
    this.wipWho.set(this.wipWho() === row.key ? null : (row.key ?? null));
  }

  private wipRow(p: InsightWipRow, value: number, limit: number): BarRow {
    const over = value > limit;
    return {
      key: p.actor.id,
      label: p.actor.name,
      value,
      valueLabel: over ? `${value} over ${limit}` : String(value),
      detail: `${p.actor.name}: ${p.issues} issues, ${p.workstreams} workstreams${over ? ' (over the limit)' : ''}`,
      color: over ? 'var(--tone-red)' : undefined,
    };
  }

  private fmt(days: number | undefined): string {
    return days === undefined ? '—' : formatAge(days);
  }

  private durationDelta(d: FlowDuration, against: string): KpiDelta | undefined {
    const cur: DurationStats = d.stats;
    const prev = d.previous?.p50;
    return cur.p50 === undefined || prev === undefined ? undefined : pctDelta(cur.p50, prev, 'down', against);
  }
}

