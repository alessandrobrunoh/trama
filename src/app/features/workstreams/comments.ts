// Comment composer, single comment and a thread bound to a subject.
import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { LucideDynamicIcon, LucidePencil, LucideTrash2 } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmTextareaImports } from '@spartan-ng/helm/textarea';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import { NablaStore, Preferences, UiStore, type Comment, type SubjectRef } from '../../core';
import { ActorAvatar } from '../../shared/actor-avatar';
import { Kbd } from '../../shared/kbd';
import { Markdown } from '../../shared/markdown';
import { RelativeTimePipe } from '../../shared/pipes';

@Component({
  selector: 'app-comment-composer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmTextareaImports, HlmButtonImports, Kbd, ActorAvatar],
  host: { class: 'flex min-w-0 gap-2.5' },
  template: `
    <app-actor-avatar [actor]="{ type: 'user', id: store.me()?.id }" [size]="24" class="mt-1" />
    <div class="min-w-0 flex-1">
      <textarea
        hlmTextarea
        class="min-h-16 w-full resize-y"
        rows="2"
        [placeholder]="placeholder()"
        [attr.aria-label]="placeholder()"
        [value]="draft()"
        (input)="draft.set($any($event.target).value)"
        (keydown)="onKeydown($event)"
      ></textarea>
      <div class="mt-1.5 flex items-center justify-between gap-2">
        <span class="text-meta">Markdown supported{{ prefs.sendsOnEnter() ? ' · Shift + Enter for a new line' : '' }}</span>
        <button hlmBtn size="sm" type="button" [disabled]="!draft().trim() || busy()" (click)="send()">
          Comment <app-kbd [keys]="prefs.sendsOnEnter() ? 'enter' : 'mod+enter'" class="opacity-70 max-sm:hidden" />
        </button>
      </div>
    </div>
  `,
})
export class CommentComposer {
  protected readonly store = inject(NablaStore);
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
  imports: [ActorAvatar, Markdown, RelativeTimePipe, HlmButtonImports, HlmTextareaImports, LucideDynamicIcon, HlmTooltip],
  host: { class: 'flex min-w-0 gap-2.5' },
  template: `
    <app-actor-avatar [actor]="comment().author" [size]="24" class="mt-0.5" />
    <div class="min-w-0 flex-1">
      <div class="flex items-center gap-2 text-xs">
        <span class="text-foreground text-sm font-medium">{{ store.actorName(comment().author) }}</span>
        @if (comment().author.type === 'agent') {
          <span class="text-primary bg-primary/10 rounded px-1 text-[10px] font-medium uppercase">agent</span>
        }
        <span class="text-muted-foreground">{{ comment().createdAt | relativeTime }}</span>
        @if (mine() && !editing()) {
          <span class="ml-auto flex items-center">
            <button hlmBtn variant="ghost" size="icon-xs" aria-label="Edit comment" hlmTooltip="Edit" (click)="startEdit()">
              <svg [lucideIcon]="pencil" [size]="12"></svg>
            </button>
            <button hlmBtn variant="ghost" size="icon-xs" aria-label="Delete comment" hlmTooltip="Delete" (click)="remove()">
              <svg [lucideIcon]="trash" [size]="12"></svg>
            </button>
          </span>
        }
      </div>
      @if (editing()) {
        <textarea
          hlmTextarea
          class="mt-1 min-h-16 w-full"
          [value]="draft()"
          aria-label="Edit comment"
          (input)="draft.set($any($event.target).value)"
          (keydown.meta.enter)="saveEdit()"
          (keydown.escape)="editing.set(false)"
        ></textarea>
        <div class="mt-1.5 flex gap-2">
          <button hlmBtn size="sm" (click)="saveEdit()">Save</button>
          <button hlmBtn size="sm" variant="ghost" (click)="editing.set(false)">Cancel</button>
        </div>
      } @else {
        <app-markdown [source]="comment().body" class="mt-0.5 block" />
      }
    </div>
  `,
})
export class CommentItem {
  protected readonly store = inject(NablaStore);
  private readonly ui = inject(UiStore);
  readonly comment = input.required<Comment>();
  protected readonly editing = signal(false);
  protected readonly draft = signal('');
  protected readonly pencil = LucidePencil;
  protected readonly trash = LucideTrash2;
  protected readonly mine = computed(
    () => this.comment().author.type === 'user' && this.comment().author.id === this.store.me()?.id,
  );

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

/** All comments on a subject + composer. */
@Component({
  selector: 'app-comment-thread',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommentItem, CommentComposer],
  host: { class: 'block min-w-0' },
  template: `
    <div class="flex flex-col gap-4">
      @for (c of comments(); track c.id) {
        <app-comment-item [comment]="c" />
      } @empty {
        <p class="text-muted-foreground text-sm">No comments yet.</p>
      }
      @if (canEdit()) {
        <app-comment-composer #composer (submitted)="send($event, composer)" />
      }
    </div>
  `,
})
export class CommentThread {
  private readonly store = inject(NablaStore);
  readonly subject = input.required<SubjectRef>();
  protected readonly canEdit = computed(() => this.store.can('member'));
  protected readonly comments = computed(() => this.store.commentsFor(this.subject()));

  protected async send(body: string, composer: CommentComposer): Promise<void> {
    await this.store.addComment(this.subject(), body);
    composer.reset();
  }
}
