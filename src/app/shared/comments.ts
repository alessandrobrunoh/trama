// Comment composer, single comment and a thread bound to a subject.
import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  booleanAttribute,
  computed,
  effect,
  inject,
  input,
  untracked,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { LucideDynamicIcon, LucidePencil, LucideQuote, LucideTrash2 } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import {
  DraftStore,
  TramaStore,
  Preferences,
  UiStore,
  fullDate,
  shortDate,
  type Comment,
  type SubjectRef,
} from '../core';
import { ActorAvatar } from './actor-avatar';
import { EntityRefs } from './entity-ref';
import { Kbd } from './kbd';
import { Markdown } from './markdown';
import { UploadFile } from './upload-file';
import { CommentInput } from './comment-input';
import { splitQuote, toQuote } from './comment-quote';

/**
 * Comment box. The default is a card (input on top, hint and send row under it). `dock` is the bottom bar of
 * the task page: one expanding line with the send key on the right.
 */
@Component({
  selector: 'app-comment-composer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButtonImports, Kbd, CommentInput, UploadFile, HlmTooltip],
  host: {
    class: 'block min-w-0',
    '[class]': 'dock() ? \'\' : mobileSticky',
  },
  template: `
    @if (dock()) {
      <!-- v3 "Composer": a 40px hairline box, the placeholder on the left, the send key on the right. -->
      <div
        class="border-border focus-within:border-border-strong flex min-h-10 items-end gap-2 border py-px pr-2 pl-3"
      >
        <app-comment-input
          #composer
          class="min-w-0 flex-1 [&_textarea]:max-h-40 [&_textarea]:min-h-9 [&_textarea]:resize-none [&_textarea]:rounded-none [&_textarea]:border-0 [&_textarea]:bg-transparent [&_textarea]:px-0! [&_textarea]:py-2 [&_textarea]:text-[13px] [&_textarea]:shadow-none [&_textarea]:focus-visible:ring-0 dark:[&_textarea]:bg-transparent"
          compact
          [placeholder]="placeholder()"
          [(value)]="draft"
          (keyed)="onKeydown($event)"
        />
        <button
          type="button"
          class="bg-secondary border-border text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex shrink-0 items-center self-center border px-[5px] font-mono text-[10.5px] leading-[14px] outline-none focus-visible:ring-2 disabled:pointer-events-none"
          aria-label="Send comment"
          [hlmTooltip]="'Send · ' + (prefs.sendsOnEnter() ? '↵' : '⌘↵')"
          [disabled]="!draft().trim() || busy()"
          (click)="send()"
        >
          {{ prefs.sendsOnEnter() ? '↵' : '⌘↵' }}
        </button>
      </div>
    } @else {
      <div class="bg-card focus-within:ring-ring/40 overflow-hidden rounded-lg focus-within:ring-2">
        <app-comment-input
          #composer
          class="[&_textarea]:rounded-none [&_textarea]:border-0 [&_textarea]:bg-transparent [&_textarea]:px-3 [&_textarea]:py-2.5 [&_textarea]:shadow-none [&_textarea]:focus-visible:ring-0"
          [placeholder]="placeholder()"
          [(value)]="draft"
          (keyed)="onKeydown($event)"
        />
        <div class="flex items-center justify-between gap-2 px-3 py-2 max-md:justify-end">
          <span class="text-meta max-md:hidden"
            >Markdown · @ to mention, # to link{{
              prefs.sendsOnEnter() ? ' · Shift + Enter for a new line' : ''
            }}</span
          >
          <span class="ml-auto flex items-center gap-2">
            <app-upload-file
              label="Attach"
              variant="ghost"
              [busy]="uploading()"
              (file)="attach($event)"
            />
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
          </span>
        </div>
      </div>
    }
  `,
})
export class CommentComposer {
  protected readonly prefs = inject(Preferences);
  private readonly drafts = inject(DraftStore);
  private readonly store = inject(TramaStore);
  private readonly composer = viewChild<CommentInput>('composer');
  protected readonly mobileSticky =
    'max-md:bg-background max-md:sticky max-md:bottom-0 max-md:z-[5] max-md:-mx-4 max-md:px-4 max-md:py-2';
  readonly placeholder = input('Leave a comment…');
  /** The slim bottom bar of the task page instead of the card. */
  readonly dock = input(false, { transform: booleanAttribute });
  /** Keeps the unsent text under this key, so it survives navigation and refresh (e.g. `comment:issue:in_x`). */
  readonly draftKey = input<string>();
  readonly submitted = output<string>();
  protected readonly draft = signal('');
  protected readonly busy = signal(false);
  protected readonly uploading = signal(false);

