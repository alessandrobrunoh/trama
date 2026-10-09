// Comment composer, single comment and a thread bound to a subject.
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  untracked,
  output,
  signal,
} from '@angular/core';
import { LucideDynamicIcon, LucidePencil, LucideTrash2 } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import {
  NablaStore,
  Preferences,
  UiStore,
  fullDate,
  type Comment,
  type SubjectRef,
} from '../../core';
import { ActorAvatar } from '../../shared/actor-avatar';
import { EntityRefs } from '../../shared/entity-ref';
import { Kbd } from '../../shared/kbd';
import { Markdown } from '../../shared/markdown';
import { RelativeTimePipe } from '../../shared/pipes';
import { CommentInput } from './comment-input';

@Component({
  selector: 'app-comment-composer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButtonImports, Kbd, CommentInput],
  host: { class: 'block min-w-0' },
  template: `
    <div class="bg-card overflow-hidden rounded-lg border">
      <app-comment-input
        class="[&_textarea]:rounded-none [&_textarea]:border-0 [&_textarea]:bg-transparent [&_textarea]:px-3 [&_textarea]:py-2.5 [&_textarea]:shadow-none [&_textarea]:focus-visible:ring-0"
        [placeholder]="placeholder()"
        [(value)]="draft"
        (keyed)="onKeydown($event)"
      />
      <div class="flex items-center justify-between gap-2 border-t px-3 py-2">
        <span class="text-meta"
          >Markdown · @ to mention, # to link{{
            prefs.sendsOnEnter() ? ' · Shift + Enter for a new line' : ''
          }}</span
        >
        <button
          hlmBtn
          size="sm"
          type="button"
          [disabled]="!draft().trim() || busy()"
          (click)="send()"
        >
          Comment
          <app-kbd
            [keys]="prefs.sendsOnEnter() ? 'enter' : 'mod+enter'"
            class="opacity-70 max-sm:hidden"
          />
        </button>
      </div>
    </div>
  `,
})
export class CommentComposer {
  protected readonly prefs = inject(Preferences);
  readonly placeholder = input('Leave a comment…');
  readonly submitted = output<string>();
  protected readonly draft = signal('');
  protected readonly busy = signal(false);

  /** Parent awaits the write and calls this to clear the draft. */
  reset(): void {
    this.draft.set('');
    this.busy.set(false);
  }

  /** ⌘/Ctrl + Enter always sends; plain Enter sends only when the user prefers it (Shift + Enter adds a line). */
  protected onKeydown(ev: KeyboardEvent): void {
    if (ev.key !== 'Enter' || ev.isComposing) return;
    const modified = ev.metaKey || ev.ctrlKey;
    if (!modified && (!this.prefs.sendsOnEnter() || ev.shiftKey || ev.altKey)) return;
    ev.preventDefault();
    this.send();
  }

  protected send(): void {
    const body = this.draft().trim();
    if (!body || this.busy()) return;
    this.busy.set(true);
    this.submitted.emit(body);
  }
}

@Component({
  selector: 'app-comment-item',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ActorAvatar,
    Markdown,
    RelativeTimePipe,
    HlmButtonImports,
    LucideDynamicIcon,
    HlmTooltip,
    CommentInput,
  ],
  host: { class: 'group/comment block min-w-0' },
  template: `
    <div class="flex min-w-0 gap-3">
      <app-actor-avatar [actor]="comment().author" [size]="28" class="mt-0.5" />
      <div class="min-w-0 flex-1">
        <div class="flex min-w-0 items-baseline gap-x-2 gap-y-0.5">
          <span class="text-foreground truncate text-sm font-medium">{{
            store.actorName(comment().author)
          }}</span>
          @if (comment().author.type === 'agent') {
            <span
              class="text-primary bg-primary/10 shrink-0 rounded px-1 text-[10px] font-medium uppercase"
              >agent</span
            >
          }
          <time
            class="text-muted-foreground shrink-0 text-xs"
            [attr.datetime]="comment().createdAt"
            >{{ comment().createdAt | relativeTime }}</time
          >
          @if (modified()) {
            <span
              class="text-muted-foreground shrink-0 text-xs"
              [hlmTooltip]="full(comment().updatedAt)"
              >edited</span
            >
          }
          @if (mine() && !editing()) {
            <span
              class="ml-auto flex shrink-0 items-center opacity-100 sm:opacity-0 sm:group-focus-within/comment:opacity-100 sm:group-hover/comment:opacity-100"
            >
              <button
                hlmBtn
                variant="ghost"
                size="icon-xs"
                aria-label="Edit comment"
                hlmTooltip="Edit"
                (click)="startEdit()"
              >
                <svg [lucideIcon]="pencil" [size]="12"></svg>
              </button>
              <button
                hlmBtn
                variant="ghost"
                size="icon-xs"
                aria-label="Delete comment"
                hlmTooltip="Delete"
                (click)="remove()"
              >
                <svg [lucideIcon]="trash" [size]="12"></svg>
              </button>
            </span>
          }
        </div>
        @if (editing()) {
          <app-comment-input
            class="mt-2"
            label="Edit comment"
            [autofocus]="true"
            [(value)]="draft"
            (keyed)="onEditKey($event)"
          />
          <div class="mt-2 flex gap-2">
            <button hlmBtn size="sm" (click)="saveEdit()">Save</button>
            <button hlmBtn size="sm" variant="ghost" (click)="editing.set(false)">Cancel</button>
          </div>
        } @else {
          <app-markdown [source]="comment().body" [link]="refs.linker()" class="mt-1 block" />
        }
      </div>
    </div>
  `,
})
export class CommentItem {
  protected readonly store = inject(NablaStore);
  private readonly ui = inject(UiStore);
  protected readonly refs = inject(EntityRefs);
  protected readonly full = fullDate;
  readonly comment = input.required<Comment>();
  protected readonly editing = signal(false);
  protected readonly draft = signal('');
  protected readonly pencil = LucidePencil;
  protected readonly trash = LucideTrash2;
  protected readonly mine = computed(
    () => this.comment().author.type === 'user' && this.comment().author.id === this.store.me()?.id,
  );

