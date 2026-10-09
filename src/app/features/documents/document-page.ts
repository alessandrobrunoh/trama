import { BreakpointObserver } from '@angular/cdk/layout';
import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { Router, RouterLink } from '@angular/router';
import {
  LucideArchive,
  LucideCheck,
  LucideCircleAlert,
  LucideCopy,
  LucideDownload,
  LucideDynamicIcon,
  LucideEllipsis,
  LucideFileText,
  LucideHistory,
  LucidePaperclip,
  LucideRefreshCw,
  LucideRotateCcw,
  LucideTextAlignStart,
  LucideTrash2,
  LucideX,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import { HlmPopoverImports } from '@spartan-ng/helm/popover';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import {
  ApiError,
  Clipboard,
  LiveSync,
  NablaStore,
  Notifier,
  UiStore,
  usePageShortcuts,
  type Document,
} from '../../core';
import { readJson, writeJson } from '../../core/stores/storage';
import { TopBarActions, usePageCrumbs } from '../../layout/page-chrome';
import { ActorAvatar } from '../../shared/actor-avatar';
import { extractOutline, readingMinutes, wordCount } from '../../shared/heading-slug';
import { EntityRefs } from '../../shared/entity-ref';
import { Markdown } from '../../shared/markdown';
import { RelativeTimePipe } from '../../shared/pipes';
import { CommentThread } from '../workstreams/comments';
import { isEmojiIcon } from '../projects/project-glyph';
import { DocumentOwnerDialog, OWNER_ICONS, describeLink } from './document-attach';
import { DocumentEditor } from './document-editor';
import { DocumentHistory } from './document-history';
import { Documents, conflictOf } from './documents.service';
import { merge3 } from './text-merge';

type Mode = 'write' | 'split' | 'read';
type SaveState = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict';

const MODE_KEY = 'trama.documents.mode.v1';
const OUTLINE_KEY = 'trama.documents.outline.v1';
const AUTOSAVE_MS = 1200;
const PREVIEW_MS = 140;
const ICONS = [
  '📄',
  '📝',
  '📋',
  '📌',
  '🎯',
  '🚀',
  '💡',
  '🧭',
  '🗺️',
  '🧪',
  '🔧',
  '🔒',
  '📈',
  '📊',
  '🧩',
  '🏗️',
  '📦',
  '🔍',
  '⚡',
  '🧠',
  '📚',
  '✅',
  '🐞',
  '🔥',
  '🌱',
  '🎨',
  '📣',
  '🤝',
  '🗓️',
  '🛟',
];

interface Snapshot {
  title: string;
  body: string;
  icon: string | null;
  version: number;
}

interface Conflict {
  theirs: Document;
  /** Merge of both texts with conflict markers where they overlap. */
  marked: string;
  conflicts: number;
}

/**
 * A document: title, Markdown editor with live preview, outline, attachments, version history and autosave.
 * Saves are optimistic: each one names the version it is based on; if somebody else saved in between the changes
 * are merged line by line, and a real overlap asks which side to keep.
 */
@Component({
  selector: 'app-document-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    HlmButtonImports,
    HlmDropdownMenuImports,
    HlmPopoverImports,
    HlmTooltip,
    LucideDynamicIcon,
    ActorAvatar,
    Markdown,
    RelativeTimePipe,
    TopBarActions,
    CommentThread,
    DocumentEditor,
    DocumentHistory,
    DocumentOwnerDialog,
  ],
  host: { class: 'flex h-full min-h-0 flex-col' },
  template: `
    <ng-template appTopBarActions>
      @if (doc()) {
        <span
          class="text-muted-foreground flex items-center gap-1.5 text-xs"
          role="status"
          aria-live="polite"
        >
          @switch (saveState()) {
            @case ('saved') {
              <svg [lucideIcon]="checkIcon" [size]="13" class="text-status-shipped"></svg>
              <span class="max-sm:hidden">{{ canEdit() ? 'Saved' : 'Read only' }}</span>
            }
            @case ('dirty') {
              <span class="bg-muted-foreground size-1.5 rounded-full"></span>
              <span class="max-sm:hidden">Unsaved changes</span>
            }
            @case ('saving') {
              <svg [lucideIcon]="loaderIcon" [size]="13" class="animate-spin"></svg>
              <span class="max-sm:hidden">Saving…</span>
            }
            @case ('conflict') {
              <svg [lucideIcon]="alertIcon" [size]="13" class="text-status-needs-input"></svg>
              <span class="text-status-needs-input">Conflict</span>
            }
            @case ('error') {
              <svg [lucideIcon]="alertIcon" [size]="13" class="text-status-blocked"></svg>
              <button type="button" class="text-status-blocked hover:underline" (click)="saveNow()">
                Not saved · Retry
              </button>
            }
          }
        </span>
        @if (canEdit() && !doc()?.archivedAt) {
          <div class="bg-muted flex items-center rounded-md p-0.5" role="group" aria-label="View">
            @for (m of modes(); track m.id) {
              <button
                type="button"
                class="rounded px-2 py-0.5 text-xs"
                [class]="
                  effectiveMode() === m.id ? 'bg-background shadow-sm' : 'text-muted-foreground'
                "
                [attr.aria-pressed]="effectiveMode() === m.id"
                (click)="setMode(m.id)"
              >
                {{ m.label }}
              </button>
            }
          </div>
        }
        <button
          hlmBtn
          variant="ghost"
          size="icon-sm"
          class="size-7"
          hlmTooltip="Version history"
          aria-label="Version history"
          (click)="historyOpen.set(true)"
        >
          <svg [lucideIcon]="historyIcon" [size]="15"></svg>
        </button>
        @if (outline().length > 1) {
          <button
            hlmBtn
            variant="ghost"
            size="icon-sm"
            class="size-7 max-xl:hidden"
            [hlmTooltip]="outlineOpen() ? 'Hide outline' : 'Show outline'"
            aria-label="Toggle outline"
            [attr.aria-pressed]="outlineOpen()"
            (click)="toggleOutline()"
          >
            <svg [lucideIcon]="outlineIcon" [size]="15"></svg>
          </button>
        }
        <button
          hlmBtn
          variant="ghost"
          size="icon-sm"
          class="size-7"
          [hlmDropdownMenuTrigger]="menu"
          aria-label="Document actions"
        >
          <svg [lucideIcon]="moreIcon" [size]="15"></svg>
        </button>
        <ng-template #menu>
          <hlm-dropdown-menu class="w-56">
            <button hlmDropdownMenuItem (triggered)="copyMarkdown()">
              <svg [lucideIcon]="copyIcon" [size]="14"></svg>Copy as Markdown
            </button>
            <button hlmDropdownMenuItem (triggered)="copyLink()">
              <svg [lucideIcon]="copyIcon" [size]="14"></svg>Copy link
            </button>
            <button hlmDropdownMenuItem (triggered)="download()">
              <svg [lucideIcon]="downloadIcon" [size]="14"></svg>Download .md
            </button>
            @if (canEdit()) {
              <hlm-dropdown-menu-separator />
              <button hlmDropdownMenuItem (triggered)="ownerOpen.set(true)">
                <svg [lucideIcon]="attachIcon" [size]="14"></svg>Attach to…
              </button>
            }
            @if (doc()?.archivedAt) {
              <button hlmDropdownMenuItem (triggered)="restore()">
                <svg [lucideIcon]="restoreIcon" [size]="14"></svg>Restore
              </button>
            } @else if (canEdit()) {
              <button hlmDropdownMenuItem (triggered)="archive()">
                <svg [lucideIcon]="archiveIcon" [size]="14"></svg>Archive
              </button>
            }
            @if (canDelete()) {
              <hlm-dropdown-menu-separator />
              <button hlmDropdownMenuItem variant="destructive" (triggered)="remove()">
                <svg [lucideIcon]="trashIcon" [size]="14"></svg>Delete…
              </button>
            }
          </hlm-dropdown-menu>
        </ng-template>
      }
    </ng-template>

    @if (doc(); as d) {
      <div class="flex min-h-0 flex-1">
        <div class="flex min-h-0 min-w-0 flex-1 flex-col">
          <header class="shrink-0 border-b px-4 pt-4 pb-3 sm:px-6">
            <div class="flex items-start gap-2">
              @if (canEdit()) {
                <hlm-popover
                  align="start"
                  sideOffset="6"
                  [state]="iconState()"
                  (stateChanged)="iconState.set($event)"
                >
                  <button
                    hlmPopoverTrigger
                    type="button"
                    class="hover:bg-accent focus-visible:ring-ring mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-md text-2xl leading-none outline-none focus-visible:ring-2"
                    aria-label="Change icon"
                    hlmTooltip="Change icon"
                  >
                    @if (emoji(); as e) {
                      {{ e }}
                    } @else {
                      <svg [lucideIcon]="fileIcon" [size]="22" class="text-muted-foreground"></svg>
                    }
                  </button>
                  <hlm-popover-content *hlmPopoverPortal="let ctx" class="w-64 p-2">
                    <div class="grid grid-cols-6 gap-0.5" role="group" aria-label="Icon">
                      @for (i of icons; track i) {
                        <button
                          type="button"
                          class="hover:bg-accent flex size-9 items-center justify-center rounded-md text-xl"
                          [attr.aria-label]="i"
                          (click)="setIcon(i)"
                        >
                          {{ i }}
                        </button>
                      }
                    </div>
                    @if (icon()) {
                      <button
                        hlmBtn
                        type="button"
                        variant="ghost"
                        size="sm"
                        class="text-muted-foreground mt-1 w-full justify-start"
                        (click)="setIcon(null)"
                      >
                        Remove icon
                      </button>
                    }
                  </hlm-popover-content>
                </hlm-popover>
              } @else {
                <span
                  class="mt-0.5 flex size-9 shrink-0 items-center justify-center text-2xl leading-none"
                >
                  @if (emoji(); as e) {
                    {{ e }}
                  } @else {
                    <svg [lucideIcon]="fileIcon" [size]="22" class="text-muted-foreground"></svg>
                  }
                </span>
              }
              <input
                #titleField
                class="placeholder:text-muted-foreground/60 min-w-0 flex-1 bg-transparent py-1 text-2xl font-semibold tracking-tight outline-none"
                placeholder="Untitled"
                aria-label="Document title"
                maxlength="200"
                autocomplete="off"
                [readOnly]="!canEdit()"
                [value]="title()"
                (input)="onTitle($any($event.target).value)"
                (keydown.enter)="$event.preventDefault(); focusEditor()"
              />
            </div>

            <div
              class="text-muted-foreground mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 pl-11 text-xs"
            >
              <span class="flex items-center gap-1.5">
                <app-actor-avatar [actor]="d.lastEditor" [size]="16" />
                <span>Edited by {{ name(d.lastEditor) }} · {{ d.updatedAt | relativeTime }}</span>
              </span>
              <span class="tabular-nums"
                >{{ words() }} word{{ words() === 1 ? '' : 's' }}
                @if (minutes()) {
                  · {{ minutes() }} min read
                }
              </span>
              @if (d.archivedAt) {
                <span class="bg-muted rounded px-1.5 py-0.5">Archived</span>
              }
              <span class="flex flex-wrap items-center gap-1.5">
                @for (l of links(); track l.link.artifactId) {
                  <span
                    class="border-border-strong inline-flex h-6 max-w-48 items-center gap-1 rounded-full border pr-1 pl-2"
                  >
                    <svg [lucideIcon]="ownerIcons[l.view.type]" [size]="12" class="shrink-0"></svg>
                    <a
                      [routerLink]="l.view.route"
                      class="hover:text-foreground truncate"
                      [class.font-mono]="l.view.mono"
                      >{{ l.view.label }}</a
                    >
                    @if (canEdit()) {
                      <button
                        type="button"
                        class="hover:bg-accent hover:text-foreground flex size-4 items-center justify-center rounded-full"
                        [attr.aria-label]="'Detach from ' + l.view.label"
                        (click)="detach(l.link.artifactId)"
                      >
                        <svg [lucideIcon]="closeIcon" [size]="10"></svg>
                      </button>
                    }
                  </span>
                }
                @if (canEdit()) {
                  <button
                    type="button"
                    class="hover:text-foreground border-border-strong inline-flex h-6 items-center gap-1 rounded-full border border-dashed px-2"
                    (click)="ownerOpen.set(true)"
                  >
                    <svg [lucideIcon]="attachIcon" [size]="11"></svg
                    >{{ links().length ? 'Attach' : 'Attach to a project, workstream or issue' }}
                  </button>
                }
              </span>
            </div>
          </header>

          @if (d.archivedAt) {
            <div
              class="bg-muted/60 flex flex-wrap items-center gap-2 border-b px-4 py-2 text-xs sm:px-6"
              role="status"
            >
              This document is archived and read only.
              @if (canEdit()) {
                <button
                  hlmBtn
                  size="sm"
                  variant="outline"
                  class="h-6 px-2 text-xs"
                  (click)="restore()"
                >
                  Restore
                </button>
              }
            </div>
          }
          @if (conflict(); as c) {
            <div
              class="bg-status-needs-input/10 border-status-needs-input/30 flex flex-wrap items-center gap-2 border-b px-4 py-2 text-xs sm:px-6"
              role="alert"
            >
              <svg
                [lucideIcon]="alertIcon"
                [size]="14"
                class="text-status-needs-input shrink-0"
              ></svg>
              <span class="min-w-0 flex-1">
                {{ name(c.theirs.lastEditor) }} changed the same lines while you were editing ({{
                  c.conflicts
                }}
                overlap{{ c.conflicts === 1 ? '' : 's' }}). Nothing was lost on either side.
              </span>
              <button
                hlmBtn
                size="sm"
                variant="outline"
                class="h-6 px-2 text-xs"
                (click)="keepMine()"
              >
                Keep mine
              </button>
              <button
                hlmBtn
                size="sm"
                variant="outline"
                class="h-6 px-2 text-xs"
                (click)="takeTheirs()"
              >
                Use theirs
              </button>
              <button
                hlmBtn
                size="sm"
                variant="outline"
                class="h-6 px-2 text-xs"
                (click)="mergeWithMarkers()"
              >
                Merge by hand
              </button>
            </div>
          }

          <div class="flex min-h-0 flex-1">
            @if (showEditor()) {
              <app-document-editor
                class="min-w-0"
                [class]="showPreview() ? 'w-1/2 border-r' : 'w-full'"
                [value]="body()"
                [readonly]="!canEdit() || !!d.archivedAt"
                [hint]="!showPreview()"
                (valueChange)="onBody($event)"
                (scrolled)="syncPreview($event)"
              />
            }
            @if (showPreview()) {
              <div
                #previewBox
                class="min-h-0 min-w-0 overflow-y-auto"
                [class]="showEditor() ? 'w-1/2' : 'w-full'"
                data-testid="document-preview"
              >
                <article class="mx-auto max-w-3xl px-4 py-6 max-md:pb-28 sm:px-6">
                  @if (previewSource().trim()) {
                    <div class="[&>app-markdown]:text-[15px] [&>app-markdown]:leading-7">
                      <app-markdown
                        [source]="previewSource()"
                        [link]="refs.linker()"
                        [headingIds]="true"
                      />
                    </div>
                  } @else {
                    <p class="text-muted-foreground text-sm">
                      Nothing here yet.
                      @if (canEdit() && !d.archivedAt) {
                        <button
                          type="button"
                          class="text-primary hover:underline"
                          (click)="setMode('write')"
                        >
                          Start writing
                        </button>
                      }
                    </p>
                  }
                  <section class="mt-10 border-t pt-4" aria-label="Comments">
                    <app-comment-thread [subject]="{ type: 'document', id: d.id }" />
                  </section>
                </article>
              </div>
            }
          </div>
        </div>

        @if (outlineOpen() && outline().length > 1) {
          <aside
            class="hidden w-56 shrink-0 overflow-y-auto border-l px-3 py-4 xl:block"
            aria-label="Outline"
          >
            <h2
              class="text-muted-foreground mb-2 px-1.5 text-[11px] font-medium tracking-wide uppercase"
            >
              Outline
            </h2>
            <nav>
              <ul class="space-y-0.5">
                @for (h of outline(); track h.slug) {
                  <li>
                    <button
                      type="button"
                      class="hover:bg-accent hover:text-foreground text-muted-foreground block w-full truncate rounded px-1.5 py-1 text-left text-xs"
                      [style.padding-left.px]="6 + (h.level - minLevel()) * 10"
                      [title]="h.text"
                      (click)="jumpTo(h)"
                    >
                      {{ h.text }}
                    </button>
                  </li>
                }
              </ul>
            </nav>
          </aside>
        }
      </div>

      <app-document-history
        [(open)]="historyOpen"
        [documentId]="d.id"
        [currentBody]="body()"
        [currentTitle]="title()"
        [canEdit]="canEdit() && !d.archivedAt"
        (restoreRequested)="restoreVersion($event)"
      />
      <app-document-owner-dialog
        [(open)]="ownerOpen"
        [document]="d"
        (attached)="applyLinks($event)"
      />
    } @else if (loadError()) {
      <div
        class="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-3 p-8 text-sm"
      >
        <svg [lucideIcon]="fileIcon" [size]="28" [strokeWidth]="1.25"></svg>
        <p>
          {{
            loadError() === 'notfound'
              ? 'This document does not exist or was deleted.'
              : 'Could not load the document.'
          }}
        </p>
        <div class="flex gap-2">
          <a hlmBtn variant="outline" size="sm" [routerLink]="['/', slug(), 'documents']"
            >All documents</a
          >
          @if (loadError() === 'error') {
            <button hlmBtn size="sm" (click)="load()">Try again</button>
          }
        </div>
      </div>
    } @else {
      <div
        class="text-muted-foreground flex flex-1 items-center justify-center text-sm"
        role="status"
      >
        Loading…
      </div>
    }
  `,
})
export class DocumentPage {
  private readonly store = inject(NablaStore);
  private readonly documents = inject(Documents);
  private readonly notifier = inject(Notifier);
  private readonly ui = inject(UiStore);
  private readonly router = inject(Router);
  private readonly clipboard = inject(Clipboard);
  private readonly live = inject(LiveSync);
  private readonly dom = inject(DOCUMENT);
  private readonly breakpoints = inject(BreakpointObserver);
  protected readonly refs = inject(EntityRefs);