  protected async attach(file: File): Promise<void> {
    if (this.uploading()) return;
    this.uploading.set(true);
    try {
      const markdown = await this.store.stageUpload(file);
      if (!markdown) return;
      const text = this.draft().trim() ? `\n\n${markdown}\n` : `${markdown}\n`;
      this.composer()?.insert(text);
    } finally {
      this.uploading.set(false);
    }
  }

  constructor() {
    // Order matters: restore first, then persist what is typed.
    effect(() => {
      const key = this.draftKey();
      if (key) untracked(() => this.draft.set(this.drafts.get<string>(key) ?? ''));
    });
    effect(() => {
      const key = this.draftKey();
      const text = this.draft();
      if (key) this.drafts.set(key, text.trim() ? text : null);
    });
  }

  /** Starts the draft with a quote of `text` (the "Quote reply" action) and focuses the box. */
  quote(text: string): void {
    this.composer()?.append(toQuote(text));
  }

  focus(): void {
    this.composer()?.focus();
  }

  /** Parent awaits the write and calls this to clear the draft. */
  reset(): void {
    this.draft.set('');
    const key = this.draftKey();
    if (key) this.drafts.set(key, null);
    this.busy.set(false);
  }

  /** The write failed (the store already toasted): keep the draft so it can be sent again. */
  fail(): void {
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
    HlmButtonImports,
    LucideDynamicIcon,
    HlmTooltip,
    CommentInput,
    UploadFile,
  ],
  host: {
    class: 'group/comment block min-w-0',
    '[attr.id]': '"comment-" + comment().id',
  },
  template: `
    <div class="flex min-w-0 gap-3">
      <app-actor-avatar [actor]="comment().author" [size]="22" />
      <div class="flex min-w-0 flex-1 flex-col gap-1">
        <div class="flex min-w-0 items-baseline gap-x-2 gap-y-0.5">
          <span class="text-foreground truncate text-[13px] leading-[17px] font-semibold">{{
            store.actorName(comment().author)
          }}</span>
          @if (comment().author.type === 'agent') {
            <span
              class="text-primary bg-primary/10 shrink-0 px-1 font-mono text-[10px] leading-[14px] uppercase"
              >agent</span
            >
          }
          <time
            class="text-faint shrink-0 font-mono text-[10.5px] leading-[14px]"
            [attr.datetime]="comment().createdAt"
            >{{ shortAgo() }} · via {{ origin() }}</time
          >
          @if (modified()) {
            <span
              class="text-faint shrink-0 font-mono text-[10.5px] leading-[14px]"
              [hlmTooltip]="full(comment().updatedAt)"
              >edited</span
            >
          }
          @if (!editing() && (mine() || quotable())) {
            <span
              class="ml-auto flex shrink-0 items-center opacity-100 sm:opacity-0 sm:group-focus-within/comment:opacity-100 sm:group-hover/comment:opacity-100"
            >
              @if (quotable()) {
                <button
                  hlmBtn
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Quote in a reply"
                  hlmTooltip="Quote reply"
                  (click)="quoteReply()"
                >
                  <svg [lucideIcon]="quoteIcon" [size]="12"></svg>
                </button>
              }
              @if (mine()) {
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
              }
            </span>
          }
        </div>
        @if (editing()) {
          <app-comment-input
            #edit
            class="mt-2"
            label="Edit comment"
            [autofocus]="true"
            [(value)]="draft"
            (keyed)="onEditKey($event)"
          />
          <div class="mt-2 flex gap-2">
            <button hlmBtn size="sm" (click)="saveEdit()">Save</button>
            <button hlmBtn size="sm" variant="ghost" (click)="editing.set(false)">Cancel</button>
            <app-upload-file
              label="Attach"
              variant="ghost"
              [busy]="uploading()"
              (file)="attach($event)"
            />
          </div>
        } @else if (parts().quote; as quoted) {
          <!-- A reply to quoted text: the quote on top, the answer under a colored bar. -->
          <div class="border-border bg-card mt-1.5 overflow-hidden rounded-lg border">
            <p class="px-3 pt-2 text-sm leading-relaxed">
              <span class="bg-tone-violet/15 decoration-tone-violet/60 rounded-sm px-0.5 whitespace-pre-line underline decoration-1 underline-offset-2">{{ quoted }}</span>
            </p>
            @if (parts().rest) {
              <div class="border-tone-violet bg-background m-2 rounded-sm border-l-2 px-3 py-1.5">
                <app-markdown [source]="parts().rest" [link]="refs.linker()" class="block [&_a]:underline [&_a]:underline-offset-2" />
              </div>
            } @else {
              <div class="h-2"></div>
            }
          </div>
        } @else {
          <app-markdown [source]="comment().body" [link]="refs.linker()" class="block text-[13.5px]! leading-[21px]! text-text-2 [&_a]:underline [&_a]:underline-offset-2" />
        }
      </div>
    </div>
  `,
})
export class CommentItem {
  protected readonly store = inject(TramaStore);
  private readonly ui = inject(UiStore);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly document = inject(DOCUMENT);
  protected readonly refs = inject(EntityRefs);
  protected readonly full = fullDate;
  readonly comment = input.required<Comment>();
  /** Offers "Quote reply": emits the selected text of this comment, or its whole text. */
  readonly quotable = input(false, { transform: booleanAttribute });
  readonly quote = output<string>();
  protected readonly quoteIcon = LucideQuote;
  protected readonly parts = computed(() => splitQuote(this.comment().body));
  /** "just now", "5m", "2h", "3d", then the date: how the activity frames write a comment's age. */
  protected readonly shortAgo = computed(() => {
    const ms = Date.now() - Date.parse(this.comment().createdAt);
    const min = Math.floor(ms / 60_000);
    if (ms < 45_000) return 'just now';
    if (min < 60) return `${Math.max(min, 1)}m`;
    if (min < 60 * 24) return `${Math.floor(min / 60)}h`;
    if (min < 60 * 24 * 14) return `${Math.floor(min / (60 * 24))}d`;
    return shortDate(this.comment().createdAt);
  });
  /** Where the comment was written: agents write from their Delta thread, people in Trama. */
  protected readonly origin = computed(() => (this.comment().author.type === 'agent' ? 'Delta' : 'Trama'));

