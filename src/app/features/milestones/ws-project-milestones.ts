// The milestones of the project a workstream carries out, as a read-only list with a link to where
// they are planned. Shown on the workstream page and in the timeline panel.
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { NablaStore, type Workstream } from '../../core';
import { MilestoneIcon } from './milestone-icon';
import { ProjectMilestones } from './project-milestones';

@Component({
  selector: 'app-ws-project-milestones',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, MilestoneIcon, ProjectMilestones],
  host: { class: 'block' },
  template: `
    @if (project(); as p) {
      <app-project-milestones [project]="p" [readonly]="true" [showChart]="false" />
      <p class="text-muted-foreground mt-1.5 text-xs">
        Milestones are planned in the project.
        <a class="text-foreground underline-offset-2 hover:underline" [routerLink]="['/', slug(), 'projects', p.id]">Open {{ p.name }}</a>
      </p>
    } @else {
      <section aria-label="Milestones">
        <header class="mb-2 flex items-center gap-2">
          <app-milestone-icon [size]="15" state="idle" />
          <h2 class="text-sm font-semibold">Milestones</h2>
        </header>
        <p class="text-muted-foreground text-sm">
          Milestones belong to a project. Add this workstream to a project (Project property) to work with the project's stages, each with its own issues and date.
        </p>
      </section>
    }
  `,
})
export class WsProjectMilestones {
  private readonly store = inject(NablaStore);
  readonly ws = input.required<Workstream>();
  protected readonly slug = computed(() => this.store.slug() ?? '');
  protected readonly project = computed(() => this.store.getProject(this.ws().projectId));
}
