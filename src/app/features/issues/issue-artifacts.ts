import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { LucidePackage, LucidePlus, LucideDynamicIcon } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { NablaStore, type Artifact, type Issue } from '../../core';
import { ProjectArtifactDialog } from '../projects/project-artifact-dialog';
import { ProjectArtifactRow } from '../projects/project-artifact-row';

/**
 * "Artifacts" section of the issue page: documents, links, PRs and builds attached directly to the issue.
 * They also belong to the issue's project / workstreams, whose Context tab lists them with this issue as origin.
 */
@Component({
  selector: 'app-issue-artifacts',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButtonImports, LucideDynamicIcon, ProjectArtifactDialog, ProjectArtifactRow],
  host: { class: 'block' },
  template: `
    <div class="mb-2 flex items-center gap-2">
      <h2 class="text-sm font-medium">Artifacts</h2>
      @if (items().length) {
        <span class="text-muted-foreground text-xs tabular-nums">{{ items().length }}</span>
      }
      @if (canEdit()) {
        <button
          hlmBtn
          size="sm"
          variant="ghost"
          class="ml-auto h-7 gap-1.5 text-xs"
          (click)="openAdd()"
        >
          <svg [lucideIcon]="plus" [size]="13"></svg> Add document / link
        </button>
      }
    </div>

    @if (items().length) {
      <div class="border-border overflow-hidden rounded-lg border [&>*:last-child]:border-b-0">
        @for (a of items(); track a.id) {
          <app-project-artifact-row
            [artifact]="a"
            origin="none"
            [indent]="12"
            [editable]="canEdit()"
            (edit)="openEdit($event)"
          />
        }
      </div>
    } @else {
      <div class="border-border flex items-center gap-3 rounded-lg border border-dashed px-4 py-3">
        <svg [lucideIcon]="pkg" [size]="16" class="text-muted-foreground shrink-0"></svg>
        <p class="text-muted-foreground min-w-0 flex-1 text-xs">
          No artifacts yet. Attach the spec, a design or a link that gives context for this issue.
        </p>
      </div>
    }

    <app-project-artifact-dialog [(open)]="dialogOpen" [target]="target()" [artifact]="editing()" />
  `,
})
export class IssueArtifacts {
  private readonly store = inject(NablaStore);

  readonly issue = input.required<Issue>();

  protected readonly plus = LucidePlus;
  protected readonly pkg = LucidePackage;
  protected readonly canEdit = computed(() => this.store.can('member'));
  protected readonly target = computed(() => ({ type: 'issue' as const, key: this.issue().key }));
  protected readonly items = computed(() =>
    [...(this.store.artifactsByIssue().get(this.issue().id) ?? [])].sort((a, b) =>
      a.updatedAt < b.updatedAt ? 1 : -1,
    ),
  );

  protected readonly dialogOpen = signal(false);
  protected readonly editing = signal<Artifact | undefined>(undefined);

  protected openAdd(): void {
    this.editing.set(undefined);
    this.dialogOpen.set(true);
  }

  protected openEdit(a: Artifact): void {
    this.editing.set(a);
    this.dialogOpen.set(true);
  }
}
