// Composer of the Updates tab: pick a health, write markdown (with preview), post.
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { TramaStore, type Project, type ProjectHealth } from '../../core';
import { EntityRefs } from '../../shared/entity-ref';
import { Kbd } from '../../shared/kbd';
import { Markdown } from '../../shared/markdown';
import { CommentInput } from '../workstreams/comment-input';
import { ProjectAiDraftButton } from './project-ai';
import { ProjectHealthPicker } from './project-health';

@Component({
  selector: 'app-project-update-composer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    HlmButtonImports,
    Kbd,
    Markdown,
    CommentInput,
    ProjectHealthPicker,
    ProjectAiDraftButton,
  ],
  host: { class: 'block min-w-0' },
  template: `
    <section class="flex flex-col gap-3" aria-label="New project update">
      <div class="flex flex-wrap items-end justify-between gap-3">
        <div class="min-w-0">
          <h2 class="text-sm font-semibold">Post an update</h2>
          <p class="text-meta mt-0.5">The latest one sets the health shown on the project.</p>
        </div>
        <app-project-ai-draft-button [project]="project()" (draft)="applyDraft($event)" />
      </div>

      <app-project-health-picker [(value)]="health" [disabled]="busy()" />

      <div class="bg-card overflow-hidden rounded-lg border">
        <div
          class="flex items-center gap-1 border-b px-2 py-1.5"
          role="group"
          aria-label="Editor mode"
        >
          <button
            type="button"
            class="rounded-md px-2 py-1 text-xs font-medium"
            [class]="
              preview()
                ? 'text-muted-foreground hover:text-foreground'
                : 'bg-accent text-foreground'
            "
            [attr.aria-pressed]="!preview()"
            (click)="preview.set(false)"
          >
            Write
          </button>
          <button
            type="button"
            class="rounded-md px-2 py-1 text-xs font-medium"
            [class]="
              preview()
                ? 'bg-accent text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            "
            [attr.aria-pressed]="preview()"
            [disabled]="!body().trim()"
            (click)="preview.set(true)"
          >
            Preview
          </button>
        </div>
        @if (preview() && body().trim()) {
          <div class="min-h-32 px-3 py-3">
            <app-markdown [source]="body()" [link]="refs.linker()" />
          </div>
        } @else {
          <app-comment-input
            class="[&_textarea]:min-h-32 [&_textarea]:rounded-none [&_textarea]:border-0 [&_textarea]:bg-transparent [&_textarea]:px-3 [&_textarea]:py-3 [&_textarea]:shadow-none [&_textarea]:focus-visible:ring-0"
            label="Project update"
            placeholder="What changed, what is blocked, and what is next."
            [(value)]="body"
            (keyed)="onKey($event)"
          />
        }
      </div>

      <div class="flex items-center justify-between gap-2">
        <span class="text-meta">Markdown · @ to mention, # to link</span>
        <button hlmBtn size="sm" type="button" [disabled]="!canPost() || busy()" (click)="post()">
          Post update <app-kbd keys="mod+enter" class="opacity-70 max-sm:hidden" />
        </button>
      </div>
    </section>
  `,
})
export class ProjectUpdateComposer {
  protected readonly store = inject(TramaStore);
  protected readonly refs = inject(EntityRefs);

  readonly project = input.required<Project>();

  protected readonly health = signal<ProjectHealth>('on_track');
  protected readonly body = signal('');
  protected readonly preview = signal(false);
  protected readonly busy = signal(false);
  private readonly aiDrafted = signal(false);

  protected readonly canPost = computed(() => !!this.body().trim());

  protected applyDraft(d: { health: ProjectHealth; body: string }): void {
    this.health.set(d.health);
    this.body.set(d.body);
    this.preview.set(false);
    this.aiDrafted.set(true);
  }

  /** ⌘/Ctrl + Enter posts. */
  protected onKey(ev: KeyboardEvent): void {
    if (ev.key !== 'Enter' || ev.isComposing || !(ev.metaKey || ev.ctrlKey)) return;
    ev.preventDefault();
    void this.post();
  }

  protected async post(): Promise<void> {
    const body = this.body().trim();
    if (!body || this.busy()) return;
    this.busy.set(true);
    const created = await this.store.createProjectUpdate(this.project().id, {
      health: this.health(),
      body,
      ...(this.aiDrafted() ? { aiDrafted: true } : {}),
    });
    this.busy.set(false);
    if (!created) return;
    this.body.set('');
    this.preview.set(false);
    this.aiDrafted.set(false);
  }
}
