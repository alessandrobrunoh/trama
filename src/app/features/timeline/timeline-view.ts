import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { TramaStore } from '../../core';
import { EmptyState } from '../../shared/empty-state';
import type { ViewGroup } from '../views/view-model';
import { TimelineChart } from './timeline-chart';
import { ZOOMS, type Zoom } from './timeline-model';

/**
 * Saved views with the timeline layout: the same chart as the Timeline page, restricted to the
 * projects of the view (groups are flattened, the order of the chart is by start date).
 */
@Component({
  selector: 'app-timeline-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [EmptyState, TimelineChart],
  host: { class: 'relative flex min-h-0 flex-1 flex-col' },
  template: `
    @if (!projects().length) {
      <app-empty-state
        class="m-auto"
        title="No projects in this timeline"
        description="Timeline views show project schedules. Add projects to the view or choose another layout."
      />
    } @else {
      <div class="text-muted-foreground flex items-center justify-end gap-3 px-4 py-1 text-xs sm:px-6 max-md:hidden">
        @for (z of zooms; track z.value) {
          <button
            type="button"
            class="hover:text-foreground focus-visible:ring-ring rounded px-1 outline-none focus-visible:ring-1"
            [class.text-foreground]="zoom() === z.value"
            [attr.aria-pressed]="zoom() === z.value"
            (click)="zoom.set(z.value)"
          >
            {{ z.label }}
          </button>
        }
      </div>
      <app-timeline-chart [projects]="projects()" [zoom]="zoom()" />
    }
  `,
})
export class TimelineView {
  private readonly store = inject(TramaStore);
  readonly entity = input<string>('project');
  readonly groups = input.required<readonly ViewGroup[]>();

  protected readonly zooms = ZOOMS;
  protected readonly zoom = signal<Zoom>('month');
  protected readonly projects = computed(() => {
    if (this.entity() !== 'project') return [];
    const seen = new Set<string>();
    return this.groups().flatMap((group) =>
      group.items.flatMap((item) => {
        const project = this.store.getProject(item.id);
        if (!project || seen.has(project.id)) return [];
        seen.add(project.id);
        return [project];
      }),
    );
  });
}
