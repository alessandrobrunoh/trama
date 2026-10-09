// One project update: health is the headline, the body is the post, comments sit apart under it.
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import {
  LucideChevronDown,
  LucideDynamicIcon,
  LucideEllipsis,
  LucideMessageSquare,
  LucidePencil,
  LucideTrash2,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import {
  NablaStore,
  UiStore,
  fullDateTime,
  type Project,
  type ProjectHealth,
  type ProjectUpdate,
} from '../../core';
import { ActorAvatar } from '../../shared/actor-avatar';
import { EntityRefs } from '../../shared/entity-ref';
import { Kbd } from '../../shared/kbd';
import { Markdown } from '../../shared/markdown';
import { RelativeTimePipe } from '../../shared/pipes';
import { CommentInput } from '../workstreams/comment-input';
import { CommentThread } from '../workstreams/comments';
import { ProjectHealthBadge, ProjectHealthPicker } from './project-health';

@Component({
  selector: 'app-project-update-item',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    HlmButtonImports,
    HlmDropdownMenuImports,
    HlmTooltip,
    LucideDynamicIcon,
    ActorAvatar,
    Kbd,
    Markdown,
    RelativeTimePipe,
    CommentInput,
    CommentThread,
    ProjectHealthBadge,
    ProjectHealthPicker,
  ],
  host: {
    class: 'block min-w-0 border-b py-8 first:pt-2 last:border-b-0',
    '[attr.data-update-id]': 'update().id',
  },
  template: `
    @let u = update();
    <article>
      <header class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          @if (editing()) {
            <app-project-health-picker label="Update health" [(value)]="draftHealth" />
          } @else {
            <app-project-health [health]="u.health" />
          }
          <p
            class="text-muted-foreground mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm"
          >
            <app-actor-avatar [actor]="u.author" [size]="20" />
            <span class="text-foreground font-medium">{{ store.actorName(u.author) }}</span>
            @if (u.author.type === 'agent') {
              <span
                class="text-primary bg-primary/10 rounded px-1 text-[10px] font-medium uppercase"
                >agent</span
              >
            }
            <time [attr.datetime]="u.createdAt" [hlmTooltip]="posted()">{{
              u.createdAt | relativeTime
            }}</time>
            @if (u.editedAt) {
              <span [hlmTooltip]="'Edited ' + edited()">edited</span>
            }
            @if (u.aiDrafted) {
              <span>drafted with AI</span>
            }
          </p>
        </div>
        @if (canEdit() && !editing()) {
          <button
            hlmBtn
            variant="ghost"
            size="icon-xs"
            class="text-muted-foreground shrink-0"
            [hlmDropdownMenuTrigger]="menu"
            aria-label="Update actions"
          >
            <svg [lucideIcon]="more" [size]="14"></svg>
          </button>
          <ng-template #menu>
            <hlm-dropdown-menu class="w-44">
              <button hlmDropdownMenuItem (triggered)="startEdit()">
                <svg [lucideIcon]="pencil" [size]="14"></svg> Edit
              </button>
              <button hlmDropdownMenuItem variant="destructive" (triggered)="remove()">
                <svg [lucideIcon]="trash" [size]="14"></svg> Delete
              </button>
            </hlm-dropdown-menu>
          </ng-template>
        }
      </header>

      @if (editing()) {
        <div class="mt-4 flex flex-col gap-2">
          <app-comment-input
            label="Edit update"
            [autofocus]="true"
            [(value)]="draftBody"
            (keyed)="onEditKey($event)"
          />
          <div class="flex items-center gap-2">
            <button
              hlmBtn
              size="sm"
              type="button"
              [disabled]="!draftBody().trim()"
              (click)="saveEdit()"
            >
              Save <app-kbd keys="mod+enter" class="opacity-70 max-sm:hidden" />
            </button>
            <button hlmBtn size="sm" type="button" variant="ghost" (click)="editing.set(false)">
              Cancel
            </button>
          </div>
        </div>
      } @else {
        <app-markdown [source]="u.body" [link]="refs.linker()" class="mt-4 block" />
      }

      <div class="mt-4">
        <button
          hlmBtn
          variant="ghost"
          size="xs"
          type="button"
          class="text-muted-foreground -ml-2 gap-1.5"
          [attr.aria-expanded]="open()"
          (click)="open.set(!open())"
        >
          <svg [lucideIcon]="comment" [size]="13"></svg>
          {{
            commentCount() === 0
              ? 'Comment'
              : commentCount() === 1
                ? '1 comment'
                : commentCount() + ' comments'
          }}
          <svg
            [lucideIcon]="chevron"
            [size]="12"
            class="transition-transform"
            [class.rotate-180]="open()"
          ></svg>
        </button>
      </div>
      @if (open()) {
        <div class="border-border mt-3 border-l pl-4">
          <app-comment-thread [subject]="{ type: 'project_update', id: u.id }" />
        </div>
      }
    </article>
  `,
})
export class ProjectUpdateItem {
  protected readonly store = inject(NablaStore);
  private readonly ui = inject(UiStore);
  protected readonly refs = inject(EntityRefs);

  readonly update = input.required<ProjectUpdate>();
  readonly project = input.required<Project>();

  protected readonly more = LucideEllipsis;
  protected readonly pencil = LucidePencil;
  protected readonly trash = LucideTrash2;
  protected readonly comment = LucideMessageSquare;
  protected readonly chevron = LucideChevronDown;

  protected readonly editing = signal(false);
  protected readonly open = signal(false);
  protected readonly draftBody = signal('');
  protected readonly draftHealth = signal<ProjectHealth>('on_track');

  /** The author, or whoever manages projects. */
  protected readonly canEdit = computed(() => {
    const a = this.update().author;
    const mine = a.type === 'user' && !!a.id && a.id === this.store.me()?.id;
    return mine || this.store.allowed('manageProjects');
  });
  protected readonly commentCount = computed(
    () => this.store.commentCountFor({ type: 'project_update', id: this.update().id }),
  );
  protected readonly posted = computed(() => fullDateTime(this.update().createdAt));
  protected readonly edited = computed(() =>
    fullDateTime(this.update().editedAt ?? this.update().createdAt),
  );

  protected startEdit(): void {
    const u = this.update();
    this.draftBody.set(u.body);
    this.draftHealth.set(u.health);
    this.editing.set(true);
  }

  protected onEditKey(ev: KeyboardEvent): void {
    if (ev.key === 'Escape') this.editing.set(false);
    else if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey) && !ev.isComposing) {
      ev.preventDefault();
      this.saveEdit();
    }
  }

  protected saveEdit(): void {
    const u = this.update();
    const body = this.draftBody().trim();
    if (!body) return;
    this.editing.set(false);
    const patch: { health?: ProjectHealth; body?: string } = {};
    if (body !== u.body) patch.body = body;
    if (this.draftHealth() !== u.health) patch.health = this.draftHealth();
    if (patch.body !== undefined || patch.health !== undefined)
      void this.store.updateProjectUpdate(this.project().id, u.id, patch);
  }

  protected remove(): void {
    const u = this.update();
    this.ui.setConfirmDelete({
      title: 'Delete this update?',
      description:
        'The update and its comments are removed. The project health falls back to the previous update.',
      onConfirm: async () => {
        await this.store.deleteProjectUpdate(this.project().id, u.id);
      },
    });
  }
}
