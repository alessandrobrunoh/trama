import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { LucideChartGantt, LucideCrosshair } from '@lucide/angular';
import { LucideDynamicIcon } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmToggleGroupImports } from '@spartan-ng/helm/toggle-group';
import { TramaStore, statusTypeOf } from '../../core';
import { RightPaneStore } from '../../core/stores/right-pane.store';
import { oneOf, readJson, writeJson } from '../../core/stores/storage';
import { StatusBar } from '../../layout/status-bar';
import { EmptyState } from '../../shared/empty-state';
import { PageHeader } from '../../shared/page-header';
import { TimelineChart } from './timeline-chart';
import { ZOOMS, type Zoom } from './timeline-model';

const STORAGE_KEY = 'trama.timeline.v1';
const ZOOM_VALUES = ZOOMS.map((z) => z.value);

/** `/:workspace/timeline`: every project on one time axis, with milestones, progress and a projected end. */
@Component({
  selector: 'app-timeline-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    HlmButtonImports,
    HlmToggleGroupImports,
    LucideDynamicIcon,
    PageHeader,
    EmptyState,
    StatusBar,
    TimelineChart,
  ],
  host: { class: 'flex h-full min-h-0 flex-col' },
  template: `
    <app-page-header
      title="Timeline"
      description="Every project on one time axis, with where it is heading at the current pace"
    >
      <span actions class="flex items-center gap-1.5">
        <button
          hlmBtn
          size="sm"
          variant="ghost"
          class="text-muted-foreground h-7"
          [attr.aria-pressed]="showClosed()"
          (click)="showClosed.set(!showClosed())"
        >
          {{ showClosed() ? 'Hide closed' : 'Show closed' }}
        </button>
        <button hlmBtn size="sm" variant="outline" class="h-7 gap-1.5" (click)="chart()?.scrollToToday()">
          <svg [lucideIcon]="todayIcon" [size]="13"></svg>Today
        </button>
        <hlm-toggle-group
          type="single"
          variant="outline"
          size="sm"
          [value]="zoom()"
          (valueChange)="setZoom($event)"
          aria-label="Zoom"
        >
          @for (z of zooms; track z.value) {
            <button hlmToggleGroupItem [value]="z.value" class="h-7 px-2.5 text-xs">{{ z.label }}</button>
          }
        </hlm-toggle-group>
      </span>
    </app-page-header>

    @if (!store.ready()) {
      <div class="text-muted-foreground m-auto text-sm">Loading…</div>
    } @else if (projects().length === 0) {
      <app-empty-state
        class="m-auto"
        [icon]="ganttIcon"
        title="Nothing to plan yet"
        [description]="
          showClosed()
            ? 'Create a project with a start and a target date to see it here.'
            : 'No open projects. Create one with a start and a target date, or show the closed ones.'
        "
      />
    } @else {
      <app-timeline-chart [projects]="projects()" [zoom]="zoom()" />
    }

    <app-status-bar>
      @let s = summary();
      <span>{{ projects().length }} {{ projects().length === 1 ? 'project' : 'projects' }}</span>
      @if (s) {
        @if (s.on_track) {
          <span class="inline-flex items-center gap-1.5"><span class="size-1.5 rounded-full" style="background: var(--tone-green)"></span>{{ s.on_track }} on track</span>
        }
        @if (s.at_risk) {
          <span class="inline-flex items-center gap-1.5"><span class="size-1.5 rounded-full" style="background: var(--tone-amber)"></span>{{ s.at_risk }} at risk</span>
        }
        @if (s.off_track) {
          <span class="inline-flex items-center gap-1.5"><span class="size-1.5 rounded-full" style="background: var(--tone-red)"></span>{{ s.off_track }} off track</span>
        }
        @if (s.not_enough_data) {
          <span>{{ s.not_enough_data }} without enough data</span>
        }
      }
      <span end>Projected from tasks closed in the last 6 weeks</span>
    </app-status-bar>
  `,
})
export class TimelinePage {
  protected readonly store = inject(TramaStore);
  private readonly pane = inject(RightPaneStore);

  protected readonly zooms = ZOOMS;
  protected readonly todayIcon = LucideCrosshair;
  protected readonly ganttIcon = LucideChartGantt;
  protected readonly chart = viewChild(TimelineChart);

  private readonly saved = readJson<{ zoom: string; showClosed: boolean }>(STORAGE_KEY);
  protected readonly zoom = signal<Zoom>(oneOf(this.saved?.zoom, ZOOM_VALUES, 'month'));
  protected readonly showClosed = signal(this.saved?.showClosed === true);

  protected readonly projects = computed(() => {
    const statuses = this.store.settings().statuses.project;
    return this.store.projects().filter((p) => {
      if (this.showClosed()) return true;
      const type = statusTypeOf(statuses, p.status);
      return type !== 'completed' && type !== 'canceled';
    });
  });

  protected readonly summary = computed(() => this.chart()?.summary());

  constructor() {
    // A task previewed on another page has nothing to do with the timeline.
    if (this.pane.content()?.kind === 'task') this.pane.clear();
    effect(() => writeJson(STORAGE_KEY, { zoom: this.zoom(), showClosed: this.showClosed() }));
  }

  protected setZoom(value: unknown): void {
    if (value === 'week' || value === 'month' || value === 'quarter') this.zoom.set(value);
  }
}
