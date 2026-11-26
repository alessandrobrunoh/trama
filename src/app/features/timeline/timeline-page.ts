import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { LucideChevronLeft, LucideChevronRight, LucideDynamicIcon, LucideLink } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { TramaStore, UiStore, statusTypeOf } from '../../core';
import { resolveStatusEntry } from '../../core/contracts/domain';
import { oneOf, readJson, writeJson } from '../../core/stores/storage';
import { TopBarActions } from '../../layout/page-chrome';
import { StatusBar } from '../../layout/status-bar';
import { Kbd } from '../../shared/kbd';
import { PageHeader } from '../../shared/page-header';
import { TimelineChart, type TimelineGroup } from './timeline-chart';
import { STATUS_TONE, ZOOMS, mix, type Zoom } from './timeline-model';

const STORAGE_KEY = 'trama.timeline.v1';
const ZOOM_VALUES = ZOOMS.map((z) => z.value);
const GROUPS: readonly { value: TimelineGroup; label: string }[] = [
  { value: 'milestone', label: 'Milestone' },
  { value: 'project', label: 'Project' },
];
const GROUP_VALUES = GROUPS.map((g) => g.value);
/** Statuses the legend names, in workflow order. */
const LEGEND: readonly { type: string; label: string }[] = [
  { type: 'todo', label: 'Planning' },
  { type: 'in_progress', label: 'In Progress' },
  { type: 'in_review', label: 'In Review' },
  { type: 'done', label: 'Merged' },
];

/** `/:workspace/timeline` (v3 · 09): tasks on one time axis, grouped under their milestone or project. */
@Component({
  selector: 'app-timeline-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButtonImports, Kbd, LucideDynamicIcon, PageHeader, StatusBar, TimelineChart, TopBarActions],
  host: { class: 'flex h-full min-h-0 flex-col' },
  template: `
    <app-page-header title="Timeline" />

    <ng-template appTopBarActions>
      <button hlmBtn variant="outline" type="button" (click)="today()">Today <app-kbd keys="t" /></button>
      @if (store.allowed('createIssues')) {
        <button hlmBtn type="button" (click)="ui.openCreate('issue')">New task <app-kbd keys="c" /></button>
      }
    </ng-template>

    <div class="border-border flex h-[52px] shrink-0 items-center gap-3 border-b px-5 max-md:hidden">
      <div class="border-border flex border" role="group" aria-label="Move the window">
        <button
          type="button"
          class="text-muted-foreground hover:text-foreground flex h-[26px] w-7 items-center justify-center"
          aria-label="Previous"
          (click)="chart()?.page(-1)"
        >
          <svg [lucideIcon]="prevIcon" [size]="14"></svg>
        </button>
        <button
          type="button"
          class="border-border text-muted-foreground hover:text-foreground flex h-[26px] w-7 items-center justify-center border-l"
          aria-label="Next"
          (click)="chart()?.page(1)"
        >
          <svg [lucideIcon]="nextIcon" [size]="14"></svg>
        </button>
      </div>
      <h2 class="font-title text-foreground text-[19px] leading-none">{{ chart()?.rangeLabel() }}</h2>
      <button hlmBtn variant="outline" type="button" (click)="today()">Today <app-kbd keys="t" /></button>
      <span class="flex-1"></span>

      <div class="flex items-center gap-3 max-xl:hidden" aria-label="Legend" role="group">
        @for (l of legend(); track l.label) {
          <span class="flex items-center gap-[5px]">
            <span
              class="h-2 w-[11px] border-l-2"
              [style.background]="l.fill"
              [style.border-color]="l.color"
              aria-hidden="true"
            ></span>
            <span class="text-faint font-mono text-[10.5px]">{{ l.label }}</span>
          </span>
        }
        <span class="flex items-center gap-[5px]">
          <svg [lucideIcon]="linkIcon" [size]="12" class="text-delta-line"></svg>
          <span class="text-faint font-mono text-[10.5px]">thread</span>
        </span>
      </div>
      <span class="bg-border h-[18px] w-px max-xl:hidden" aria-hidden="true"></span>

      <button
        type="button"
        class="border-border flex items-center gap-1.5 border px-2 py-[3px] font-mono text-[11px]"
        [attr.aria-label]="'Group by ' + groupLabel() + ', switch'"
        (click)="cycleGroup()"
      >
        <span class="text-muted-foreground">Group</span>
        <span class="text-foreground">{{ groupLabel() }}</span>
      </button>
      <div class="border-border flex border" role="group" aria-label="Zoom">
        @for (z of zooms; track z.value) {
          <button
            type="button"
            class="border-border px-[9px] py-1 font-mono text-[11px] not-first:border-l"
            [class.bg-secondary]="zoom() === z.value"
            [class.text-foreground]="zoom() === z.value"
            [class.text-muted-foreground]="zoom() !== z.value"
            [attr.aria-pressed]="zoom() === z.value"
            (click)="zoom.set(z.value)"
          >
            {{ z.label }}
          </button>
        }
      </div>
    </div>

    @if (!store.ready()) {
      <div class="text-muted-foreground m-auto text-sm">Loading…</div>
    } @else {
      <app-timeline-chart [projects]="projects()" [zoom]="zoom()" [group]="group()" />
    }

    <app-status-bar>
      @let s = summary();
      <span>{{ projects().length }} {{ projects().length === 1 ? 'project' : 'projects' }}</span>
      @if (s) {
        @if (s.on_track) {
          <span class="inline-flex items-center gap-1.5"><span class="size-1.5" style="background: var(--tone-green)"></span>{{ s.on_track }} on track</span>
        }
        @if (s.at_risk) {
          <span class="inline-flex items-center gap-1.5"><span class="size-1.5" style="background: var(--tone-amber)"></span>{{ s.at_risk }} at risk</span>
        }
        @if (s.off_track) {
          <span class="inline-flex items-center gap-1.5"><span class="size-1.5" style="background: var(--tone-red)"></span>{{ s.off_track }} off track</span>
        }
        @if (s.not_enough_data) {
          <span>{{ s.not_enough_data }} without enough data</span>
        }
      }
      @if (undated()) {
        <span>{{ undated() }} open {{ undated() === 1 ? 'task' : 'tasks' }} without dates</span>
      }
      <span end>Projected from tasks closed in the last 6 weeks</span>
    </app-status-bar>
  `,
})
export class TimelinePage {
  protected readonly store = inject(TramaStore);
  protected readonly ui = inject(UiStore);

