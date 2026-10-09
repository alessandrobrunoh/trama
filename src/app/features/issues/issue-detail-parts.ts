// Building blocks of the issue page: title + description editors, the "contributes to" workstreams
// section and the merged activity / comments feed.
import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, input, output, signal, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  LucideArrowRight,
  LucideCircleDot,
  LucideDynamicIcon,
  LucideHexagon,
  LucidePencil,
  LucidePlus,
  LucideSparkles,
  LucideX,
  type LucideIcon,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmTextareaImports } from '@spartan-ng/helm/textarea';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import {
  ISSUE_STATUS_META,
  NablaStore,
  WORKSTREAM_STATUS_META,
  fullDate,
  type Comment,
  type DomainEvent,
  type Issue,
  type IssueStatus,
} from '../../core';
import { ActorAvatar } from '../../shared/actor-avatar';
import { EntityChip } from '../../shared/entity-chip';
import { Kbd } from '../../shared/kbd';
import { Markdown } from '../../shared/markdown';
import { RelativeTimePipe } from '../../shared/pipes';
import { StatusIcon } from '../../shared/status';
import { CommentComposer, CommentItem, CommentsLoader } from '../workstreams/comments';
import { buildSummary } from '../workstreams/ws-model';
import { IssueActions } from './issue-actions';

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
  imports: [HlmTextareaImports, HlmButtonImports, Markdown, Kbd, LucideDynamicIcon],
  host: { class: 'block' },
  template: `
    @if (editing()) {
      <div class="border-border-strong rounded-lg border">
        <div class="flex items-center gap-0.5 border-b px-1.5 py-1">
          <button type="button" class="h-6 rounded-md px-2 text-xs" [class]="tab() === 'write' ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'" (click)="tab.set('write')">Write</button>
          <button type="button" class="h-6 rounded-md px-2 text-xs" [class]="tab() === 'preview' ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'" (click)="tab.set('preview')">Preview</button>
          <span class="text-meta ml-auto pr-1">Markdown</span>
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
          <button hlmBtn size="sm" variant="ghost" type="button" (click)="editing.set(false)">Cancel</button>
          <button hlmBtn size="sm" type="button" (click)="commit()">Save <app-kbd keys="mod+enter" class="opacity-70" /></button>
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
          <p class="text-muted-foreground text-sm">{{ canEdit() ? 'Add a description: steps to reproduce, who is affected, links…' : 'No description.' }}</p>
        }
        @if (canEdit()) {
          <svg [lucideIcon]="pencil" [size]="13" class="text-muted-foreground absolute top-2 right-2 opacity-0 group-hover/md:opacity-100"></svg>
        }
      </div>
    }
  `,
})
export class IssueDescription {
  readonly value = input('');
  readonly canEdit = input(true);
  readonly save = output<string>();
  protected readonly editing = signal(false);
  protected readonly tab = signal<'write' | 'preview'>('write');
  protected readonly draft = signal('');
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

  protected onClick(e: MouseEvent): void {
    if ((e.target as HTMLElement).closest('a, input')) return;
    this.start();
  }

  protected commit(): void {
    const v = this.draft().trim();
    this.editing.set(false);
    if (v !== this.value().trim()) this.save.emit(v);
  }

  protected cancel(e: Event): void {
    e.stopPropagation();
    e.preventDefault();
    this.editing.set(false);
  }
}

// ───────────────────────── workstreams ─────────────────────────

