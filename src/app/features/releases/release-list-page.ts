import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideRocket } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { TramaStore, type Artifact, type SubjectRef } from '../../core';
import { EmptyState } from '../../shared/empty-state';
import { PageHeader } from '../../shared/page-header';
import { ProjectArtifactDialog, type ArtifactTarget } from '../projects/project-artifact-dialog';
import { ProjectArtifactRow } from '../projects/project-artifact-row';

interface ReleaseRow {
  artifact: Artifact;
  path: SubjectRef[];
}

function artifactOwnerPath(artifact: Artifact): SubjectRef[] {
  if (artifact.issueId) return [{ type: 'issue', id: artifact.issueId }];
  if (artifact.projectId) return [{ type: 'project', id: artifact.projectId }];
  return [];
}

/** Workspace overview of release-kind artifacts, retaining their Issue or Project ownership. */
@Component({
  selector: 'app-release-list-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    HlmButtonImports,
    EmptyState,
    PageHeader,
    ProjectArtifactDialog,
    ProjectArtifactRow,
  ],
  host: { class: 'flex h-full min-h-0 flex-col' },
  template: `
    <app-page-header
      title="Releases"
      description="Release artifacts attached to issues and projects"
    />

    <div class="min-h-0 flex-1 overflow-y-auto">
      @if (releases().length) {
        <ul role="list" aria-label="Release artifacts">
          @for (row of releases(); track row.artifact.id) {
            <li>
              <app-project-artifact-row
                [artifact]="row.artifact"
                [path]="row.path"
                origin="owner"
                [editable]="canEdit() && row.path.length > 0"
                [showProviderLabel]="true"
                [dateAlwaysVisible]="true"
                (edit)="openEdit($event)"
              />
            </li>
          }
        </ul>
      } @else if (store.status() === 'error') {
        <app-empty-state
          [icon]="releaseIcon"
          title="Could not load releases"
          description="The workspace artifacts failed to load. Check your connection and try again."
        >
          <button hlmBtn size="sm" variant="outline" (click)="retry()">Try again</button>
        </app-empty-state>
      } @else if (store.status() !== 'ready') {
        <p class="text-muted-foreground p-8 text-center text-sm" role="status">
          Loading release artifacts…
        </p>
      } @else {
        <app-empty-state
          [icon]="releaseIcon"
          title="No release artifacts yet"
          description="Release artifacts are attached from an Issue or Project. Open an owner, choose Add artifact, and select Release to record its link, state and context."
        >
          <div class="flex flex-wrap justify-center gap-2">
            <a hlmBtn size="sm" variant="outline" [routerLink]="['/', slug(), 'issues']">
              Browse issues
            </a>
            <a hlmBtn size="sm" variant="outline" [routerLink]="['/', slug(), 'projects']">
              Browse projects
            </a>
          </div>
        </app-empty-state>
      }
    </div>

    <app-project-artifact-dialog
      [(open)]="dialogOpen"
      [target]="dialogTarget()"
      [artifact]="editing()"
    />
  `,
})
export class ReleaseListPage {
  protected readonly store = inject(TramaStore);
  protected readonly releaseIcon = LucideRocket;
  protected readonly canEdit = computed(() => this.store.can('member'));
  protected readonly dialogOpen = signal(false);
  protected readonly editing = signal<Artifact | undefined>(undefined);
  protected readonly dialogTarget = signal<ArtifactTarget>({
    type: 'project',
    id: '',
  });

  protected readonly slug = computed(() => this.store.slug() ?? '');
  protected readonly releases = computed<ReleaseRow[]>(() =>
    this.store
      .artifacts()
      .filter(
        (artifact) =>
          artifact.kind === 'release' && Boolean(artifact.issueId || artifact.projectId),
      )
      .map((artifact) => ({ artifact, path: artifactOwnerPath(artifact) }))
      .sort(
        (a, b) =>
          b.artifact.updatedAt.localeCompare(a.artifact.updatedAt) ||
          a.artifact.title.localeCompare(b.artifact.title),
      ),
  );

  protected retry(): void {
    void this.store.refetch();
  }

  protected openEdit(artifact: Artifact): void {
    if (artifact.issueId) {
      const issue = this.store.getIssue(artifact.issueId);
      if (!issue) return;
      this.dialogTarget.set({ type: 'issue', key: issue.key });
    } else if (artifact.projectId) {
      this.dialogTarget.set({ type: 'project', id: artifact.projectId });
    } else {
      return;
    }
    this.editing.set(artifact);
    this.dialogOpen.set(true);
  }
}