  /** Edited after posting (the server stamps both dates together on creation). */
  protected readonly modified = computed(
    () => Date.parse(this.comment().updatedAt) - Date.parse(this.comment().createdAt) > 1000,
  );

  protected onEditKey(ev: KeyboardEvent): void {
    if (ev.key === 'Escape') this.editing.set(false);
    else if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey) && !ev.isComposing) {
      ev.preventDefault();
      this.saveEdit();
    }
  }

  protected startEdit(): void {
    this.draft.set(this.comment().body);
    this.editing.set(true);
  }

  protected saveEdit(): void {
    const body = this.draft().trim();
    this.editing.set(false);
    if (body && body !== this.comment().body) void this.store.editComment(this.comment().id, body);
  }

  protected remove(): void {
    this.ui.setConfirmDelete({
      title: 'Delete comment?',
      description: 'This cannot be undone.',
      onConfirm: async () => {
        await this.store.deleteComment(this.comment().id);
      },
    });
  }
}

/** All comments on a subject + composer, newest first. */
/**
 * Loads the newest page of a subject's comments when it appears (comments are not part of the workspace
 * snapshot) and offers "Load older comments" while more pages exist. Renders nothing otherwise.
 */
@Component({
  selector: 'app-comments-loader',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButtonImports],
  host: { class: 'block' },
  template: `
    @if (thread().state === 'error') {
      <p class="text-muted-foreground text-xs">
        Comments could not be loaded.
        <button type="button" class="hover:text-foreground underline" (click)="reload()">Retry</button>
      </p>
    } @else if (thread().state === 'loading') {
      <p class="text-muted-foreground text-xs">Loading comments…</p>
    }
    @if (thread().nextCursor !== null) {
      <div class="mt-3 flex justify-center">
        <button hlmBtn variant="outline" size="sm" [disabled]="thread().loadingMore" (click)="more()">
          {{ thread().loadingMore ? 'Loading…' : 'Load older comments' }}
        </button>
      </div>
    }
  `,
})
export class CommentsLoader {
  private readonly store = inject(NablaStore);
  readonly subject = input.required<SubjectRef>();
  protected readonly thread = computed(() => this.store.commentThread(this.subject()));

  constructor() {
    effect(() => {
      const subject = this.subject();
      // Wait for the workspace: before that there is no slug to load from.
      if (!this.store.ready()) return;
      untracked(() => void this.store.loadComments(subject));
    });
  }

  protected reload(): void {
    void this.store.loadComments(this.subject(), { force: true });
  }

  protected more(): void {
    void this.store.loadMoreComments(this.subject());
  }
}

@Component({
  selector: 'app-comment-thread',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommentItem, CommentComposer, CommentsLoader],
  host: { class: 'block min-w-0' },
  template: `
    <div class="flex flex-col gap-5">
      @if (canEdit()) {
        <app-comment-composer #composer (submitted)="send($event, composer)" />
      }
      @for (c of comments(); track c.id) {
        <app-comment-item [comment]="c" />
      } @empty {
        @if (!canEdit()) {
          <p class="text-muted-foreground text-sm">No comments yet.</p>
        }
      }
      <app-comments-loader [subject]="subject()" />
    </div>
  `,
})
export class CommentThread {
  private readonly store = inject(NablaStore);
  readonly subject = input.required<SubjectRef>();
  protected readonly canEdit = computed(() => this.store.can('member'));
  protected readonly comments = computed(() =>
    [...this.store.commentsFor(this.subject())].sort((a, b) =>
      a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
    ),
  );

  protected async send(body: string, composer: CommentComposer): Promise<void> {
    await this.store.addComment(this.subject(), body);
    composer.reset();
  }
}