  /** Route param. */
  readonly id = input.required<string>();

  private readonly editor = viewChild(DocumentEditor);
  private readonly titleField = viewChild<ElementRef<HTMLInputElement>>('titleField');
  private readonly previewBox = viewChild<ElementRef<HTMLElement>>('previewBox');

  protected readonly slug = this.store.slug;

  protected name(a: Document['author']): string {
    return this.store.actorName(a);
  }

  protected readonly ownerIcons = OWNER_ICONS;
  protected readonly icons = ICONS;
  protected readonly checkIcon = LucideCheck;
  protected readonly loaderIcon = LucideRefreshCw;
  protected readonly alertIcon = LucideCircleAlert;
  protected readonly historyIcon = LucideHistory;
  protected readonly outlineIcon = LucideTextAlignStart;
  protected readonly moreIcon = LucideEllipsis;
  protected readonly copyIcon = LucideCopy;
  protected readonly downloadIcon = LucideDownload;
  protected readonly attachIcon = LucidePaperclip;
  protected readonly archiveIcon = LucideArchive;
  protected readonly restoreIcon = LucideRotateCcw;
  protected readonly trashIcon = LucideTrash2;
  protected readonly closeIcon = LucideX;
  protected readonly fileIcon = LucideFileText;

  protected readonly narrowModes: { id: Mode; label: string }[] = [
    { id: 'write', label: 'Write' },
    { id: 'read', label: 'Preview' },
  ];
  protected readonly wideModes: { id: Mode; label: string }[] = [
    { id: 'write', label: 'Write' },
    { id: 'split', label: 'Split' },
    { id: 'read', label: 'Preview' },
  ];

