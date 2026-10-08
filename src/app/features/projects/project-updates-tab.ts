// "Updates" tab of the project page: composer on top, newest-first feed below.
import { ChangeDetectionStrategy, Component, computed, effect, inject, input } from '@angular/core';
import { LucideActivity, LucideCircleAlert } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmSkeleton } from '@spartan-ng/helm/skeleton';
import { NablaStore, type Project } from '../../core';
import { EmptyState } from '../../shared/empty-state';
import { ProjectUpdateComposer } from './project-update-composer';
import { ProjectUpdateItem } from './project-update-item';
import { canPostUpdate } from './project-model';

@Component({
  selector: 'app-project-updates-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButtonImports, HlmSkeleton, EmptyState, ProjectUpdateComposer, ProjectUpdateItem],
  host: { class: 'mx-auto flex w-full max-w-2xl min-w-0 flex-col gap-10 px-4 py-8 sm:px-6' },
  template: `
    @let p = project();
    @if (canPost()) {
      <app-project-update-composer [project]="p" />
    }

    @if (state() === 'error' && updates().length === 0) {
      <app-empty-state
        [icon]="alertIcon"
        title="Could not load the updates"
        description="Check your connection and try again."
      >
        <button hlmBtn size="sm" variant="outline" (click)="reload()">Retry</button>
      </app-empty-state>
    } @else if ((state() === 'loading' || state() === 'idle') && updates().length === 0) {
      <div class="flex flex-col gap-8" aria-busy="true" aria-label="Loading updates">
        <div hlmSkeleton class="h-36"></div>
        <div hlmSkeleton class="h-24"></div>
      </div>
    } @else if (updates().length === 0) {
      <app-empty-state
        [icon]="activityIcon"
        title="No updates yet"
        [description]="
          canPost()
            ? 'A project update tells the team how things are going: pick a health, write what changed and what is next. The latest one drives the health shown on the project and in the list.'
            : 'Updates are posted by the project lead. The latest one drives the health shown on the project and in the list.'
        "
      />
    } @else {
      <div role="feed" aria-label="Project updates">
        @for (u of updates(); track u.id) {
          <app-project-update-item [update]="u" [project]="p" />
        }
      </div>
    }
  `,
})
export class ProjectUpdatesTab {
  private readonly store = inject(NablaStore);

  readonly project = input.required<Project>();

  protected readonly activityIcon = LucideActivity;
  protected readonly alertIcon = LucideCircleAlert;

  protected readonly updates = computed(() => this.store.projectUpdates(this.project().id)());
  protected readonly state = computed(() => this.store.projectUpdatesState(this.project().id)());
  protected readonly canPost = computed(() => canPostUpdate(this.store, this.project()));

  constructor() {
    effect(() => {
      void this.store.loadProjectUpdates(this.project().id);
    });
  }

  protected reload(): void {
    void this.store.loadProjectUpdates(this.project().id, { force: true });
  }
}
