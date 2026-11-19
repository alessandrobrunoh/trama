// RightPaneStore — the contextual right pane of the three-pane shell (Sidebar | Main | Right pane).
// Two sources feed it:
//  - a page's own content (`setPage`): e.g. the project page shows that project's properties for as
//    long as it is open;
//  - a selection (`show`): a row the reader picked on a list, or a task opened from a page.
// A selection wins over the page content, and it is dropped as soon as the reader navigates to another
// page (a different path; query-only changes such as ?tab= keep it), so a task picked on the Tasks page
// never lingers on a project page. `open` is persisted per viewer in localStorage ('trama.right-pane.v1').
//
// Phones (< 768px): the pane is a bottom sheet driven by `mobileOpen` (not persisted). `show()` there
// only swaps the content (a tap on a row navigates instead); `toggle()` / `openSheet()` open the sheet.
import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { NavigationEnd, NavigationStart, Router } from '@angular/router';
import { Viewport } from '../viewport';
import { readJson, writeJson } from './storage';

export type RightPaneContent =
  | { kind: 'task'; idOrKey: string }
  | { kind: 'project'; id: string };

interface PersistedRightPane {
  open: boolean;
  width: number;
}

export const RIGHT_PANE_STORAGE_KEY = 'trama.right-pane.v1';
export const RIGHT_PANE_MIN_WIDTH = 300;
export const RIGHT_PANE_MAX_WIDTH = 640;
export const RIGHT_PANE_DEFAULT_WIDTH = 360;

function clampWidth(px: number): number {
  if (!Number.isFinite(px)) return RIGHT_PANE_DEFAULT_WIDTH;
  return Math.min(RIGHT_PANE_MAX_WIDTH, Math.max(RIGHT_PANE_MIN_WIDTH, Math.round(px)));
}

/** "/acme/tasks?x=1#y" -> "/acme/tasks". */
function pathOf(url: string): string {
  return url.split(/[?#]/)[0];
}

@Injectable({ providedIn: 'root' })
export class RightPaneStore {
  private readonly viewport = inject(Viewport);
  private readonly router = inject(Router);
  private readonly persisted = readJson<PersistedRightPane>(RIGHT_PANE_STORAGE_KEY);

  /** A selection made on a page (row preview, task opened from a page). Dropped on navigation. */
  private readonly _selection = signal<RightPaneContent | null>(null);
  /** What the open page itself shows (set by the page, cleared when it goes away). */
  private readonly _page = signal<RightPaneContent | null>(null);
  private readonly _open = signal<boolean>(
    // First visit: open when the window has room for three panes.
    typeof this.persisted?.open === 'boolean' ? this.persisted.open : (globalThis.innerWidth ?? 1440) >= 1100,
  );
  private readonly _mobileOpen = signal(false);
  private readonly _width = signal<number>(
    typeof this.persisted?.width === 'number'
      ? clampWidth(this.persisted.width)
      : RIGHT_PANE_DEFAULT_WIDTH,
  );

  /** What the pane shows right now: the selection, else the page's own content (null = nothing). */
  readonly content = computed(() => this._selection() ?? this._page());
  /** The open page's own content (the project page's properties), whatever is selected on top of it. */
  readonly pageContent = this._page.asReadonly();
  /** True while a selection hides the page's own content. */
  readonly overridesPage = computed(() => this._selection() !== null && this._page() !== null);
  /** Whether the pane is visible on desktop. Persisted per viewer. */
  readonly open = this._open.asReadonly();
  /** Whether the bottom sheet is open on phones. Not persisted. */
  readonly mobileOpen = this._mobileOpen.asReadonly();
  /** Desktop width in px (300-640). Persisted. */
  readonly width = this._width.asReadonly();

  private committedPath = pathOf(this.router.url);

  constructor() {
    effect(() => {
      writeJson(RIGHT_PANE_STORAGE_KEY, { open: this._open(), width: this._width() });
    });
    this.router.events.subscribe((e) => {
      if (e instanceof NavigationStart) {
        // Any selection belongs to the page it was made on: leaving that page drops it.
        if (pathOf(e.url) !== this.committedPath) this._selection.set(null);
      } else if (e instanceof NavigationEnd) {
        this.committedPath = pathOf(e.urlAfterRedirects);
      }
    });
  }

  /** Put a selection in the pane. Opens it on desktop; on phones the sheet stays as it is. */
  show(content: RightPaneContent): void {
    this._selection.set(content);
    if (!this.viewport.isMobile()) this._open.set(true);
  }

  /** Select `content` and open the pane, also as a sheet on phones. */
  openSheet(content?: RightPaneContent): void {
    if (content) this._selection.set(content);
    this._open.set(true);
    this._mobileOpen.set(true);
  }

  /**
   * What the open page itself shows in the pane (`null` when it goes away). Does not change the
   * open / closed state: the reader's choice stays.
   */
  setPage(content: RightPaneContent | null): void {
    this._page.set(content);
  }

  /** Forget the selection (e.g. when the selected row goes away); the page's own content comes back. */
  clear(): void {
    this._selection.set(null);
  }

  toggle(): void {
    if (this.viewport.isMobile()) this._mobileOpen.update((v) => !v);
    else this._open.update((v) => !v);
  }

  /** Close what is showing now: the sheet on phones, the (persisted) pane on desktop. */
  close(): void {
    if (this.viewport.isMobile()) this._mobileOpen.set(false);
    else this._open.set(false);
  }

  setWidth(px: number): void {
    this._width.set(clampWidth(px));
  }
}