  protected readonly doc = signal<Document | null>(null);
  protected readonly loadError = signal<'notfound' | 'error' | null>(null);
  protected readonly title = signal('');
  protected readonly body = signal('');
  protected readonly icon = signal<string | null>(null);
  protected readonly previewSource = signal('');
  protected readonly saveState = signal<SaveState>('saved');
  protected readonly conflict = signal<Conflict | null>(null);
  protected readonly historyOpen = signal(false);
  protected readonly ownerOpen = signal(false);
  protected readonly iconState = signal<'open' | 'closed'>('closed');
  protected readonly mode = signal<Mode>(this.readMode());
  protected readonly outlineOpen = signal(readJson<boolean>(OUTLINE_KEY) !== false);

  /** What the server has confirmed: saves send only what differs from it. */
  private confirmed: Snapshot = { title: '', body: '', icon: null, version: 0 };
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private previewTimer: ReturnType<typeof setTimeout> | null = null;
  private saving: Promise<void> | null = null;
  private loadToken = 0;
  private scrollLock = 0;

  private readonly wide = toSignal(this.breakpoints.observe('(min-width: 1024px)'), {
    initialValue: { matches: true, breakpoints: {} },
  });

  protected readonly modes = computed(() =>
    this.wide().matches ? this.wideModes : this.narrowModes,
  );
  protected readonly canEdit = computed(() => this.store.can('member'));
  protected readonly canDelete = computed(() => {
    const d = this.doc();
    if (!d) return false;
    const me = this.store.me();
    return this.store.can('admin') || (!!me && d.author.type === 'user' && d.author.id === me.id);
  });
  protected readonly effectiveMode = computed<Mode>(() => {
    if (!this.canEdit() || this.doc()?.archivedAt) return 'read';
    const m = this.mode();
    return m === 'split' && !this.wide().matches ? 'write' : m;
  });
  protected readonly showEditor = computed(() => this.effectiveMode() !== 'read');
  protected readonly showPreview = computed(() => this.effectiveMode() !== 'write');
  protected readonly emoji = computed(() => (isEmojiIcon(this.icon()) ? this.icon() : null));
  protected readonly words = computed(() => wordCount(this.body()));
  protected readonly minutes = computed(() => readingMinutes(this.words()));
  protected readonly outline = computed(() => extractOutline(this.body()));
  protected readonly minLevel = computed(() => Math.min(6, ...this.outline().map((h) => h.level)));
  protected readonly links = computed(() =>
    (this.doc()?.links ?? []).flatMap((link) => {
      const view = describeLink(this.store, link);
      return view ? [{ link, view }] : [];
    }),
  );

