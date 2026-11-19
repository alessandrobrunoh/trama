// Shared plumbing of the list pages for the right pane: arrow keys move the keyboard focus and the
// pane follows; a single click previews, Enter or a double click opens the full page.
import { DOCUMENT } from '@angular/common';
import {
  DestroyRef,
  Directive,
  Injectable,
  computed,
  effect,
  inject,
  input,
  output,
  untracked,
} from '@angular/core';
import { Router, type Params } from '@angular/router';
import { TramaStore, UiStore, Viewport, isTypingTarget } from '../../core';
import { RightPaneStore } from '../../core/stores/right-pane.store';

const NAV_KEYS = new Set(['ArrowDown', 'ArrowUp', 'j', 'k']);
/** How long after a navigation key a change of the focused row counts as keyboard driven. */
const KEY_WINDOW_MS = 400;

/** Ids of the tasks with an open attention item: they need the current user. */
@Injectable({ providedIn: 'root' })
export class NeedsYou {
  private readonly store = inject(TramaStore);
  readonly issueIds = computed(() => {
    const ids = new Set<string>();
    for (const a of this.store.openAttention()) if (a.issueId) ids.add(a.issueId);
    return ids;
  });
}

/**
 * Calls `show(id)` when the list's focused row changes through the keyboard (j/k and the arrows),
 * never on hover, which also moves the focused row.
 */
export function useKeyboardPreview(show: (id: string) => void): void {
  const ui = inject(UiStore);
  const document = inject(DOCUMENT);
  let lastNavigation = Number.NEGATIVE_INFINITY;
  const onKey = (e: KeyboardEvent): void => {
    if (NAV_KEYS.has(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey && !isTypingTarget(e.target)) {
      lastNavigation = performance.now();
    }
  };
  document.addEventListener('keydown', onKey);
  inject(DestroyRef).onDestroy(() => document.removeEventListener('keydown', onKey));
  effect(() => {
    const id = ui.focusedRowId();
    if (id && performance.now() - lastNavigation < KEY_WINDOW_MS) untracked(() => show(id));
  });
}

/**
 * A link that previews on a single click and navigates on Enter (a click without a pointer), a double
 * click and on phones. It replaces `routerLink` on list rows, because `routerLink` navigates on every
 * plain click. Modified clicks keep the browser default (new tab, new window).
 *
 *   <a [appPreviewLink]="['/', slug, 'tasks', key]" (preview)="select()">…</a>
 */
@Directive({
  selector: 'a[appPreviewLink]',
  host: { '[attr.href]': 'href()', '(click)': 'onClick($event)' },
})
export class PreviewLink {
  private readonly router = inject(Router);
  private readonly viewport = inject(Viewport);

  readonly appPreviewLink = input.required<readonly unknown[]>();
  readonly queryParams = input<Params | undefined>();
  /** False navigates on a single click too (rows with nothing to preview). */
  readonly previewable = input(true);
  /** A single click: the owner shows the target in the right pane. */
  readonly preview = output<MouseEvent>();

  private readonly tree = computed(() =>
    this.router.createUrlTree([...this.appPreviewLink()], { queryParams: this.queryParams() }),
  );
  protected readonly href = computed(() => this.router.serializeUrl(this.tree()));

  protected onClick(e: MouseEvent): void {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    if (this.previewable() && !this.viewport.isMobile() && isPreviewClick(e)) {
      this.preview.emit(e);
      return;
    }
    void this.router.navigateByUrl(this.tree());
  }
}

/** Whether a click on a row should preview it (plain primary single click on a wide screen). */
export function isPreviewClick(e: MouseEvent): boolean {
  return e.button === 0 && e.detail === 1 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}

/** Whether the right pane currently previews this task. */
export function isTaskPreviewed(
  pane: RightPaneStore,
  issue: { id: string; key: string },
): boolean {
  const c = pane.content();
  return c?.kind === 'task' && (c.idOrKey === issue.key || c.idOrKey === issue.id);
}