/** "This issue contributes to these outcomes": linked workstreams with status + progress. */
@Component({
  selector: 'app-issue-workstreams',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, HlmButtonImports, HlmTooltip, LucideDynamicIcon, StatusIcon, ActorAvatar, Kbd],
  host: { class: 'block' },
  template: `
    @let i = issue();
    <div class="mb-2 flex items-center gap-2">
      <svg [lucideIcon]="hex" [size]="15" class="text-entity-workstream"></svg>
      <h2 class="text-sm font-semibold">Workstreams</h2>
      @if (rows().length) {
        <span class="text-muted-foreground text-xs tabular-nums">{{ rows().length }}</span>
      }
      @if (canEdit() && !i.duplicateOfId) {
        <span class="ml-auto flex items-center gap-1">
          <button hlmBtn variant="ghost" size="sm" class="text-muted-foreground h-7 gap-1.5 px-2 text-xs" hlmTooltip="Add to workstream · W" (click)="actions.openPrompt('workstream', [i.id])">
            <svg [lucideIcon]="plus" [size]="13"></svg> Add
          </button>
        </span>
      }
    </div>
    <p class="text-muted-foreground mb-3 text-xs">
      This issue is the problem. Workstreams are the outcomes that resolve it; their status moves on its own.
    </p>

    @if (rows().length) {
      <ul class="border-border flex flex-col overflow-hidden rounded-lg border">
        @for (r of rows(); track r.ws.id) {
          <li class="group/ws hover:bg-hover relative flex min-h-11 items-center gap-2.5 border-b px-3 text-[13px] last:border-b-0">
            <a [routerLink]="['/', slug(), 'workstreams', r.ws.key]" class="absolute inset-0" [attr.aria-label]="r.ws.key + ' ' + r.ws.title"></a>
            <app-status-icon [status]="r.ws.status" entity="workstream" />
            <span class="text-muted-foreground w-[4.5rem] shrink-0 font-mono text-xs">{{ r.ws.key }}</span>
            <span class="min-w-0 flex-1 truncate font-medium">{{ r.ws.title }}</span>
            <span class="text-muted-foreground shrink-0 text-xs max-sm:hidden">{{ r.statusLabel }}</span>
            @if (r.total) {
              <span class="flex w-24 shrink-0 items-center gap-1.5 max-md:hidden" [attr.aria-label]="r.met + ' of ' + r.total + ' acceptance criteria met'">
                <span class="bg-muted h-1 flex-1 overflow-hidden rounded-full">
                  <span class="bg-status-shipped block h-full rounded-full" [style.width.%]="(r.met / r.total) * 100"></span>
                </span>
                <span class="text-muted-foreground text-[11px] tabular-nums">{{ r.met }}/{{ r.total }}</span>
              </span>
            }
            @if (r.ws.accountableUserId) {
              <app-actor-avatar [actor]="{ type: 'user', id: r.ws.accountableUserId }" [size]="18" class="max-sm:hidden" />
            }
            @if (canEdit()) {
              <button
                type="button"
                class="text-muted-foreground hover:bg-accent hover:text-foreground relative flex size-6 shrink-0 items-center justify-center rounded-md opacity-0 group-hover/ws:opacity-100 focus-visible:opacity-100"
                [attr.aria-label]="'Remove from ' + r.ws.key"
                [hlmTooltip]="'Remove from ' + r.ws.key"
                (click)="actions.unlink([i.id], r.ws.id)"
              >
                <svg [lucideIcon]="xIcon" [size]="13"></svg>
              </button>
            }
          </li>
        }
      </ul>
    } @else {
      <div class="border-border rounded-lg border border-dashed px-4 py-4">
        <p class="text-sm">Not part of any workstream yet.</p>
        <p class="text-muted-foreground mt-0.5 text-xs">
          @if (i.duplicateOfId) {
            Duplicates follow their original issue and can’t be linked.
          } @else {
            When the team decides to act on this, add it to the workstream that will resolve it, or start a new one.
          }
        </p>
        @if (canEdit() && !i.duplicateOfId) {
          <div class="mt-3 flex flex-wrap gap-2">
            <button hlmBtn size="sm" variant="outline" class="h-7 gap-1.5 text-xs" (click)="actions.openPrompt('workstream', [i.id])">
              <svg [lucideIcon]="hex" [size]="13" class="text-entity-workstream"></svg> Add to workstream <app-kbd keys="w" class="opacity-70" />
            </button>
            <button hlmBtn size="sm" variant="ghost" class="h-7 gap-1.5 text-xs" (click)="actions.createWorkstreamFrom(i)">
              <svg [lucideIcon]="sparkles" [size]="13"></svg> Create workstream from issue
            </button>
          </div>
        }
      </div>
    }
  `,
})
export class IssueWorkstreams {
  private readonly store = inject(NablaStore);
  protected readonly actions = inject(IssueActions);
  readonly issue = input.required<Issue>();
  protected readonly hex = LucideHexagon;
  protected readonly plus = LucidePlus;
  protected readonly xIcon = LucideX;
  protected readonly sparkles = LucideSparkles;
  protected readonly canEdit = computed(() => this.store.can('member'));
  protected readonly slug = computed(() => this.store.slug() ?? '');
  protected readonly rows = computed(() =>
    this.issue().workstreamIds.flatMap((id) => {
      const ws = this.store.workstreamById().get(id);
      if (!ws) return [];
      const s = buildSummary(this.store, ws);
      return [{ ws, met: s.criteriaMet, total: s.criteriaTotal, statusLabel: WORKSTREAM_STATUS_META[ws.status].label }];
    }),
  );
}