  protected quoteReply(): void {
    const selection = this.document.getSelection();
    const selected = selection?.toString().trim() ?? '';
    const inside = !!selection?.anchorNode && this.host.nativeElement.contains(selection.anchorNode);
    const { quote, rest } = this.parts();
    const text = inside && selected ? selected : (rest || quote || '').trim();
    if (text) this.quote.emit(text.length > 400 ? `${text.slice(0, 400).trimEnd()}…` : text);
  }
  protected readonly editing = signal(false);
  protected readonly draft = signal('');
  protected readonly uploading = signal(false);
  protected readonly pencil = LucidePencil;
  protected readonly trash = LucideTrash2;
  private readonly edit = viewChild<CommentInput>('edit');
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

  protected async attach(file: File): Promise<void> {
    if (this.uploading()) return;
    this.uploading.set(true);
    try {
      const markdown = await this.store.stageUpload(file);
      if (!markdown) return;
      const text = this.draft().trim() ? `\n\n${markdown}\n` : `${markdown}\n`;
      this.edit()?.insert(text);
    } finally {
      this.uploading.set(false);
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
  host: { class: 'block not-has-[*]:hidden' },
  template: `
    @if (thread().state === 'error') {
      <p class="text-muted-foreground text-xs">
        Comments could not be loaded.
        <button type="button" class="hover:text-foreground underline" (click)="reload()">
          Retry
        </button>
      </p>
    } @else if (thread().state === 'loading') {
      <p class="text-muted-foreground text-xs">Loading comments…</p>
    }
    @if (thread().nextCursor !== null) {
      <div class="mt-3 flex justify-center">
        <button
          hlmBtn
          variant="outline"
          size="sm"
          [disabled]="thread().loadingMore"
          (click)="more()"
        >
          {{ thread().loadingMore ? 'Loading…' : 'Load older comments' }}
        </button>
      </div>
    }
  `,
})
export class CommentsLoader {
  private readonly store = inject(TramaStore);
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
        <app-comment-composer
          #composer
          [draftKey]="'comment:' + subject().type + ':' + subject().id"
          (submitted)="send($event, composer)"
        />
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
  private readonly store = inject(TramaStore);
  readonly subject = input.required<SubjectRef>();
  protected readonly canEdit = computed(() => this.store.can('member'));
  protected readonly comments = computed(() =>
    [...this.store.commentsFor(this.subject())].sort((a, b) =>
      a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
    ),
  );

  protected async send(body: string, composer: CommentComposer): Promise<void> {
    const posted = await this.store.addComment(this.subject(), body);
    if (posted) composer.reset();
    else composer.fail();
  }
}
