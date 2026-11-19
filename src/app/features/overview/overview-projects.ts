import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import {
  LucideDynamicIcon,
  LucideMinus,
  LucideTrendingDown,
  LucideTrendingUp,
  type LucideIcon,
} from '@lucide/angular';
import { format } from 'date-fns';
import { ProjectGlyph } from '../projects/project-glyph';
import { PreviewLink } from '../issues/list-preview';
import type { SignalKind } from '../timeline/timeline-model';
import { OverviewLinks, TONE_VAR } from './overview-links';
import { plural, type ProjectRow, type TrackScale } from './overview-model';

/** Columns shared by the header and every row (wide layout): name, progress, momentum, target against projection. */
const COLS = '@2xl:grid-cols-[minmax(0,13.5rem)_6.5rem_3.25rem_minmax(0,1fr)]';

const SIGNAL_TONE: Record<SignalKind, keyof typeof TONE_VAR> = {
  on_track: 'green',
  at_risk: 'amber',
  off_track: 'red',
  not_enough_data: 'neutral',
  no_target: 'neutral',
  closed: 'neutral',
};

/**
 * The projects, one line each. Progress is a thin segmented sliver (done, in progress, still to do), momentum is
 * tasks closed this week against last week, and the track on the right puts every project on ONE shared time axis:
 * the hollow ring is the target date, the filled dot is where the current pace ends up. A dot to the right of its
 * ring is a project running late; the line between them is the gap.
 */
@Component({
  selector: 'app-overview-projects',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideDynamicIcon, PreviewLink, ProjectGlyph],
  host: { class: 'block' },
  template: `
    @if (rows().length === 0) {
      <p class="text-muted-foreground py-1 text-[13px]">No open projects.</p>
    } @else {
      <div class="text-meta mb-1 hidden gap-x-4 px-2 @2xl:grid" [class]="cols">
        <span class="col-start-4 relative mx-1.5 block h-4" aria-hidden="true">
          @for (t of scale().ticks; track t.label + t.pos) {
            <span class="absolute -translate-x-1/2" [style.left.%]="t.pos * 100">{{ t.label }}</span>
          }
          <span class="text-primary absolute -translate-x-1/2 font-medium" [style.left.%]="scale().todayPos * 100">Today</span>
        </span>
      </div>

      <ul class="-mx-2 flex flex-col">
        @for (r of rows(); track r.project.id) {
          <li>
            <a
              [appPreviewLink]="links.route(target(r))"
              (preview)="links.show(target(r))"
              class="hover:bg-hover focus-visible:ring-ring/50 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 rounded-md px-2 py-2 outline-none focus-visible:ring-2"
              [class]="cols"
              [class.bg-selected]="links.isPreviewed(target(r))"
              [title]="r.forecast.explanation"
            >
              <!-- name -->
              <span class="flex min-w-0 items-center gap-2.5">
                <app-project-glyph [project]="r.project" [size]="16" />
                <span class="flex min-w-0 flex-col">
                  <span class="truncate text-[13px] leading-snug">{{ r.project.name }}</span>
                  <span class="text-meta truncate">
                    @if (r.total) {
                      {{ r.done }} of {{ plural(r.total, 'task') }}@if (r.active) {<span> · {{ r.active }} in progress</span>}
                    } @else {
                      No tasks yet
                    }
                    <span class="@2xl:hidden"> · {{ momentumText(r) }}</span>
                  </span>
                </span>
              </span>

              <!-- progress -->
              <span class="flex flex-col items-end gap-1 @2xl:items-stretch">
                <span class="bg-muted flex h-1 w-20 gap-px overflow-hidden rounded-full @2xl:w-auto" aria-hidden="true">
                  <span class="bg-primary" [style.width.%]="share(r.done, r.total)"></span>
                  <span class="bg-primary/40" [style.width.%]="share(r.active, r.total)"></span>
                </span>
                <span class="text-meta tabular-nums">{{ r.total ? r.percent + '% done' : '—' }}</span>
              </span>

              <!-- momentum -->
              <span class="hidden flex-col items-start gap-0.5 @2xl:flex" [title]="momentumText(r)">
                <span class="flex items-center gap-1 text-[13px] tabular-nums" [style.color]="momentumColor(r)">
                  <svg [lucideIcon]="momentumIcon(r)" [size]="14" [strokeWidth]="1.75" aria-hidden="true"></svg>{{ r.closedThisWeek }}
                </span>
                <span class="text-meta">this week</span>
              </span>

              <!-- target against projected end -->
              <span class="col-span-full flex min-w-0 flex-col gap-1 @2xl:col-span-1">
                <span class="relative mx-1.5 block h-4" aria-hidden="true">
                  <span class="bg-border absolute inset-x-0 top-1/2 h-px"></span>
                  <span class="bg-primary/35 absolute top-0 h-4 w-px" [style.left.%]="scale().todayPos * 100"></span>
                  @if (r.target && r.projectedEnd) {
                    <span
                      class="absolute top-1/2 h-0.5 -translate-y-1/2 rounded-full opacity-45"
                      [style.left.%]="Math.min(pos(r.target), pos(r.projectedEnd)) * 100"
                      [style.width.%]="Math.abs(pos(r.projectedEnd) - pos(r.target)) * 100"
                      [style.background]="color(r)"
                    ></span>
                  }
                  @if (r.target) {
                    <span
                      class="bg-background absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2"
                      style="border-color: var(--muted-foreground)"
                      [style.left.%]="pos(r.target) * 100"
                    ></span>
                  }
                  @if (r.projectedEnd) {
                    <span
                      class="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full"
                      style="box-shadow: 0 0 0 2px var(--background)"
                      [style.left.%]="pos(r.projectedEnd) * 100"
                      [style.background]="color(r)"
                    ></span>
                  }
                </span>
                <span class="text-meta truncate" [style.color]="textColor(r)">{{ detail(r) }}</span>
              </span>
            </a>
          </li>
        }
      </ul>

      <p class="text-meta mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
        <span class="flex items-center gap-1.5">
          <span class="bg-background size-2.5 rounded-full border-2" style="border-color: var(--muted-foreground)"></span>Target date
        </span>
        <span class="flex items-center gap-1.5"><span class="size-2.5 rounded-full" style="background: var(--muted-foreground)"></span>Where today's pace ends</span>
        <span class="flex items-center gap-1.5"><span class="bg-primary/35 h-3 w-px"></span>Today</span>
      </p>
    }
  `,
})
export class OverviewProjects {
  protected readonly links = inject(OverviewLinks);

