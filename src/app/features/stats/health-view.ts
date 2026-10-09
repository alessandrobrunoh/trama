import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, input, output, signal, untracked, viewChild } from '@angular/core';
import { LucideCircleCheck, LucideDynamicIcon, LucideX } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import {
  ApiClient,
  type InsightBottleneck,
  type InsightItem,
  type InsightSignal,
  type InsightSignalId,
  type InsightsQuery,
  type InsightsReport,
} from '../../core';
import { BarList, type BarRow } from './charts/bar-list';
import { ChartCard } from './charts/chart-card';
import { InsightItems } from './insight-items';
import { SEVERITY_RANK, SEVERITY_VIEW, formatAge } from './insights-model';

/** Signals whose items name somebody who has to act: the "waiting on X" drill-down reads these. */
const WAITING_SIGNALS: readonly InsightSignalId[] = ['needs_input', 'undecided_decisions', 'prs_stuck_in_review'];

/**
 * Where are the problems? One tile per health signal, worst first. A tile opens the list of items that
 * cause it; the bottleneck chart shows who everything is waiting on.
 */
@Component({
  selector: 'app-health-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideDynamicIcon, HlmButtonImports, BarList, ChartCard, InsightItems],
  host: { class: 'flex flex-col gap-6' },
  template: `
    @if (report(); as r) {
      <section aria-labelledby="health-summary" class="flex flex-col gap-3">
        <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 id="health-summary" class="text-sm font-medium">{{ headline() }}</h2>
          <span class="text-meta text-[11px]">
            As of now · stale after {{ r.staleDays }} days · scope creep and flow over the last {{ r.range.days }} days
          </span>
        </div>

        @if (problems().length) {
          <ul class="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fill,minmax(12.5rem,1fr))]" aria-label="Health signals">
            @for (s of problems(); track s.id) {
              <li class="flex">
                <button
                  type="button"
                  class="bg-card hover:bg-hover focus-visible:ring-ring/50 flex w-full min-w-0 flex-col gap-1 rounded-lg border border-s-[3px] px-3 py-3 text-start outline-none transition-colors focus-visible:ring-2"
                  [class.ring-2]="selected() === s.id"
                  [class.ring-ring]="selected() === s.id"
                  [style.border-inline-start-color]="view[s.severity].stripe"
                  [attr.aria-pressed]="selected() === s.id"
                  (click)="toggle(s.id)"
                >
                  <span class="text-muted-foreground truncate text-xs">{{ s.label }}</span>
                  <span class="text-[26px] leading-8 font-semibold tracking-tight tabular-nums">{{ s.count }}</span>
                  <span class="flex items-center gap-1 text-[11px] font-medium" [class]="view[s.severity].text">
                    <svg [lucideIcon]="view[s.severity].icon" [size]="12" aria-hidden="true"></svg>
                    {{ view[s.severity].label }}
                  </span>
                  <span class="text-meta min-h-4 truncate text-[11px]">
                    @if (s.oldestDays !== undefined) {
                      oldest {{ age(s.oldestDays) }}
                    }
                  </span>
                </button>
              </li>
            }
          </ul>
        } @else {
          <div class="bg-card flex items-center gap-3 rounded-lg border px-4 py-5">
            <svg [lucideIcon]="check" [size]="20" class="text-tone-green shrink-0" aria-hidden="true"></svg>
            <div>
              <p class="text-sm font-medium">No problems found</p>
              <p class="text-meta">Every health signal is clear for this scope. Flow and contributors show how work is moving.</p>
            </div>
          </div>
        }

        @if (clear().length) {
          <p class="text-meta flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
            <span class="inline-flex items-center gap-1">
              <svg [lucideIcon]="check" [size]="12" aria-hidden="true"></svg> Clear:
            </span>
            @for (s of clear(); track s.id) {
              <button type="button" class="hover:text-foreground underline-offset-2 hover:underline" [attr.title]="s.definition" (click)="toggle(s.id)">{{ s.label }}</button>
            }
          </p>
        }
      </section>

      @if (detail(); as d) {
        <section #detailPanel class="bg-card scroll-mt-16 rounded-lg border p-4" [attr.aria-label]="d.label">
          <header class="mb-1 flex items-start gap-2">
            <div class="min-w-0 flex-1">
              <h3 class="text-sm font-medium">
                {{ d.label }} <span class="text-muted-foreground tabular-nums">{{ d.count }}</span>
              </h3>
              <p class="text-meta mt-0.5 text-[11px]">{{ d.definition }}</p>
            </div>
            <button hlmBtn variant="ghost" size="icon-sm" aria-label="Close the list" (click)="toggle(d.id)">
              <svg [lucideIcon]="close" [size]="14"></svg>
            </button>
          </header>
          <app-insight-items [items]="shownItems()" [slug]="slug()" [ariaLabel]="d.label + ' items'" empty="Nothing matches right now." />
          @if (d.truncated && !full()) {
            <div class="mt-2">
              <button hlmBtn variant="outline" size="sm" [disabled]="loadingFull()" (click)="loadFull(d.id)">
                {{ loadingFull() ? 'Loading…' : 'Show all ' + d.count }}
              </button>
              @if (fullError()) {
                <span class="text-tone-red ms-2 text-xs">{{ fullError() }}</span>
              }
            </div>
          }
        </section>
      }

      <div class="grid gap-4 lg:grid-cols-2">
        <app-chart-card
          title="Who everything waits on"
          subtitle="Days spent waiting, summed over open questions, undecided decisions and PRs without review"
          [empty]="bottleneckRows().length ? undefined : 'Nobody is waiting on anyone.'"
          note="Pick a person to see what is waiting on them. Reviews count against the accountable person of the workstream."
        >
          <app-bar-list
            [rows]="bottleneckRows()"
            [interactive]="true"
            defaultColor="var(--chart-1)"
            ariaLabel="Waiting time per person"
            (rowClick)="pickWho($event)"
          />
        </app-chart-card>

        <app-chart-card
          [title]="who() ? 'Waiting on ' + whoName() : 'Waiting on'"
          [subtitle]="who() ? whoItems().length + ' items across questions, decisions and reviews' : 'Pick a person in the chart'"
          [empty]="who() ? undefined : 'Select a person to see their queue.'"
        >
          <app-insight-items [items]="whoItems()" [slug]="slug()" [showWaiting]="false" empty="Nothing is waiting on this person." />
        </app-chart-card>
      </div>
    }
  `,
})
export class HealthView {
  readonly report = input.required<InsightsReport>();
  readonly slug = input.required<string>();
  readonly query = input.required<InsightsQuery>();
  readonly selected = input<InsightSignalId | null>(null);
  readonly selectedChange = output<InsightSignalId | null>();

