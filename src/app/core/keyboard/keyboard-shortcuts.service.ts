// Global keyboard shortcuts. Instantiate once from AppShell (`inject(KeyboardShortcuts)`;
// the constructor attaches the document listener).
//
// Global bindings: ⌘K palette, ⌘B sidebar, ⌘J theme, `/` search, `?` shortcuts, `C` create
// (context-aware), G-chords (G O/A/I/W/D/R/X/S/T/V), Esc (close overlay → up one level),
// list navigation over `[data-row-id]` rows (j/k/↑/↓, Enter, Space/x).
// Pages add their own bindings with `usePageShortcuts([...])` / `registerPageShortcuts([...])`.
import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { NablaStore } from '../stores/nabla.store';
import { CreateKind, UiStore } from '../stores/ui.store';
import { isTypingTarget } from '../utils';
import { ThemeService } from '../theme/theme.service';
import { GO_CHORD_TIMEOUT, GO_TO_ROUTES } from './shortcuts';

/** A page-level shortcut. */
export interface PageShortcut {
  /**
   * `+`-joined combo: optional modifiers `mod` (⌘/Ctrl), `shift`, `alt`, then one key:
   * a character (`e`, `?`, `1`) or `enter`, `esc`, `space`, `up`, `down`, `left`, `right`,
   * `delete`, `backspace`, `tab`. Examples: `e`, `mod+enter`, `shift+a`, `]`.
   */
  keys: string;
  label: string;
  run: (event: KeyboardEvent) => void;
  /** Only active while this returns true (e.g. "an item is focused"). */
  when?: () => boolean;
  /** Fire even while an input/textarea is focused (default: only combos with `mod`). */
  allowWhileTyping?: boolean;
  /** Section title in the shortcuts dialog (default "This page"). */
  group?: string;
}

interface Combo {
  key: string;
  mod: boolean;
  shift: boolean;
  alt: boolean;
}

const KEY_ALIASES: Record<string, string> = {
  esc: 'escape',
  escape: 'escape',
  enter: 'enter',
  return: 'enter',
  space: ' ',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
  del: 'delete',
  delete: 'delete',
  backspace: 'backspace',
  tab: 'tab',
};

function parseCombo(keys: string): Combo {
  const lower = keys.toLowerCase();
  const plusKey = lower === '+' || lower.endsWith('++');
  const parts = plusKey ? lower.slice(0, -1).split('+').filter(Boolean) : lower.split('+');
  const key = plusKey ? '+' : (parts.pop() as string);
  const combo: Combo = { key: KEY_ALIASES[key] ?? key, mod: false, shift: false, alt: false };
  for (const p of parts) {
    if (p === 'mod' || p === 'cmd' || p === 'ctrl') combo.mod = true;
    else if (p === 'shift') combo.shift = true;
    else if (p === 'alt' || p === 'opt') combo.alt = true;
  }
  return combo;
}

function matches(combo: Combo, e: KeyboardEvent): boolean {
  const mod = e.metaKey || e.ctrlKey;
  if (combo.mod !== mod || combo.alt !== e.altKey) return false;
  const key = e.key.toLowerCase();
  if (key !== combo.key) return false;
  // Letters/digits/named keys must match shift exactly; symbols (? / ] …) ignore it.
  if (/^[a-z0-9]$/.test(combo.key) || combo.key.length > 1) return combo.shift === e.shiftKey;
  return true;
}

const INTERACTIVE = 'button, a[href], [role="button"], [role="menuitem"], [role="option"], summary, [role="tab"]';