  constructor() {
    usePageCrumbs(() => [
      { label: 'Documents', link: ['/', this.store.slug() ?? '', 'documents'] },
      { label: this.title().trim() || 'Untitled' },
    ]);
    usePageShortcuts([
      {
        keys: 'mod+s',
        label: 'Save document',
        allowWhileTyping: true,
        run: (e) => {
          e.preventDefault();
          void this.saveNow();
        },
      },
      {
        keys: 'mod+/',
        label: 'Switch between writing and preview',
        allowWhileTyping: true,
        run: (e) => {
          e.preventDefault();
          this.cycleMode();
        },
      },
    ]);

    effect(() => {
      const id = this.id();
      untracked(() => void this.open(id));
    });

    // The preview follows the text a moment after typing stops: parsing a long document on every key is wasted work.
    effect(() => {
      const body = this.body();
      untracked(() => {
        if (this.previewTimer) clearTimeout(this.previewTimer);
        if (!this.previewSource() || body.length < 2000) this.previewSource.set(body);
        else this.previewTimer = setTimeout(() => this.previewSource.set(body), PREVIEW_MS);
      });
    });

    // Changes made elsewhere (another person, an agent, another tab).
    this.live.events$.pipe(takeUntilDestroyed()).subscribe((e) => {
      const d = this.doc();
      if (!d) return;
      if (e.entity === 'document' && e.id === d.id) void this.refresh();
      else if (e.entity === 'artifact') void this.refreshLinks();
    });

    const onHide = () => {
      if (this.dom.visibilityState === 'hidden') void this.flush();
    };
    const beforeUnload = (ev: BeforeUnloadEvent) => {
      if (
        this.saveState() === 'dirty' ||
        this.saveState() === 'saving' ||
        this.saveState() === 'error'
      ) {
        ev.preventDefault();
        ev.returnValue = '';
      }
    };
    this.dom.addEventListener('visibilitychange', onHide);
    this.dom.defaultView?.addEventListener('beforeunload', beforeUnload);
    inject(DestroyRef).onDestroy(() => {
      this.dom.removeEventListener('visibilitychange', onHide);
      this.dom.defaultView?.removeEventListener('beforeunload', beforeUnload);
      if (this.saveTimer) clearTimeout(this.saveTimer);
      if (this.previewTimer) clearTimeout(this.previewTimer);
      void this.flush();
    });
  }

