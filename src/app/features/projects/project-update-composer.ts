// Composer of the Updates tab: pick a health, write markdown (with preview), post.
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { NablaStore, type Project, type ProjectHealth } from '../../core';
import { ActorAvatar } from '../../shared/actor-avatar';
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
    ActorAvatar,
    Markdown,
    CommentInput,
    ProjectHealthPicker,
    ProjectAiDraftButton,
  ],
  host: { class: 'flex min-w-0 gap-2.5 rounded-lg border p-3' },
  template: `
    <app-actor-avatar [actor]="{ type: 'user', id: store.me()?.id }" [size]="24" class="mt-0.5" />
    <div class="flex min-w-0 flex-1 flex-col gap-2.5">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <app-project-health-picker [(value)]="health" [disabled]="busy()" />
        <app-project-ai-draft-button [project]="project()" (draft)="applyDraft($event)" />
      </div>

      <div class="flex items-center gap-1" role="group" aria-label="Editor mode">
        <button
          hlmBtn
          type="button"
          size="xs"
          [variant]="preview() ? 'ghost' : 'secondary'"
          [attr.aria-pressed]="!preview()"
          (click)="preview.set(false)"
        >
          Write
        </button>
        <button
          hlmBtn
          type="button"
          size="xs"
          [variant]="preview() ? 'secondary' : 'ghost'"
          [attr.aria-pressed]="preview()"
          [disabled]="!body().trim()"
          (click)="preview.set(true)"
        >
          Preview
        </button>
      </div>

      @if (preview() && body().trim()) {
        <div class="min-h-24 rounded-md border px-3 py-2">
          <app-markdown [source]="body()" [link]="refs.linker()" />
        </div>
      } @else {
        <app-comment-input
          label="Project update"
          placeholder="What happened since the last update? Progress, blockers, what is next… Markdown supported."
          [(value)]="body"
          (keyed)="onKey($event)"
        />
      }

      <div class="flex items-center justify-between gap-2">
        <span class="text-meta">Markdown supported · @ to mention, # to link</span>
        <button hlmBtn size="sm" type="button" [disabled]="!canPost() || busy()" (click)="post()">
          Post update <app-kbd keys="mod+enter" class="opacity-70 max-sm:hidden" />
        </button>
      </div>
    </div>
  `,
})
export class ProjectUpdateComposer {
  protected readonly store = inject(NablaStore);
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