/** Detail routes where Esc goes back to the list: /:slug/<area>/:id. */
const ESC_UP = /^\/([^/]+)\/(workstreams|intake|decisions|repositories|teams|views)\/[^/?#]+/;

@Injectable({ providedIn: 'root' })
export class KeyboardShortcuts {
  private readonly document = inject(DOCUMENT);
  private readonly router = inject(Router);
  private readonly ui = inject(UiStore);
  private readonly nabla = inject(NablaStore);
  private readonly theme = inject(ThemeService);

  private gTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly _pageShortcuts = signal<{ id: number; combo: Combo; def: PageShortcut }[]>([]);
  private nextId = 1;
  private readonly listener = (event: KeyboardEvent) => this.onKeydown(event);

  /** Currently registered page shortcuts (for the shortcuts dialog), newest registration last. */
  readonly pageShortcuts = signal<readonly PageShortcut[]>([]);

  constructor() {
    this.document.addEventListener('keydown', this.listener);
    inject(DestroyRef).onDestroy(() => {
      this.document.removeEventListener('keydown', this.listener);
      clearTimeout(this.gTimer);
    });
  }

  /**
   * Register page-level shortcuts; returns the unregister function. Prefer `usePageShortcuts`
   * in components (auto-unregisters). Later registrations win on conflicts; page shortcuts
   * take priority over `c`, list navigation and `/`, but not over ⌘K/⌘B/⌘J, `?`, G-chords.
   */
  registerPageShortcuts(list: readonly PageShortcut[]): () => void {
    const entries = list.map((def) => ({ id: this.nextId++, combo: parseCombo(def.keys), def }));
    const ids = new Set(entries.map((e) => e.id));
    this._pageShortcuts.update((cur) => [...cur, ...entries]);
    this.syncPublic();
    return () => {
      this._pageShortcuts.update((cur) => cur.filter((e) => !ids.has(e.id)));
      this.syncPublic();
    };
  }

  private syncPublic(): void {
    this.pageShortcuts.set(this._pageShortcuts().map((e) => e.def));
  }

  /** Flip light/dark (⌘J). */
  toggleTheme(): void {
    this.theme.toggle();
  }

  /** Open the create dialog for what the current screen is about. */
  createInContext(): void {
    const { kind, defaults } = this.contextCreate();
    this.ui.openCreate(kind, defaults);
  }

  private contextCreate(): { kind: CreateKind; defaults: Record<string, unknown> } {
    const path = this.router.url.split(/[?#]/)[0];
    const [, , area, id] = path.split('/'); // ['', slug, area, id?]
    const key = id ? decodeURIComponent(id) : undefined;
    switch (area) {
      case 'attention':
      case 'intake':
        return { kind: 'intake', defaults: {} };
      case 'workstreams':
        return key
          ? { kind: 'execution', defaults: { workstreamId: this.nabla.getWorkstream(key)?.id } }
          : { kind: 'workstream', defaults: {} };
      case 'executions': {
        const ex = this.nabla.getExecution(key);
        return ex
          ? { kind: 'execution', defaults: { workstreamId: ex.workstreamId, parentExecutionId: ex.id } }
          : { kind: 'execution', defaults: {} };
      }
      case 'decisions':
        return { kind: 'decision', defaults: {} };
      case 'views':
        return { kind: 'view', defaults: {} };
      case 'teams':
        return key
          ? { kind: 'workstream', defaults: { ownerTeamId: this.nabla.getTeam(key)?.id } }
          : { kind: 'team', defaults: {} };
      case 'repositories':
        return key
          ? { kind: 'workstream', defaults: { repositoryIds: [key] } }
          : { kind: 'repository', defaults: {} };
      default:
        return { kind: 'workstream', defaults: {} };
    }
  }

  private goTo(segment: string): void {
    const slug = this.nabla.slug();
    if (slug) void this.router.navigateByUrl(`/${slug}/${segment}`);
  }

  private onKeydown(event: KeyboardEvent): void {
    if (event.isComposing) return;
    const mod = event.metaKey || event.ctrlKey;
    const key = event.key;
    const lower = key.length === 1 ? key.toLowerCase() : key;
    const modal = this.ui.modal();

    if (key === 'Escape') {
      // Menus/popovers that handled Esc themselves call preventDefault.
      if (event.defaultPrevented) return;
      if (this.runPage(event)) return;
      if (modal) {
        event.preventDefault();
        this.ui.closeModal();
        return;
      }
      if (this.ui.mobileSidebarOpen()) {
        event.preventDefault();
        this.ui.setMobileSidebar(false);
        return;
      }
      if (this.inOverlay(event.target)) return;
      if (isTypingTarget(event.target)) return;
      if (this.ui.hasSelection()) {
        event.preventDefault();
        this.ui.clearSelected();
        return;
      }
      const up = ESC_UP.exec(this.router.url.split(/[?#]/)[0]);
      if (up) {
        event.preventDefault();
        void this.router.navigateByUrl(`/${up[1]}/${up[2]}`);
      }
      return;
    }

    // Modifier shortcuts work while typing.
    if (mod && !event.altKey && !event.shiftKey) {
      if (lower === 'k') {
        event.preventDefault();
        this.ui.toggleCommandPalette();
        return;
      }
      if (lower === 'b') {
        event.preventDefault();
        if (this.isMobile()) this.ui.setMobileSidebar(!this.ui.mobileSidebarOpen());
        else this.ui.toggleSidebar();
        return;
      }
      if (lower === 'j') {
        event.preventDefault();
        this.toggleTheme();
        return;
      }
    }

    if (event.defaultPrevented) return;
    // Open dialogs own their keyboard handling.
    if (modal) return;
    // While typing / with modifiers only page shortcuts that use `mod` (or opt in) fire.
    if (mod || event.altKey || isTypingTarget(event.target)) {
      this.runPage(event);
      return;
    }
    if (this.inOverlay(event.target)) return;

    // G-chords (take priority over page shortcuts while pending).
    if (this.ui.pendingG()) {
      this.clearPendingG();
      const route = GO_TO_ROUTES[lower];
      if (route) {
        event.preventDefault();
        this.goTo(route.segment);
      }
      return;
    }
    if (key === '?') {
      event.preventDefault();
      this.ui.openModal('shortcuts');
      return;
    }
    if (lower === 'g' && !event.shiftKey) {
      this.ui.setPendingG(true);
      clearTimeout(this.gTimer);
      this.gTimer = setTimeout(() => this.ui.setPendingG(false), GO_CHORD_TIMEOUT);
      return;
    }

    if (this.runPage(event)) return;

    if (key === '/') {
      event.preventDefault();
      this.ui.openModal('search');
      return;
    }
    if (lower === 'c' && !event.shiftKey) {
      event.preventDefault();
      this.createInContext();
      return;
    }

    this.handleListNavigation(event);
  }

  /** Run the most recently registered page shortcut matching the event. */
  private runPage(event: KeyboardEvent): boolean {
    const typing = isTypingTarget(event.target);
    const list = this._pageShortcuts();
    for (let i = list.length - 1; i >= 0; i--) {
      const { combo, def } = list[i];
      if (!matches(combo, event)) continue;
      if (def.when && !def.when()) continue;
      if (typing && !(def.allowWhileTyping || combo.mod)) continue;
      event.preventDefault();
      def.run(event);
      return true;
    }
    return false;
  }

  /** j/k/↑/↓ move focus, Enter opens, Space/x selects — over elements with `data-row-id`. */
  private handleListNavigation(event: KeyboardEvent): void {
    const key = event.key;
    const rows = Array.from(this.document.querySelectorAll<HTMLElement>('[data-row-id]'));
    const ids = [...new Set(rows.map((el) => el.dataset['rowId']).filter((x): x is string => !!x))];
    if (!ids.length) return;
    const target = event.target instanceof HTMLElement ? event.target : null;
    const onControl = !!target && !target.hasAttribute('data-row-id') && !!target.closest(INTERACTIVE);

    const current = this.ui.focusedRowId();
    const idx = current ? ids.indexOf(current) : -1;

    if (key === 'ArrowDown' || key === 'j') {
      event.preventDefault();
      this.focusRow(ids[idx < 0 ? 0 : Math.min(ids.length - 1, idx + 1)]);
      return;
    }
    if (key === 'ArrowUp' || key === 'k') {
      event.preventDefault();
      this.focusRow(ids[idx < 0 ? 0 : Math.max(0, idx - 1)]);
      return;
    }
    const focused = idx >= 0 ? current : null;
    if (!focused) return;
    if (key === 'Enter' && !onControl) {
      const el = rows.find((r) => r.dataset['rowId'] === focused);
      const link = el?.matches('a[href]') ? el : el?.querySelector<HTMLElement>('a[href]');
      if (el) {
        event.preventDefault();
        (link ?? el).click();
      }
      return;
    }
    if ((key === ' ' && !onControl) || key === 'x') {
      event.preventDefault();
      this.ui.toggleSelected(focused);
    }
  }

  private focusRow(id: string | undefined): void {
    if (!id) return;
    this.ui.setFocusedRow(id);
    const el = this.document.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(id)}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }

  private clearPendingG(): void {
    clearTimeout(this.gTimer);
    this.ui.setPendingG(false);
  }

  private inOverlay(target: EventTarget | null): boolean {
    return (
      target instanceof HTMLElement &&
      !!target.closest('.cdk-overlay-container, [role="dialog"], [role="menu"], [role="listbox"]')
    );
  }

  private isMobile(): boolean {
    return this.document.defaultView?.matchMedia('(max-width: 767px)').matches ?? false;
  }
}

/**
 * Register page shortcuts for the lifetime of the calling component/service (call in an
 * injection context, e.g. a field initializer).
 *
 *   private readonly _keys = usePageShortcuts([
 *     { keys: 'e', label: 'Edit', run: () => this.edit() },
 *   ]);
 */
export function usePageShortcuts(list: readonly PageShortcut[]): void {
  const off = inject(KeyboardShortcuts).registerPageShortcuts(list);
  inject(DestroyRef).onDestroy(off);
}
