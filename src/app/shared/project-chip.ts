// Linkable project pill for issue and workstream rows and cards: project glyph + name.
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TramaStore } from '../core';
import { ProjectGlyph } from '../features/projects/project-glyph';

@Component({
  selector: 'app-project-chip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, ProjectGlyph],
  host: { class: 'relative inline-flex min-w-0 max-w-full' },
  template: `
    @if (project(); as p) {
      <a
        [routerLink]="['/', slug(), 'projects', p.id]"
        class="border-border-strong hover:bg-accent hover:border-foreground/20 inline-flex h-6 max-w-[9rem] min-w-0 items-center gap-1.5 rounded-full border px-2 text-xs transition-colors"
        [attr.title]="'Project · ' + p.name"
      >
        <app-project-glyph [project]="p" [size]="12" />
        <span class="min-w-0 truncate">{{ p.name }}</span>
      </a>
    }
  `,
})
export class ProjectChip {
  private readonly store = inject(TramaStore);
  readonly projectId = input.required<string>();
  protected readonly project = computed(() => this.store.getProject(this.projectId()));
  protected readonly slug = computed(() => this.store.slug() ?? '');
}
