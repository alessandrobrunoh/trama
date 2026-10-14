// Building blocks of the issue page: title + description editors and the merged activity / comments
// feed.
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import {
  LucideArrowRight,
  LucideCircleDot,
  LucideDynamicIcon,
  LucidePencil,
  type LucideIcon,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmTextareaImports } from '@spartan-ng/helm/textarea';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import {
  ISSUE_STATUS_META,
  TramaStore,
  fullDate,
  type Comment,
  type DomainEvent,
  type Issue,
  type IssueStatus,
} from '../../core';
import { ActorAvatar } from '../../shared/actor-avatar';
import { UploadFile } from '../../shared/upload-file';
import { EntityChip } from '../../shared/entity-chip';
import { Kbd } from '../../shared/kbd';
import { Markdown } from '../../shared/markdown';
import { RelativeTimePipe } from '../../shared/pipes';
import { StatusIcon } from '../../shared/status';
import { CommentComposer, CommentItem, CommentsLoader } from '../../shared/comments';

// ───────────────────────── title ─────────────────────────

/** Large title; click to edit (Enter saves, Esc cancels, blur saves). */
@Component({
  selector: 'app-issue-title',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    @if (editing()) {
      <textarea
        #ta
        rows="1"
        class="bg-transparent w-full resize-none overflow-hidden rounded-md text-2xl leading-tight font-semibold tracking-tight outline-none"
        aria-label="Issue title"
        [value]="draft()"
        (input)="onInput($event)"
        (keydown.enter)="$event.preventDefault(); commit()"
        (keydown.escape)="cancel($event)"
        (blur)="commit()"
      ></textarea>
    } @else {
      <h1
        class="-mx-1 rounded-md px-1 text-2xl leading-tight font-semibold tracking-tight break-words"
        [class]="canEdit() ? 'hover:bg-hover cursor-text' : ''"
        [attr.role]="canEdit() ? 'button' : null"
        [attr.tabindex]="canEdit() ? 0 : null"
        [attr.aria-label]="canEdit() ? 'Edit title: ' + value() : null"
        (click)="start()"
        (keydown.enter)="start()"
      >
        {{ value() }}
      </h1>
    }
  `,
})
export class IssueTitle {
  readonly value = input.required<string>();
  readonly canEdit = input(true);
  readonly save = output<string>();
  protected readonly editing = signal(false);
  protected readonly draft = signal('');
  private readonly ta = viewChild<ElementRef<HTMLTextAreaElement>>('ta');
  private skip = false;

  constructor() {
    effect(() => {
      const el = this.ta()?.nativeElement;
      if (!el) return;
      this.autosize(el);
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }

  /** Programmatic entry point (keyboard shortcut). */
  start(): void {
    if (!this.canEdit()) return;
    this.draft.set(this.value());
    this.editing.set(true);
  }

  protected onInput(e: Event): void {
    const el = e.target as HTMLTextAreaElement;
    this.draft.set(el.value.replace(/\n/g, ' '));
    this.autosize(el);
  }

  protected commit(): void {
    if (!this.editing() || this.skip) return;
    const v = this.draft().trim();
    this.editing.set(false);
    if (v && v !== this.value().trim()) this.save.emit(v);
  }

  protected cancel(e: Event): void {
    e.stopPropagation();
    e.preventDefault();
    this.skip = true;
    this.editing.set(false);
    queueMicrotask(() => (this.skip = false));
  }

  private autosize(el: HTMLTextAreaElement): void {
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }
}

// ───────────────────────── description ─────────────────────────

/** Markdown description: click to edit, Write / Preview tabs, ⌘↵ saves, Esc cancels. */
@Component({
  selector: 'app-issue-description',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmTextareaImports, HlmButtonImports, Markdown, Kbd, LucideDynamicIcon, UploadFile],
  host: { class: 'block' },
  template: `
    @if (editing()) {
      <div class="border-border-strong rounded-lg border">
        <div class="flex items-center gap-0.5 border-b px-1.5 py-1">
          <button
            type="button"
            class="h-6 rounded-md px-2 text-xs"
            [class]="
              tab() === 'write'
                ? 'bg-accent text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            "
            (click)="tab.set('write')"
          >
            Write
          </button>
          <button
            type="button"
            class="h-6 rounded-md px-2 text-xs"
            [class]="
              tab() === 'preview'
                ? 'bg-accent text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            "
            (click)="tab.set('preview')"
          >
            Preview
          </button>
          <app-upload-file
            class="ml-auto"
            label="Image or file"
            variant="ghost"
            size="xs"
            [busy]="uploading()"
            (file)="addFile($event)"
          />
          <span class="text-meta pr-1">Markdown</span>
        </div>
        @if (tab() === 'write') {
          <textarea
            #ta
            class="min-h-40 w-full resize-y bg-transparent px-3 py-2.5 text-sm leading-relaxed outline-none"
            aria-label="Description"
            placeholder="Steps to reproduce, expected vs. actual, links, screenshots…"
            [value]="draft()"
            (input)="draft.set($any($event.target).value)"
            (keydown.meta.enter)="commit()"
            (keydown.control.enter)="commit()"
            (keydown.escape)="cancel($event)"
          ></textarea>
        } @else {
          <div class="min-h-40 px-3 py-2.5">
            @if (draft().trim()) {
              <app-markdown [source]="draft()" />
            } @else {
              <p class="text-muted-foreground text-sm">Nothing to preview.</p>
            }
          </div>
        }
        <div class="flex items-center justify-end gap-2 border-t px-2 py-1.5">
          <button hlmBtn size="sm" variant="ghost" type="button" (click)="cancel()">
            Cancel
          </button>
          <button hlmBtn size="sm" type="button" (click)="commit()">
            Save <app-kbd keys="mod+enter" class="opacity-70" />
          </button>
        </div>
      </div>
    } @else {
      <div
        class="group/md relative -mx-2 rounded-md px-2 py-1.5"
        [class]="canEdit() ? 'hover:bg-hover cursor-text' : ''"
        [attr.role]="canEdit() ? 'button' : null"
        [attr.tabindex]="canEdit() ? 0 : null"
        [attr.aria-label]="canEdit() ? 'Edit description' : null"
        (click)="onClick($event)"
        (keydown.enter)="start()"
      >
        @if (value().trim()) {
          <app-markdown [source]="value()" />
        } @else {
          <p class="text-muted-foreground text-sm">
            {{
              canEdit()
                ? 'Add a description: steps to reproduce, who is affected, links…'
                : 'No description.'
            }}
          </p>
        }
        @if (canEdit()) {
          <svg
            [lucideIcon]="pencil"
            [size]="13"
            class="text-muted-foreground absolute top-2 right-2 opacity-0 group-hover/md:opacity-100"
          ></svg>
        }
      </div>
    }
  `,
})
export class IssueDescription {
  private readonly store = inject(TramaStore);
  readonly value = input('');
  readonly canEdit = input(true);
  readonly save = output<string>();
  protected readonly editing = signal(false);
  protected readonly tab = signal<'write' | 'preview'>('write');
  protected readonly draft = signal('');
  protected readonly uploading = signal(false);
  protected readonly pencil = LucidePencil;
  private readonly ta = viewChild<ElementRef<HTMLTextAreaElement>>('ta');

  constructor() {
    effect(() => {
      const el = this.ta()?.nativeElement;
      if (el) {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
    });
  }

  start(): void {
    if (!this.canEdit() || this.editing()) return;
    this.draft.set(this.value());
    this.tab.set('write');
    this.editing.set(true);
  }

  protected async addFile(file: File): Promise<void> {
    if (this.uploading()) return;
    this.tab.set('write');
    this.uploading.set(true);
    try {
      const markdown = await this.store.stageUpload(file);
      if (markdown) this.insert(this.draft().trim() ? `\n\n${markdown}\n` : `${markdown}\n`);
    } finally {
      this.uploading.set(false);
    }
  }

  private insert(text: string): void {
    const el = this.ta()?.nativeElement;
    if (!el) {
      this.draft.update((v) => v + text);
      return;
    }
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    const next = `${el.value.slice(0, start)}${text}${el.value.slice(end)}`;
    el.value = next;
    el.setSelectionRange(start + text.length, start + text.length);
    this.draft.set(next);
    el.focus();
  }

  protected onClick(e: MouseEvent): void {
    if ((e.target as HTMLElement).closest('a, input')) return;
    this.start();
  }

  protected commit(): void {
    const v = this.draft().trim();
    this.editing.set(false);
    if (v !== this.value().trim()) this.save.emit(v);
  }

  protected cancel(e?: Event): void {
    e?.stopPropagation();
    e?.preventDefault();
    this.store.discardDraftUploads(this.value(), this.draft());
    this.editing.set(false);
  }
}

// ───────────────────────── activity ─────────────────────────

interface EventView {
  icon: LucideIcon | null;
  verb: string;
  from?: IssueStatus;
  to?: IssueStatus;
}

const FIELD_VERB: Record<string, string> = {
  title: 'renamed the issue',
  body: 'edited the description',
  assigneeId: 'changed the assignee',
  teamId: 'moved the issue to another team',
  priority: 'changed the priority',
  reporterName: 'updated the reporter',
  externalUrl: 'updated the external link',
  duplicateOfId: 'changed the duplicate relation',
};

function describe(ev: DomainEvent): EventView | null {
  const d = ev.data;
  const isStatus = (v: unknown): v is IssueStatus =>
    typeof v === 'string' && v in ISSUE_STATUS_META;
  switch (ev.type) {
    case 'issue.created':
      return { icon: LucideCircleDot, verb: 'created the issue' };
    case 'issue.status_changed':
      return {
        icon: null,
        verb: 'changed status',
        from: isStatus(d['from']) ? d['from'] : undefined,
        to: isStatus(d['to']) ? d['to'] : undefined,
      };
    case 'issue.updated': {
      const fields = Array.isArray(d['fields']) ? (d['fields'] as string[]) : [];
      const verbs = fields.map((f) => FIELD_VERB[f] ?? `updated ${f}`);
      return { icon: LucidePencil, verb: verbs.length ? verbs.join(', ') : 'updated the issue' };
    }
    case 'issue.linked':
      return { icon: LucideCircleDot, verb: 'recorded a legacy issue link' };
    case 'comment.created':
      return null; // the comment itself is in the feed
    default:
      return { icon: LucideCircleDot, verb: ev.type.replace(/^issue\./, '').replace(/[._]/g, ' ') };
  }
}

type FeedItem =
  | { kind: 'event'; id: string; at: string; ev: DomainEvent; view: EventView }
  | { kind: 'comment'; id: string; at: string; c: Comment };

/** Activity events and comments, newest first, with the composer on top. */
@Component({
  selector: 'app-issue-activity',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ActorAvatar,
    LucideDynamicIcon,
    StatusIcon,
    EntityChip,
    RelativeTimePipe,
    CommentItem,
    CommentComposer,
    CommentsLoader,
    HlmTooltip,
  ],
  host: { class: 'block' },
  template: `
    <h2 class="mb-3 text-sm font-semibold">Activity</h2>
    @if (canEdit()) {
      <div class="mb-4">
        <app-comment-composer
          #composer
          placeholder="Leave a comment…"
          [draftKey]="'comment:issue:' + issue().id"
          (submitted)="send($event, composer)"
        />
      </div>
    }
    <ol class="relative flex flex-col gap-3">
      @for (f of visible(); track f.id) {
        @if (f.kind === 'event') {
          <li class="text-muted-foreground flex min-h-6 items-center gap-2.5 text-xs">
            <span class="flex w-6 shrink-0 justify-center">
              @if (f.view.icon) {
                <svg [lucideIcon]="f.view.icon" [size]="13"></svg>
              } @else if (f.view.to) {
                <app-status-icon [status]="f.view.to" entity="issue" [size]="13" />
              }
            </span>
            <span class="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-1">
              <app-actor-avatar [actor]="f.ev.actor" [size]="14" />
              <span class="text-foreground font-medium">{{ store.actorName(f.ev.actor) }}</span>
              <span>{{ f.view.verb }}</span>
              @if (f.view.from) {
                <span class="inline-flex items-center gap-1"
                  ><app-status-icon [status]="f.view.from" entity="issue" [size]="12" />{{
                    statusLabel(f.view.from)
                  }}</span
                >
                <svg [lucideIcon]="arrow" [size]="11"></svg>
              }
              @if (f.view.to) {
                <span class="text-foreground inline-flex items-center gap-1"
                  ><app-status-icon [status]="f.view.to" entity="issue" [size]="12" />{{
                    statusLabel(f.view.to)
                  }}</span
                >
              }
              <span aria-hidden="true">·</span>
              <time [attr.datetime]="f.at" [hlmTooltip]="full(f.at)">{{
                f.at | relativeTime
              }}</time>
            </span>
          </li>
        } @else {
          <li>
            <app-comment-item [comment]="f.c" />
          </li>
        }
      } @empty {
        <li class="text-muted-foreground text-sm">No activity yet.</li>
      }
    </ol>
    @if (hiddenCount() > 0) {
      <button
        type="button"
        class="text-muted-foreground hover:text-foreground mt-3 text-xs"
        (click)="all.set(true)"
      >
        Show {{ hiddenCount() }} older {{ hiddenCount() === 1 ? 'event' : 'events' }}
      </button>
    }
    <app-comments-loader [subject]="subject()" class="mt-3" />
  `,
})
export class IssueActivity {
  protected readonly store = inject(TramaStore);
  readonly issue = input.required<Issue>();
  protected readonly all = signal(false);
  protected readonly arrow = LucideArrowRight;
  protected readonly canEdit = computed(() => this.store.can('member'));
  protected readonly subject = computed(() => ({ type: 'issue' as const, id: this.issue().id }));

  private readonly feed = computed<FeedItem[]>(() => {
    const i = this.issue();
    const events = this.store.eventsBySubject().get(`issue:${i.id}`) ?? [];
    const items: FeedItem[] = [];
    for (const ev of events) {
      const view = describe(ev);
      if (view) items.push({ kind: 'event', id: ev.id, at: ev.at, ev, view });
    }
    for (const c of this.store.commentsFor({ type: 'issue', id: i.id }))
      items.push({ kind: 'comment', id: c.id, at: c.createdAt, c });
    return items.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  });

  /** Older plain events collapse behind "Show N older"; comments always show. */
  private readonly cutoff = computed(() => {
    const events = this.feed().filter((f) => f.kind === 'event');
    return this.all() || events.length <= 8 ? 0 : events.length - 6;
  });
  protected readonly hiddenCount = computed(() => this.cutoff());
  protected readonly visible = computed(() => {
    let n = 0;
    const cut = this.cutoff();
    return this.feed()
      .filter((f) => f.kind === 'comment' || n++ >= cut)
      .reverse();
  });

  protected statusLabel(s: IssueStatus): string {
    return ISSUE_STATUS_META[s].label;
  }

  protected full(iso: string): string {
    return fullDate(iso);
  }

  protected async send(body: string, composer: CommentComposer): Promise<void> {
    const posted = await this.store.addComment({ type: 'issue', id: this.issue().id }, body);
    if (posted) composer.reset();
    else composer.fail();
  }
}