  private readMode(): Mode {
    const m = readJson<string>(MODE_KEY);
    return m === 'write' || m === 'split' || m === 'read' ? m : 'split';
  }

  // ───────────── loading ─────────────

  protected load(): Promise<void> {
    return this.open(this.id());
  }

  private async open(id: string): Promise<void> {
    await this.flush();
    const token = ++this.loadToken;
    this.doc.set(null);
    this.loadError.set(null);
    this.conflict.set(null);
    try {
      const d = await this.documents.get(id);
      if (token !== this.loadToken) return;
      this.adopt(d);
      this.saveState.set('saved');
      if (this.canEdit() && !d.archivedAt && d.title === 'Untitled' && !d.body) {
        queueMicrotask(() => {
          const t = this.titleField()?.nativeElement;
          t?.focus();
          t?.select();
        });
      }
    } catch (e) {
      if (token !== this.loadToken) return;
      this.loadError.set(e instanceof ApiError && e.status === 404 ? 'notfound' : 'error');
    }
  }

  /** Makes `d` both the confirmed state and the text on screen. */
  private adopt(d: Document): void {
    this.confirmed = { title: d.title, body: d.body, icon: d.icon ?? null, version: d.version };
    this.doc.set(d);
    this.title.set(d.title);
    this.icon.set(d.icon ?? null);
    this.body.set(d.body);
    this.previewSource.set(d.body);
    this.editor()?.setText(d.body);
  }

