import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { format, parseISO } from 'date-fns';
import { PROJECT_STATUS_META, TramaStore } from '../../core';
import { EmptyState } from '../../shared/empty-state';
import { ProjectGlyph } from '../projects/project-glyph';
import { projectTone } from './timeline-model';
import type { ViewGroup } from '../views/view-model';

/** Project schedule view for saved views using the timeline layout. */
@Component({
  selector: 'app-timeline-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, EmptyState, ProjectGlyph],
  host: { class: 'relative flex min-h-0 flex-1 flex-col' },
  template: `
    @if (!projects().length) {
      <app-empty-state
        class="m-auto"
        title="No projects in this timeline"
        description="Timeline views show project schedules. Add projects to the view or choose another layout."
      />
    } @else {
      <div class="overflow-auto">
        <table class="w-full min-w-[600px] text-sm">
          <thead>
            <tr class="text-muted-foreground border-b text-xs">
              <th class="px-4 py-2 text-start font-medium">Project</th>
              <th class="px-3 py-2 text-start font-medium">Status</th>
              <th class="px-3 py-2 text-start font-medium">Start</th>
              <th class="px-3 py-2 text-start font-medium">Target</th>
            </tr>
          </thead>
          @for (group of projects(); track group.key) {
            @if (projects().length > 1) {
              <tbody>
                <tr class="bg-muted/30 border-b">
                  <th colspan="4" class="px-4 py-2 text-start text-xs font-medium">{{ group.label }} <span class="text-muted-foreground ms-1">{{ group.items.length }}</span></th>
                </tr>
            }
            <tbody>
              @for (project of group.items; track project.id) {
                <tr class="hover:bg-hover border-b">
                  <td class="px-4 py-2">
                    <a class="inline-flex items-center gap-2 hover:underline" [routerLink]="['/', slug(), 'projects', project.id]">
                      <app-project-glyph [project]="project" />
                      <span class="truncate">{{ project.name }}</span>
                    </a>
                  </td>
                  <td class="px-3 py-2"><span class="inline-flex items-center gap-1.5"><span class="size-2 rounded-full" [style.background]="tone(project)"></span>{{ statusLabel(project.status) }}</span></td>
                  <td class="text-muted-foreground px-3 py-2 tabular-nums">{{ date(project.startDate) }}</td>
                  <td class="text-muted-foreground px-3 py-2 tabular-nums">{{ date(project.targetDate) }}</td>
                </tr>
              }
            </tbody>
          }
        </table>
      </div>
    }
  `,
})
export class TimelineView {
  private readonly store = inject(TramaStore);
  readonly entity = input<string>('project');
  readonly groups = input.required<readonly ViewGroup[]>();
  protected readonly slug = computed(() => this.store.slug() ?? '');
  protected readonly projects = computed(() => {
    if (this.entity() !== 'project') return [];
    const seen = new Set<string>();
    return this.groups().map((group) => ({
      key: group.key,
      label: group.label,
      items: group.items.flatMap((item) => {
        const project = this.store.getProject(item.id);
        if (!project || seen.has(project.id)) return [];
        seen.add(project.id);
        return [project];
      }),
    })).filter((group) => group.items.length > 0);
  });

  protected readonly tone = projectTone;
  protected readonly statusLabel = (status: keyof typeof PROJECT_STATUS_META): string => PROJECT_STATUS_META[status].label;
  protected date(value?: string): string {
    if (!value) return '—';
    const date = parseISO(value);
    return Number.isNaN(date.getTime()) ? '—' : format(date, 'MMM d, yyyy');
  }
}
