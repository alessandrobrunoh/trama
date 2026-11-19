import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  effect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import {
  LucideDynamicIcon,
  LucideExternalLink,
  LucideMessageSquare,
  LucidePencil,
  LucidePlus,
  LucideX,
} from '@lucide/angular';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import { TramaStore, type Issue } from '../../core';
import { ISSUE_THREAD_URL_MAX, isThreadUrl } from '../../core/contracts/domain';

/** What a person typed, as a full link: a bare `delta.dev/…` gets `https://`. */
export function toThreadUrl(raw: string): string {
  const v = raw.trim();
  return v && !/^[a-z][a-z0-9+.-]*:/i.test(v) ? `https://${v}` : v;
}

/**
 * The contract's `isThreadUrl`, plus a host check: browsers percent-encode spaces in a host
 * (`https://not a link` parses), which the server rejects.
 */
export function isValidThreadUrl(url: string): boolean {
  if (!isThreadUrl(url)) return false;
  try {
    return /^[a-z0-9.-]+$|^\[[0-9a-f:.]+\]$/i.test(new URL(url).hostname) && !/\s/.test(url);
  } catch {
    return false;
  }
}

/** `delta.dev/thread/abc` for a thread link: host and path without the scheme or a trailing slash. */
export function threadLabel(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '')}`;
  } catch {
    return url;
  }
}

/**
 * The link to the Delta thread working on a task. `action` (task header): a compact "Open thread" link, or a
 * quiet "Add thread link" when empty. `row` (inspector): the link itself. Either way: new tab, with edit and
 * clear on hover.
 */
@Component({
  selector: 'app-issue-thread-link',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmInputImports, HlmTooltip, LucideDynamicIcon],
  host: { class: 'block min-w-0 empty:hidden' },
  template: `
    @let url = issue().threadUrl;
    @if (editing()) {
      <form class="flex min-w-0 flex-col gap-1" [class.w-64]="variant() === 'action'" (submit)="save($event)">
        <div class="flex items-center gap-1.5">
          <svg [lucideIcon]="threadIcon" [size]="14" class="text-muted-foreground shrink-0"></svg>
          <input
            #field
            hlmInput
            class="h-7 min-w-0 flex-1 text-[13px]"
            placeholder="https://delta.dev/…"
            aria-label="Thread link"
            autocomplete="off"
            spellcheck="false"
            [attr.maxlength]="max"
            [attr.aria-invalid]="error() ? 'true' : null"
            [value]="draft()"
            (input)="draft.set($any($event.target).value); error.set('')"
            (keydown.escape)="cancel($event)"
            (blur)="commitOnBlur()"
          />
        </div>
        @if (error(); as e) {
          <p class="text-destructive pl-5.5 text-xs" role="alert">{{ e }}</p>
        }
      </form>
    } @else if (url) {
      <div class="group/thread flex min-w-0 items-center gap-0.5" [class.-ml-1.5]="variant() === 'row'">
        <a
          [href]="url"
          target="_blank"
          rel="noopener noreferrer"
          class="hover:bg-hover focus-visible:ring-ring flex h-7 min-w-0 items-center gap-1.5 rounded-md px-1.5 text-[13px] outline-none focus-visible:ring-2"
          [class]="variant() === 'action' ? 'text-muted-foreground hover:text-foreground' : ''"
          [hlmTooltip]="'Open thread · ' + url"
        >
          <svg [lucideIcon]="threadIcon" [size]="14" class="shrink-0" [class.text-primary]="variant() === 'row'"></svg>
          <span class="truncate">{{ variant() === 'action' ? 'Open thread' : label(url) }}</span>
          <svg [lucideIcon]="openIcon" [size]="12" class="text-muted-foreground shrink-0"></svg>
        </a>
        @if (canEdit()) {
          <span
            class="flex shrink-0 items-center opacity-0 transition-opacity group-focus-within/thread:opacity-100 group-hover/thread:opacity-100 max-lg:opacity-100"
          >
            <button
              type="button"
              class="text-muted-foreground hover:bg-hover hover:text-foreground focus-visible:ring-ring inline-flex size-6 items-center justify-center rounded-md outline-none focus-visible:ring-2"
              aria-label="Edit thread link"
              hlmTooltip="Edit link"
              (click)="start()"
            >
              <svg [lucideIcon]="editIcon" [size]="12"></svg>
            </button>
            <button
              type="button"
              class="text-muted-foreground hover:bg-hover hover:text-foreground focus-visible:ring-ring inline-flex size-6 items-center justify-center rounded-md outline-none focus-visible:ring-2"
              aria-label="Remove thread link"
              hlmTooltip="Remove link"
              (click)="clear()"
            >
              <svg [lucideIcon]="clearIcon" [size]="12"></svg>
            </button>
          </span>
        }
      </div>
    } @else if (canEdit()) {
      <button
        type="button"
        class="text-muted-foreground hover:bg-hover hover:text-foreground focus-visible:ring-ring flex h-7 items-center gap-1.5 rounded-md px-1.5 text-[13px] outline-none focus-visible:ring-2"
        [class.-ml-1.5]="variant() === 'row'"
        (click)="start()"
      >
        <svg [lucideIcon]="addIcon" [size]="14"></svg>
        Add thread link
      </button>
    }
  `,
})
export class IssueThreadLink {
  private readonly store = inject(TramaStore);

  readonly issue = input.required<Issue>();
  readonly canEdit = input(false);
  readonly variant = input<'action' | 'row'>('action');

  protected readonly threadIcon = LucideMessageSquare;
  protected readonly openIcon = LucideExternalLink;
  protected readonly editIcon = LucidePencil;
  protected readonly clearIcon = LucideX;
  protected readonly addIcon = LucidePlus;
  protected readonly max = ISSUE_THREAD_URL_MAX;

  protected readonly editing = signal(false);
  protected readonly draft = signal('');
  protected readonly error = signal('');
  private readonly field = viewChild<ElementRef<HTMLInputElement>>('field');
  private skipBlur = false;

  constructor() {
    effect(() => {
      const el = this.field()?.nativeElement;
      if (el) {
        el.focus();
        el.select();
      }
    });
    // Another task opened in the same page: drop a half-typed link.
    let last: string | undefined;
    effect(() => {
      const id = this.issue().id;
      if (last !== undefined && last !== id) this.editing.set(false);
      last = id;
    });
  }

  protected label(url: string): string {
    return threadLabel(url);
  }

  protected start(): void {
    if (!this.canEdit()) return;
    this.draft.set(this.issue().threadUrl ?? '');
    this.error.set('');
    this.editing.set(true);
  }

  protected save(event: Event): void {
    event.preventDefault();
    this.commit();
  }

  protected commitOnBlur(): void {
    if (this.skipBlur) return;
    // Leaving the field with nothing new just closes it; a wrong link stays open with its message.
    if (!this.draft().trim() || toThreadUrl(this.draft()) === (this.issue().threadUrl ?? '')) {
      this.editing.set(false);
      return;
    }
    this.commit();
  }

  private commit(): void {
    if (!this.editing()) return;
    const next = toThreadUrl(this.draft());
    if (next === (this.issue().threadUrl ?? '')) {
      this.editing.set(false);
      return;
    }
    if (!next) {
      this.clear();
      return;
    }
    if (!isValidThreadUrl(next)) {
      this.error.set('Use a full http(s) link, for example https://delta.dev/…');
      return;
    }
    this.editing.set(false);
    void this.store.updateIssue(this.issue().id, { threadUrl: next });
  }

  protected clear(): void {
    this.editing.set(false);
    if (this.issue().threadUrl) void this.store.updateIssue(this.issue().id, { threadUrl: null });
  }

  protected cancel(event: Event): void {
    event.stopPropagation();
    this.skipBlur = true;
    this.editing.set(false);
    queueMicrotask(() => (this.skipBlur = false));
  }
}