// ───────────────────────── activity ─────────────────────────

interface EventView {
  icon: LucideIcon | null;
  verb: string;
  from?: IssueStatus;
  to?: IssueStatus;
  workstreams?: string[];
}

const FIELD_VERB: Record<string, string> = {
  title: 'renamed the issue',
  body: 'edited the description',
  assigneeId: 'changed the assignee',
  teamId: 'moved the issue to another team',
  priority: 'changed the priority',
  reporterName: 'updated the reporter',
  externalUrl: 'updated the external link',
  workstreamIds: 'changed the linked workstreams',
  duplicateOfId: 'changed the duplicate relation',
};

function describe(ev: DomainEvent): EventView | null {
  const d = ev.data;
  const isStatus = (v: unknown): v is IssueStatus => typeof v === 'string' && v in ISSUE_STATUS_META;
  switch (ev.type) {
    case 'issue.created':
      return { icon: LucideCircleDot, verb: 'created the issue' };
    case 'issue.status_changed':
      return { icon: null, verb: 'changed status', from: isStatus(d['from']) ? d['from'] : undefined, to: isStatus(d['to']) ? d['to'] : undefined };
    case 'issue.updated': {
      const fields = Array.isArray(d['fields']) ? (d['fields'] as string[]) : [];
      const verbs = fields.map((f) => FIELD_VERB[f] ?? `updated ${f}`);
      return { icon: LucidePencil, verb: verbs.length ? verbs.join(', ') : 'updated the issue' };
    }
    case 'issue.linked': {
      const created = typeof d['createdWorkstreamId'] === 'string' ? d['createdWorkstreamId'] : undefined;
      if (created) return { icon: LucideSparkles, verb: 'created a workstream from this issue', workstreams: [created] };
      const ids = Array.isArray(d['workstreamIds']) ? (d['workstreamIds'] as string[]) : [];
      return { icon: LucideHexagon, verb: 'added the issue to', workstreams: ev.workstreamId ? [ev.workstreamId] : ids };
    }
    case 'comment.created':
      return null; // the comment itself is in the feed
    default:
      return { icon: LucideCircleDot, verb: ev.type.replace(/^issue\./, '').replace(/[._]/g, ' ') };
  }
}

type FeedItem = { kind: 'event'; id: string; at: string; ev: DomainEvent; view: EventView } | { kind: 'comment'; id: string; at: string; c: Comment };

/** Activity events and comments, newest first, with the composer on top. */
@Component({
  selector: 'app-issue-activity',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ActorAvatar, LucideDynamicIcon, StatusIcon, EntityChip, RelativeTimePipe, CommentItem, CommentComposer, CommentsLoader, HlmTooltip],
  host: { class: 'block' },
  template: `
    <h2 class="mb-3 text-sm font-semibold">Activity</h2>
    @if (canEdit()) {
      <div class="mb-4">
        <app-comment-composer #composer placeholder="Leave a comment…" (submitted)="send($event, composer)" />
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
                <span class="inline-flex items-center gap-1"><app-status-icon [status]="f.view.from" entity="issue" [size]="12" />{{ statusLabel(f.view.from) }}</span>
                <svg [lucideIcon]="arrow" [size]="11"></svg>
              }
              @if (f.view.to) {
                <span class="text-foreground inline-flex items-center gap-1"><app-status-icon [status]="f.view.to" entity="issue" [size]="12" />{{ statusLabel(f.view.to) }}</span>
              }
              @for (w of f.view.workstreams ?? []; track w) {
                <app-entity-chip type="workstream" [ref]="w" compact />
              }
              <span aria-hidden="true">·</span>
              <time [attr.datetime]="f.at" [hlmTooltip]="full(f.at)">{{ f.at | relativeTime }}</time>
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
      <button type="button" class="text-muted-foreground hover:text-foreground mt-3 text-xs" (click)="all.set(true)">
        Show {{ hiddenCount() }} older {{ hiddenCount() === 1 ? 'event' : 'events' }}
      </button>
    }
    <app-comments-loader [subject]="subject()" class="mt-3" />
  `,
})
export class IssueActivity {
  protected readonly store = inject(NablaStore);
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
    for (const c of this.store.commentsFor({ type: 'issue', id: i.id })) items.push({ kind: 'comment', id: c.id, at: c.createdAt, c });
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