  protected readonly zooms = ZOOMS;
  protected readonly prevIcon = LucideChevronLeft;
  protected readonly nextIcon = LucideChevronRight;
  protected readonly linkIcon = LucideLink;
  protected readonly chart = viewChild(TimelineChart);

  private readonly saved = readJson<{ zoom: string; group: string }>(STORAGE_KEY);
  protected readonly zoom = signal<Zoom>(oneOf(this.saved?.zoom, ZOOM_VALUES, 'month'));
  protected readonly group = signal<TimelineGroup>(oneOf(this.saved?.group, GROUP_VALUES, 'milestone'));

  protected readonly groupLabel = computed(() => GROUPS.find((g) => g.value === this.group())?.label ?? '');

  protected readonly projects = computed(() => {
    const statuses = this.store.settings().statuses.project;
    return this.store.projects().filter((p) => {
      const type = statusTypeOf(statuses, p.status);
      return type !== 'completed' && type !== 'canceled';
    });
  });

  protected readonly legend = computed(() => {
    const statuses = this.store.settings().statuses.issue;
    return LEGEND.map((l) => {
      const color = resolveStatusEntry(statuses, l.type)?.color ?? STATUS_TONE[l.type];
      return { label: l.label, color, fill: mix(color, 33) };
    });
  });

  protected readonly summary = computed(() => this.chart()?.summary());
  protected readonly undated = computed(() => this.chart()?.undated() ?? 0);

  constructor() {
    effect(() =>
      writeJson(STORAGE_KEY, { zoom: this.zoom(), group: this.group() }),
    );
  }

  protected today(): void {
    this.chart()?.scrollToToday();
  }

  protected cycleGroup(): void {
    const next = GROUP_VALUES[(GROUP_VALUES.indexOf(this.group()) + 1) % GROUP_VALUES.length];
    this.group.set(next);
  }
}
