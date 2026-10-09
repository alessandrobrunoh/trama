import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { LucideDynamicIcon, LucideFilePlus, LucideFileText } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { ApiError, NablaStore, type DocumentSummary, type Project } from '../../core';
import { EmptyState } from '../../shared/empty-state';
import { DocumentRow } from './document-row';
import { DocumentActions } from './document-attach';
import { Documents } from './documents.service';

/**
 * "Documents" tab of a project: the documents attached to the project itself (the ones attached to its
 * workstreams and issues stay in Context, where their origin is shown).
 */
@Component({
  selector: 'app-project-documents-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButtonImports, LucideDynamicIcon, EmptyState, DocumentRow, DocumentActions],
  host: { class: 'block' },
  template: `
    <div class="mb-3 flex items-center gap-2">
      <h2 class="text-sm font-medium">Documents</h2>
      @if (rows().length) {
        <span class="text-muted-foreground text-xs tabular-nums">{{ rows().length }}</span>
      }
      @if (canEdit()) {
        <span class="ml-auto flex items-center gap-1.5">
          <app-document-actions
            variant="outline"
            label="Add document"
            [owner]="{ projectId: project().id }"
          />
        </span>
      }
    </div>
    @if (error()) {
      <p class="text-destructive text-sm" role="alert">{{ error() }}</p>
    } @else if (!loaded()) {
      <p class="text-muted-foreground py-8 text-center text-sm" role="status">Loading…</p>
    } @else if (rows().length === 0) {
      <app-empty-state
        [icon]="fileIcon"
        title="No documents yet"
        description="Write the spec, the plan or the notes behind this project here, or attach a document that already exists. They stay one document, whatever they are attached to."
      >
        @if (canEdit()) {
          <button hlmBtn size="sm" (click)="create()">
            <svg [lucideIcon]="newIcon" [size]="14"></svg>New document
          </button>
        }
      </app-empty-state>
    } @else {
      <div class="-mx-4 border-t sm:-mx-6">
        @for (d of rows(); track d.id) {
          <app-document-row [doc]="d" [showLinks]="false" />
        }
      </div>
    }
  `,
})
export class ProjectDocumentsTab {
  private readonly store = inject(NablaStore);
  private readonly documents = inject(Documents);

  readonly project = input.required<Project>();

  protected readonly fileIcon = LucideFileText;
  protected readonly newIcon = LucideFilePlus;
  protected readonly rows = signal<DocumentSummary[]>([]);
  protected readonly loaded = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly canEdit = computed(() => this.store.can('member'));
  private requestId = 0;

  constructor() {
    effect(() => {
      const id = this.project().id;
      this.documents.changes();
      untracked(() => void this.load(id));
    });
  }

  private async load(projectId: string): Promise<void> {
    const request = ++this.requestId;
    try {
      const rows = await this.documents.list({
        projectId,
        sort: 'updated',
        order: 'desc',
        limit: 100,
      });
      if (request !== this.requestId) return;
      this.rows.set(rows);
      this.error.set(null);
    } catch (e) {
      if (request !== this.requestId) return;
      this.error.set(e instanceof ApiError ? e.message : 'Could not load the documents');
    } finally {
      if (request === this.requestId) this.loaded.set(true);
    }
  }

  protected create(): void {
    void this.documents.createAndOpen({ projectId: this.project().id });
  }
}