  readonly rows = input.required<readonly ProjectRow[]>();
  readonly scale = input.required<TrackScale>();
  /** The current date, to write "12 Dec" without the year. */
  readonly now = input.required<Date>();

  protected readonly cols = `${COLS}`;
  protected readonly Math = Math;
  protected readonly plural = plural;

  protected target(r: ProjectRow): { kind: 'project'; id: string } {
    return { kind: 'project', id: r.project.id };
  }

  protected share(n: number, total: number): number {
    return total ? (n / total) * 100 : 0;
  }

  protected pos(d: Date): number {
    return this.scale().pos(d);
  }

  protected color(r: ProjectRow): string {
    return TONE_VAR[SIGNAL_TONE[r.signal]];
  }

  /** Text in the signal colour only for the three signals; everything else stays muted. */
  protected textColor(r: ProjectRow): string {
    const tone = SIGNAL_TONE[r.signal];
    return tone === 'neutral' ? '' : TONE_VAR[tone];
  }

  protected momentumIcon(r: ProjectRow): LucideIcon {
    return r.momentum === 'up' ? LucideTrendingUp : r.momentum === 'down' ? LucideTrendingDown : LucideMinus;
  }

  protected momentumColor(r: ProjectRow): string {
    return r.momentum === 'up' ? TONE_VAR.green : r.momentum === 'down' ? TONE_VAR.amber : TONE_VAR.neutral;
  }

  protected momentumText(r: ProjectRow): string {
    if (r.momentum === 'none') return 'nothing closed in 2 weeks';
    return `${r.closedThisWeek} closed this week, ${r.closedLastWeek} last week`;
  }

  /** One short line under the track: the verdict, plus the dates it compares. */
  protected detail(r: ProjectRow): string {
    const now = this.now();
    const fmt = (d: Date): string => format(d, d.getFullYear() === now.getFullYear() ? 'd MMM' : 'd MMM yyyy');
    const f = r.forecast;
    if (r.projectedEnd && r.target) return `${f.label} · ends ${fmt(r.projectedEnd)}, target ${fmt(r.target)}`;
    if (r.projectedEnd) return `${f.label}`;
    if (r.target) return `${f.label} · target ${fmt(r.target)}`;
    return f.label;
  }
}
