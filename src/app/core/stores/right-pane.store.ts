// RightPaneStore — the contextual right pane of the three-pane shell (Sidebar | Main | Right pane).
// Pages call `show(...)` to put a task or project preview there; the shell renders it. `open` is
// persisted per viewer in localStorage ('trama.right-pane.v1').
//
// Phones (< 768px): the pane is a bottom sheet driven by `mobileOpen` (not persisted). `show()` there
// only swaps the content (a tap on a row navigates instead); `toggle()` / `openSheet()` open the sheet.
import { Injectable, effect, inject, signal } from '@angular/core';
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

@Injectable({ providedIn: 'root' })
export class RightPaneStore {
  private readonly viewport = inject(Viewport);
  private readonly persisted = readJson<PersistedRightPane>(RIGHT_PANE_STORAGE_KEY);

  private readonly _content = signal<RightPaneContent | null>(null);
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

  /** What the pane shows right now (null = nothing selected). */
  readonly content = this._content.asReadonly();
  /** Whether the pane is visible on desktop. Persisted per viewer. */
  readonly open = this._open.asReadonly();
  /** Whether the bottom sheet is open on phones. Not persisted. */
  readonly mobileOpen = this._mobileOpen.asReadonly();
  /** Desktop width in px (300-640). Persisted. */
  readonly width = this._width.asReadonly();

  constructor() {
    effect(() => {
      writeJson(RIGHT_PANE_STORAGE_KEY, { open: this._open(), width: this._width() });
    });
  }

  /** Put `content` in the pane. Opens it on desktop; on phones the sheet stays as it is. */
  show(content: RightPaneContent): void {
    this._content.set(content);
    if (!this.viewport.isMobile()) this._open.set(true);
  }

  /** Put `content` in the pane and open it, also as a sheet on phones. */
  openSheet(content?: RightPaneContent): void {
    if (content) this._content.set(content);
    this._open.set(true);
    this._mobileOpen.set(true);
  }

  /** Forget the content (e.g. when the selected row goes away) without changing the open state. */
  clear(): void {
    this._content.set(null);
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