  private readonly api = inject(ApiClient);
  private readonly panel = viewChild<ElementRef<HTMLElement>>('detailPanel');
  protected readonly view = SEVERITY_VIEW;
  protected readonly check = LucideCircleCheck;
  protected readonly close = LucideX;

  protected readonly who = signal<string | null>(null);
  protected readonly full = signal<InsightSignal | null>(null);
  protected readonly loadingFull = signal(false);
  protected readonly fullError = signal<string | null>(null);

  constructor() {
    // A new report or another tile invalidates the long list.
    effect(() => {
      this.report();
      this.selected();
      untracked(() => {
        this.full.set(null);
        this.fullError.set(null);
      });
    });
  }

  protected readonly sorted = computed(() =>
    [...this.report().signals].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]),
  );
  protected readonly problems = computed(() => this.sorted().filter((s) => s.severity !== 'ok'));
  protected readonly clear = computed(() => this.sorted().filter((s) => s.severity === 'ok'));

  protected readonly headline = computed(() => {
    const p = this.problems();
    if (!p.length) return 'No problems found';
    const n = (sev: string) => p.filter((s) => s.severity === sev).length;
    const parts = [
      n('critical') ? `${n('critical')} critical` : '',
      n('warning') ? `${n('warning')} need action` : '',
      n('info') ? `${n('info')} to watch` : '',
    ].filter(Boolean);
    return parts.join(' · ');
  });

  protected readonly detail = computed<InsightSignal | undefined>(() => {
    const id = this.selected();
    return id ? this.report().signals.find((s) => s.id === id) : undefined;
  });
  protected readonly shownItems = computed<readonly InsightItem[]>(() => this.full()?.items ?? this.detail()?.items ?? []);

  protected readonly bottleneckRows = computed<BarRow[]>(() =>
    this.report().bottlenecks.slice(0, 8).map((b) => ({
      key: b.actor.id ?? 'unassigned',
      label: b.actor.name,
      hint: b.actor.type === 'agent' ? 'agent' : undefined,
      value: b.totalWaitDays,
      valueLabel: formatAge(b.totalWaitDays),
      detail: this.bottleneckDetail(b),
      color: b.actor.type === 'unassigned' ? 'var(--muted-foreground)' : undefined,
    })),
  );

  protected readonly whoName = computed(() => this.report().bottlenecks.find((b) => (b.actor.id ?? 'unassigned') === this.who())?.actor.name ?? '');
  protected readonly whoItems = computed<InsightItem[]>(() => {
    const who = this.who();
    if (!who) return [];
    return this.report()
      .signals.filter((s) => WAITING_SIGNALS.includes(s.id))
      .flatMap((s) => s.items.filter((i) => (i.waitingOn?.id ?? 'unassigned') === who))
      .sort((a, b) => (b.ageDays ?? 0) - (a.ageDays ?? 0));
  });

  protected age(days: number): string {
    return formatAge(days);
  }

  protected toggle(id: InsightSignalId): void {
    const opening = this.selected() !== id;
    this.selectedChange.emit(opening ? id : null);
    // On a phone the list opens below the fold: bring it into view once it is rendered.
    if (opening) setTimeout(() => this.panel()?.nativeElement.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 60);
  }

  protected pickWho(row: BarRow): void {
    this.who.set(this.who() === row.key ? null : (row.key ?? null));
  }

  protected async loadFull(id: InsightSignalId): Promise<void> {
    this.loadingFull.set(true);
    this.fullError.set(null);
    try {
      this.full.set(await this.api.insights.signal(this.slug(), id, { ...this.query(), limit: 200 }));
    } catch {
      this.fullError.set('Could not load the full list.');
    } finally {
      this.loadingFull.set(false);
    }
  }

  private bottleneckDetail(b: InsightBottleneck): string {
    const parts = [
      b.inputRequests ? `${b.inputRequests} open question${b.inputRequests === 1 ? '' : 's'}` : '',
      b.decisions ? `${b.decisions} undecided decision${b.decisions === 1 ? '' : 's'}` : '',
      b.reviews ? `${b.reviews} PR${b.reviews === 1 ? '' : 's'} waiting for review` : '',
    ].filter(Boolean);
    return `${b.actor.name}: ${parts.join(', ')}; oldest ${formatAge(b.oldestDays)}`;
  }
}