  /** A remote change arrived: take it when nothing local is pending, otherwise the next save merges it. */
  private async refresh(): Promise<void> {
    const d = this.doc();
    if (!d) return;
    try {
      const next = await this.documents.get(d.id);
      if (next.version === this.confirmed.version)
        return void this.doc.update((cur) => (cur ? { ...cur, links: next.links } : cur));
      if (this.isDirty() || this.saving) {
        this.doc.update((cur) => (cur ? { ...cur, links: next.links } : cur));
        return;
      }
      this.adopt(next);
    } catch {
      /* keep what is on screen */
    }
  }

  private async refreshLinks(): Promise<void> {
    const d = this.doc();
    if (!d) return;
    try {
      const next = await this.documents.get(d.id);
      this.doc.update((cur) => (cur ? { ...cur, links: next.links } : cur));
    } catch {
      /* ignore */
    }
  }

  // ───────────── editing & saving ─────────────

  private isDirty(): boolean {
    return (
      this.title() !== this.confirmed.title ||
      this.body() !== this.confirmed.body ||
      this.icon() !== this.confirmed.icon
    );
  }

  protected onTitle(v: string): void {
    this.title.set(v);
    this.touched();
  }

  protected onBody(v: string): void {
    if (v === this.body()) return;
    this.body.set(v);
    this.touched();
  }

