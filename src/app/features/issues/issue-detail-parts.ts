// Building blocks of the task page: the inline title and description editors and the task's story as one
// stream (description first, then comments and events in order, noisy runs of events folded).
import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  afterRenderEffect,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import {
  LucideChevronRight,
  LucideCircleDashed,
  LucideDynamicIcon,
  LucidePencil,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmTextareaImports } from '@spartan-ng/helm/textarea';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import {
  ISSUE_STATUS_META,
  TramaStore,
  fullDate,
  type ActorRef,
  type Issue,
  type IssueStatus,
} from '../../core';
import { AiIssueSection } from '../ai-actions/ai-issue-cards';
import { ActorAvatar } from '../../shared/actor-avatar';
import { CommentItem, CommentsLoader } from '../../shared/comments';
import { Kbd } from '../../shared/kbd';
import { Markdown } from '../../shared/markdown';
import { RelativeTimePipe } from '../../shared/pipes';
import { StatusIcon } from '../../shared/status';
import { UploadFile } from '../../shared/upload-file';
import { buildStream, eventActors, summarizeEvents, type StreamEntry, type StreamEvent } from './issue-stream-model';
import { IssueSubtasks } from './issue-subtasks';

// ───────────────────────── title ─────────────────────────

/** The task title in the page header; click to edit (Enter saves, Esc cancels, blur saves). */
@Component({
  selector: 'app-issue-title',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block min-w-0' },
  template: `
    @if (editing()) {
      <textarea
        #ta
        rows="1"
        class="w-full resize-none overflow-hidden rounded-md bg-transparent text-lg leading-snug font-medium tracking-tight outline-none"
        aria-label="Task title"
        [value]="draft()"
        (input)="onInput($event)"
        (keydown.enter)="$event.preventDefault(); commit()"
        (keydown.escape)="cancel($event)"
        (blur)="commit()"
      ></textarea>
    } @else {
      <h1
        class="-mx-1 rounded-md px-1 text-lg leading-snug font-medium tracking-tight break-words"
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
      <div class="border-input rounded-lg border">
        <div class="flex items-center gap-0.5 px-1.5 py-1">
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
        <div class="flex items-center justify-end gap-2 px-2 py-1.5">
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
        class="group/md relative -mx-2 rounded-md px-2 py-1"
        [class]="canEdit() ? 'hover:bg-hover cursor-text' : ''"
        [attr.role]="canEdit() ? 'button' : null"
        [attr.tabindex]="canEdit() ? 0 : null"
        [attr.aria-label]="canEdit() ? 'Edit description' : null"
        (click)="onClick($event)"
        (keydown.enter)="start()"
      >
        @if (value().trim()) {
          <app-markdown [source]="value()" class="block [&_a]:underline [&_a]:underline-offset-2" />
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

// ───────────────────────── stream ─────────────────────────

interface Tick {
  id: string;
  /** 0-1 position of the comment in the whole stream. */
  at: number;
}

/**
 * The story of a task, read like a conversation: the description as the first entry (by the reporter), the
 * subtasks, then comments and events oldest first. Runs of events fold into one muted line you can open.
 * A strip of ticks on the right edge (one per comment) maps a long stream; it is decoration for the mouse,
 * the stream itself stays keyboard and screen-reader navigable.
 *
 * The component is the scroller: the page puts the header above it and the composer below it.
 */
@Component({
  selector: 'app-issue-stream',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ActorAvatar,
    AiIssueSection,
    CommentItem,
    CommentsLoader,
    HlmTooltip,
    IssueDescription,
    IssueSubtasks,
    LucideDynamicIcon,
    NgTemplateOutlet,
    RelativeTimePipe,
    StatusIcon,
  ],
  host: { class: 'relative flex min-h-0 flex-1' },
  template: `
    <div
      #scroller
      class="focus-visible:ring-ring/40 min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain scroll-smooth px-4 py-5 outline-none focus-visible:ring-2 focus-visible:ring-inset motion-reduce:scroll-auto max-md:overflow-visible sm:px-8"
      tabindex="0"
      role="region"
      aria-label="Task conversation"
      (scroll)="onScroll()"
    >
      <div #content class="mx-auto flex max-w-3xl flex-col gap-5">
        <ng-content />

        <!-- The description: the first entry, by the reporter. -->
        <div class="flex min-w-0 gap-3">
          <app-actor-avatar [actor]="reporterActor()" [size]="24" class="mt-0.5" />
          <div class="min-w-0 flex-1">
            <div class="flex min-w-0 items-baseline gap-x-2">
              <span class="text-foreground truncate text-sm">{{ reporterName() }}</span>
              <time class="text-muted-foreground shrink-0 text-xs" [attr.datetime]="issue().createdAt" [hlmTooltip]="full(issue().createdAt)">{{
                issue().createdAt | relativeTime
              }}</time>
            </div>
            <app-issue-description
              #desc
              class="mt-0.5"
              [value]="issue().body ?? ''"
              [canEdit]="canEdit()"
              (save)="store.updateIssue(issue().id, { body: $event || null })"
            />
          </div>
        </div>

        <app-ai-issue-section [issue]="issue()" [showActions]="false" />

        <!-- Subtasks, right after the description. -->
        @if (showSubtasks()) {
          <div class="flex min-w-0 gap-3">
            <span class="text-muted-foreground flex w-6 shrink-0 justify-center pt-1.5">
              <svg [lucideIcon]="subtaskIcon" [size]="14" aria-hidden="true"></svg>
            </span>
            <app-issue-subtasks class="min-w-0 flex-1" [issue]="issue()" />
          </div>
        }

        <app-comments-loader [subject]="subject()" />

        @for (entry of entries(); track entry.id) {
          @if (entry.kind === 'comment') {
            <app-comment-item [comment]="entry.comment" quotable (quote)="quote.emit($event)" />
          } @else {
            <div class="flex min-w-0 gap-3">
              <span class="flex w-6 shrink-0 justify-center pt-1.5">
                <app-actor-avatar [actor]="firstActor(entry)" [size]="16" />
              </span>
              <div class="min-w-0 flex-1">
                @if (entry.events.length === 1) {
                  <ng-container
                    [ngTemplateOutlet]="detail"
                    [ngTemplateOutletContext]="{ $implicit: entry.events[0] }"
                  />
                } @else {
                  <button
                    type="button"
                    class="text-muted-foreground hover:text-foreground focus-visible:ring-ring -ml-1 inline-flex min-h-6 max-w-full items-center gap-1 rounded-md px-1 text-left text-sm outline-none focus-visible:ring-2"
                    [attr.aria-expanded]="isOpen(entry.id)"
                    (click)="toggle(entry.id)"
                  >
                    <span class="min-w-0">{{ summary(entry) }}</span>
                    <svg
                      [lucideIcon]="chevron"
                      [size]="13"
                      class="shrink-0 transition-transform"
                      [class.rotate-90]="isOpen(entry.id)"
                      aria-hidden="true"
                    ></svg>
                  </button>
                  @if (isOpen(entry.id)) {
                    <ul class="mt-0.5 flex flex-col gap-0.5">
                      @for (ev of entry.events; track ev.id) {
                        <li>
                          <ng-container
                            [ngTemplateOutlet]="detail"
                            [ngTemplateOutletContext]="{ $implicit: ev }"
                          />
                        </li>
                      }
                    </ul>
                  }
                }
              </div>
            </div>
          }
        }
      </div>
    </div>

    @if (showMap()) {
      <div class="pointer-events-none absolute inset-y-5 right-5 w-3 max-sm:hidden" aria-hidden="true">
        <div
          class="bg-foreground/[0.06] absolute inset-x-0 rounded-sm"
          [style.top.%]="view().start * 100"
          [style.height.%]="(view().end - view().start) * 100"
        ></div>
        @for (t of ticks(); track t.id) {
          <span
            class="pointer-events-auto absolute inset-x-0 -my-1 flex h-2 cursor-pointer items-center"
            [style.top.%]="t.at * 100"
            (click)="jump(t.id)"
          >
            <span
              class="h-0.5 w-full rounded-full transition-colors"
              [class]="t.at >= view().start && t.at <= view().end ? 'bg-primary' : 'bg-foreground/25'"
            ></span>
          </span>
        }
      </div>
    }

    <ng-template #detail let-e>
      <div class="text-muted-foreground flex min-h-6 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
        <span class="text-foreground">{{ store.actorName(e.ev.actor) }}</span>
        <span>{{ e.view.verb }}</span>
        @if (e.view.from) {
          <span class="inline-flex items-center gap-1"
            ><app-status-icon [status]="e.view.from" entity="issue" [size]="12" />{{ statusLabel(e.view.from) }}</span
          >
          <span aria-hidden="true">→</span>
        }
        @if (e.view.to) {
          <span class="text-foreground inline-flex items-center gap-1"
            ><app-status-icon [status]="e.view.to" entity="issue" [size]="12" />{{ statusLabel(e.view.to) }}</span
          >
        }
        <span aria-hidden="true">·</span>
        <time [attr.datetime]="e.at" [hlmTooltip]="full(e.at)">{{ e.at | relativeTime }}</time>
      </div>
    </ng-template>
  `,
})
export class IssueStream {
  protected readonly store = inject(TramaStore);
  private readonly injector = inject(Injector);

  readonly issue = input.required<Issue>();
  /** A "Quote reply" was chosen on a comment: the page puts the text in the composer. */
  readonly quote = output<string>();

  protected readonly chevron = LucideChevronRight;
  protected readonly subtaskIcon = LucideCircleDashed;

  private readonly scroller = viewChild.required<ElementRef<HTMLElement>>('scroller');
  private readonly content = viewChild.required<ElementRef<HTMLElement>>('content');
  private readonly desc = viewChild<IssueDescription>('desc');

  protected readonly canEdit = computed(() => this.store.can('member'));
  protected readonly showSubtasks = computed(
    () =>
      this.store.allowed('createIssues') ||
      this.store.issues().some((i) => i.parentId === this.issue().id),
  );
  protected readonly subject =computed(() => ({ type: 'issue' as const, id: this.issue().id }));
  /** Folded runs the reader opened. */
  private readonly opened = signal<ReadonlySet<string>>(new Set());

  protected readonly entries = computed<StreamEntry[]>(() => {
    const i = this.issue();
    return buildStream(
      this.store.eventsBySubject().get(`issue:${i.id}`) ?? [],
      this.store.commentsFor({ type: 'issue', id: i.id }),
    );
  });

  private readonly createdBy = computed<ActorRef | undefined>(() => {
    const first = this.entries()[0];
    return first?.kind === 'events' && first.events[0].view.kind === 'created' ? first.events[0].ev.actor : undefined;
  });
  protected readonly reporterActor = computed<ActorRef>(() => {
    const id = this.issue().reporterId;
    return id ? { type: 'user', id } : (this.createdBy() ?? { type: 'system' });
  });
  protected readonly reporterName = computed(() => {
    const i = this.issue();
    if (i.reporterId) return this.store.getUser(i.reporterId)?.name ?? i.reporterName ?? 'Someone';
    return i.reporterName || this.store.actorName(this.createdBy()) || 'Reporter';
  });

  // Minimap
  protected readonly ticks = signal<Tick[]>([]);
  protected readonly view = signal({ start: 0, end: 1 });
  private readonly overflowing = signal(false);
  protected readonly showMap = computed(() => this.ticks().length >= 3 && this.overflowing());

  constructor() {
    // A new task: start at the top.
    let last: string | undefined;
    effect(() => {
      const id = this.issue().id;
      if (last !== undefined && last !== id) this.scroller().nativeElement.scrollTo({ top: 0, behavior: 'instant' });
      last = id;
    });
    // Measure the ticks whenever the stream changes or its content resizes (images, folded runs opening).
    afterRenderEffect(() => {
      this.entries();
      this.opened();
      this.measure();
    });
    const destroyRef = inject(DestroyRef);
    afterNextRender(() => {
      const observer = new ResizeObserver(() => this.measure());
      observer.observe(this.content().nativeElement);
      observer.observe(this.scroller().nativeElement);
      destroyRef.onDestroy(() => observer.disconnect());
    });
  }

  /** Starts editing the description (the `e` shortcut). */
  editDescription(): void {
    this.desc()?.start();
  }

  /** Scrolls to the newest entry once it is rendered (after posting a comment). */
  scrollToEnd(): void {
    afterNextRender(
      () => {
        const el = this.scroller().nativeElement;
        el.scrollTo({ top: el.scrollHeight });
        // Phones scroll the whole page instead of the stream.
        const page = el.ownerDocument.getElementById('main-content');
        if (el.scrollHeight <= el.clientHeight) page?.scrollTo({ top: page.scrollHeight });
      },
      { injector: this.injector },
    );
  }

  protected firstActor(entry: Extract<StreamEntry, { kind: 'events' }>): ActorRef {
    return eventActors(entry.events)[0];
  }

  protected summary(entry: Extract<StreamEntry, { kind: 'events' }>): string {
    return summarizeEvents(entry.events as StreamEvent[]);
  }

  protected isOpen(id: string): boolean {
    return this.opened().has(id);
  }

  protected toggle(id: string): void {
    this.opened.update((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  protected statusLabel(s: IssueStatus): string {
    return ISSUE_STATUS_META[s].label;
  }

  protected full(iso: string): string {
    return fullDate(iso);
  }

  protected jump(id: string): void {
    const el = this.scroller().nativeElement.querySelector<HTMLElement>(`#${CSS.escape('comment-' + id)}`);
    el?.scrollIntoView({ block: 'center' });
  }

  protected onScroll(): void {
    const el = this.scroller().nativeElement;
    const total = el.scrollHeight || 1;
    this.view.set({ start: el.scrollTop / total, end: Math.min(1, (el.scrollTop + el.clientHeight) / total) });
  }

  private measure(): void {
    const scroller = this.scroller().nativeElement;
    const total = scroller.scrollHeight;
    this.overflowing.set(total > scroller.clientHeight * 1.4);
    if (!total) return;
    const top = scroller.getBoundingClientRect().top;
    const ticks: Tick[] = [];
    for (const entry of this.entries()) {
      if (entry.kind !== 'comment') continue;
      const node = scroller.querySelector<HTMLElement>(`#${CSS.escape('comment-' + entry.id)}`);
      if (!node) continue;
      ticks.push({ id: entry.id, at: (node.getBoundingClientRect().top - top + scroller.scrollTop) / total });
    }
    this.ticks.set(ticks);
    this.onScroll();
  }
}