  protected setIcon(icon: string | null): void {
    this.icon.set(icon);
    this.iconState.set('closed');
    this.touched();
    void this.saveNow();
  }

  private touched(): void {
    if (!this.canEdit() || this.doc()?.archivedAt || this.conflict()) return;
    if (!this.isDirty()) {
      if (this.saveState() === 'dirty') this.saveState.set('saved');
      return;
    }
    if (this.saveState() !== 'saving') this.saveState.set('dirty');
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.saveNow(), AUTOSAVE_MS);
  }

  /** Saves the pending changes now (⌘S, blur, leaving the page). */
  protected async saveNow(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    await this.flush();
  }

  private flush(): Promise<void> {
    if (this.saving) return this.saving.then(() => (this.isDirty() ? this.flush() : undefined));
    if (
      !this.doc() ||
      !this.isDirty() ||
      !this.canEdit() ||
      this.conflict() ||
      this.doc()?.archivedAt
    )
      return Promise.resolve();
    this.saving = this.save().finally(() => {
      this.saving = null;
    });
    return this.saving;
  }

  private async save(): Promise<void> {
    const d = this.doc();
    if (!d) return;
    const sent: Snapshot = {
      title: this.title().trim() || 'Untitled',
      body: this.body(),
      icon: this.icon(),
      version: this.confirmed.version,
    };
    const patch: { baseVersion: number; title?: string; body?: string; icon?: string | null } = {
      baseVersion: sent.version,
    };
    if (sent.title !== this.confirmed.title) patch.title = sent.title;
    if (sent.body !== this.confirmed.body) patch.body = sent.body;
    if (sent.icon !== this.confirmed.icon) patch.icon = sent.icon;
    if (Object.keys(patch).length === 1) return void this.saveState.set('saved');
    this.saveState.set('saving');
    try {
      const saved = await this.documents.update(d.id, patch);
      this.confirmed = {
        title: saved.title,
        body: sent.body,
        icon: saved.icon ?? null,
        version: saved.version,
      };
      this.doc.update((cur) =>
        cur ? { ...cur, ...saved, body: cur.body, links: saved.links ?? cur.links } : cur,
      );
      this.saveState.set(this.isDirty() ? 'dirty' : 'saved');
      if (this.isDirty()) this.touched();
    } catch (e) {
      const theirs = conflictOf(e);
      if (theirs) return this.resolve(theirs);
      this.saveState.set('error');
      if (e instanceof ApiError && e.status !== 0) this.notifier.error(e.message);
    }
  }

  /** Somebody saved first: merge line by line from the version we started from. */
  private resolve(theirs: Document): void {
    const mine = this.body();
    const merged = merge3(this.confirmed.body, mine, theirs.body);
    const theirsTitleChanged = theirs.title !== this.confirmed.title;
    const titleMine = this.title().trim() || 'Untitled';
    // our title wins when we changed it, theirs otherwise
    const title =
      titleMine !== this.confirmed.title
        ? titleMine
        : theirsTitleChanged
          ? theirs.title
          : titleMine;
    this.confirmed = {
      title: theirs.title,
      body: theirs.body,
      icon: theirs.icon ?? null,
      version: theirs.version,
    };
    this.doc.update((cur) => (cur ? { ...cur, ...theirs, body: cur.body } : cur));
    if (merged.conflicts === 0) {
      this.title.set(title);
      this.body.set(merged.text);
      this.editor()?.setText(merged.text);
      this.notifier.info('Merged with changes made by someone else', { duration: 3500 });
      this.saveState.set('dirty');
      this.touched();
      return;
    }
    this.title.set(title);
    this.conflict.set({ theirs, marked: merged.text, conflicts: merged.conflicts });
    this.saveState.set('conflict');
  }

  protected keepMine(): void {
    this.conflict.set(null);
    this.saveState.set('dirty');
    this.touched();
    void this.saveNow();
  }

  protected takeTheirs(): void {
    const c = this.conflict();
    if (!c) return;
    this.conflict.set(null);
    this.adopt(c.theirs);
    this.saveState.set('saved');
  }

  protected mergeWithMarkers(): void {
    const c = this.conflict();
    if (!c) return;
    this.conflict.set(null);
    this.body.set(c.marked);
    this.editor()?.setText(c.marked);
    this.saveState.set('dirty');
    this.notifier.info(
      'Both versions are in the text between <<<<<<< and >>>>>>>. Edit, then it saves.',
      { duration: 6000 },
    );
    this.touched();
  }

  // ───────────── history ─────────────

  protected async restoreVersion(req: {
    version: number;
    done: (error: string | null) => void;
  }): Promise<void> {
    const d = this.doc();
    if (!d) return req.done('The document is not loaded');
    try {
      await this.saveNow();
      if (this.conflict()) return req.done('Resolve the conflict first');
      const restored = await this.documents.restoreRevision(
        d.id,
        req.version,
        this.confirmed.version,
      );
      this.adopt(restored);
      this.saveState.set('saved');
      this.notifier.success('Version restored');
      req.done(null);
    } catch (e) {
      const theirs = conflictOf(e);
      req.done(
        theirs
          ? 'The document changed meanwhile. Close this window and try again.'
          : e instanceof ApiError
            ? e.message
            : 'Could not restore this version',
      );
    }
  }

  // ───────────── view ─────────────

  protected setMode(m: Mode): void {
    this.mode.set(m);
    writeJson(MODE_KEY, m);
    if (m !== 'read') queueMicrotask(() => this.editor()?.focus());
  }

  private cycleMode(): void {
    if (!this.canEdit()) return;
    const wide = this.wide().matches;
    const order: Mode[] = wide ? ['write', 'split', 'read'] : ['write', 'read'];
    const cur = this.effectiveMode();
    this.setMode(order[(order.indexOf(cur) + 1) % order.length]);
  }

  protected toggleOutline(): void {
    this.outlineOpen.update((v) => !v);
    writeJson(OUTLINE_KEY, this.outlineOpen());
  }

  protected focusEditor(): void {
    if (this.showEditor()) this.editor()?.focus();
    else this.setMode('write');
  }

  protected syncPreview(ratio: number): void {
    const box = this.previewBox()?.nativeElement;
    if (!box || !this.showEditor() || Date.now() < this.scrollLock) return;
    box.scrollTop = ratio * (box.scrollHeight - box.clientHeight);
  }

  protected jumpTo(h: { slug: string; offset: number }): void {
    this.scrollLock = Date.now() + 600;
    this.editor()?.revealOffset(h.offset);
    const target = Array.from(this.previewBox()?.nativeElement.querySelectorAll('[id]') ?? []).find(
      (el) => el.id === h.slug,
    );
    target?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  // ───────────── actions ─────────────

  protected applyLinks(d: Document): void {
    this.doc.update((cur) => (cur ? { ...cur, links: d.links } : cur));
  }

  protected async detach(artifactId: string): Promise<void> {
    const d = this.doc();
    if (!d) return;
    try {
      this.applyLinks(await this.documents.detach(d.id, artifactId));
    } catch (e) {
      this.notifier.error(e instanceof ApiError ? e.message : 'Could not detach the document');
    }
  }

  protected copyMarkdown(): void {
    void this.clipboard.copy(this.body(), 'Markdown copied');
  }

  protected copyLink(): void {
    void this.clipboard.copy(this.dom.defaultView?.location.href ?? '', 'Link copied');
  }

  protected download(): void {
    const name = (this.title().trim() || 'document').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80);
    const blob = new Blob([this.body()], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = this.dom.createElement('a');
    a.href = url;
    a.download = `${name}.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  protected async archive(): Promise<void> {
    const d = this.doc();
    if (!d) return;
    await this.saveNow();
    try {
      const next = await this.documents.archive(d.id);
      this.doc.set({ ...next, body: this.body() });
      this.notifier.success('Document archived');
    } catch (e) {
      this.notifier.error(e instanceof ApiError ? e.message : 'Could not archive the document');
    }
  }

  protected async restore(): Promise<void> {
    const d = this.doc();
    if (!d) return;
    try {
      const next = await this.documents.restore(d.id);
      this.doc.set({ ...next, body: this.body() });
      this.notifier.success('Document restored');
    } catch (e) {
      this.notifier.error(e instanceof ApiError ? e.message : 'Could not restore the document');
    }
  }

  protected remove(): void {
    const d = this.doc();
    if (!d) return;
    this.ui.setConfirmDelete({
      title: `Delete “${this.title().trim() || 'Untitled'}”?`,
      description:
        'The document, its history and its attachments are deleted for everyone. Archive it instead to keep it recoverable.',
      confirmLabel: 'Delete',
      onConfirm: async () => {
        try {
          await this.documents.remove(d.id);
          this.confirmed = {
            ...this.confirmed,
            title: this.title(),
            body: this.body(),
            icon: this.icon(),
          };
          void this.router.navigate(['/', this.store.slug() ?? '', 'documents']);
        } catch (e) {
          this.notifier.error(e instanceof ApiError ? e.message : 'Could not delete the document');
        }
      },
    });
  }
}
