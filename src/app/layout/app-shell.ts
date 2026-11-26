import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { HlmSidebarImports, HlmSidebarService, provideHlmSidebarConfig } from '@spartan-ng/helm/sidebar';
import { KeyboardShortcuts } from '../core/keyboard/keyboard-shortcuts.service';
import { NavigationLoading } from '../core/navigation-loading';
import { TramaStore } from '../core/stores/trama.store';
import { UiStore } from '../core/stores/ui.store';
import { CommandPalette } from './command-palette';
import { CreateDialog } from '../features/create/create-dialog';
import { SearchDialog } from '../features/command/search-dialog';
import { ConfirmDialog } from './confirm-dialog';
import { AppSidebar } from './sidebar';
import { ShortcutsDialog } from './shortcuts-dialog';
import { TopBar } from './top-bar';
import { MobileHeader } from './mobile-header';
import { MobileNav } from './mobile-nav';
import { PullToRefresh } from './mobile-pull-to-refresh';
import { ShellStatusBar } from './shell-status-bar';
import { Viewport } from '../core/viewport';
import { AssistantOverlay } from '../features/ai/assistant-overlay';
import { TramaLoader } from '../shared/trama-loader';

/**
 * Router parent for `/:workspaceSlug/...`.
 *   desktop: [sidebar | top bar + scrolling content + status bar]
 *            (⌘B collapses the sidebar; the panes are split by a hairline)
 *   mobile (≤768px): the same sidebar becomes a bottom navigation sheet, opened from the mobile bar
 * Global overlays (command palette, shortcuts, destructive confirm) are mounted once here and driven
 * by `UiStore.modal`. The create dialog (features/create) and `/` search (features/command) are mounted here too.
 */
@Component({
  selector: 'app-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterOutlet,
    HlmSidebarImports,
    AppSidebar,
    TopBar,
    CommandPalette,
    ShortcutsDialog,
    ConfirmDialog,
    CreateDialog,
    SearchDialog,
    MobileNav,
    MobileHeader,
    PullToRefresh,
    ShellStatusBar,
    AssistantOverlay,
    TramaLoader,
  ],
  providers: [
    // ⌘B is owned by core's KeyboardShortcuts (-> UiStore); disable Spartan's own listener.
    provideHlmSidebarConfig({
      sidebarKeyboardShortcut: '',
      sidebarWidth: '15.5rem',
      sidebarWidthMobile: '17rem',
      defaultOpen: true,
    }),
  ],
  host: { class: 'block' },
  template: `
    <a
      href="#main-content"
      class="bg-primary text-primary-foreground sr-only z-50 rounded-md px-3 py-1.5 text-sm focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >Skip to content</a
    >
    <div hlmSidebarWrapper class="bg-sidebar relative h-svh min-h-0 overflow-hidden max-md:h-dvh">
      <hlm-sidebar collapsible="offcanvas" variant="sidebar" mobileSide="bottom" sidebarContainerClass="p-0 border-e border-sidebar-border" class="[&_[data-slot=sidebar-inner]]:bg-sidebar">
        <app-sidebar />
      </hlm-sidebar>
      <main hlmSidebarInset class="h-svh min-w-0 overflow-hidden max-md:h-dvh">
        <app-top-bar />
        @if (viewport.isMobile()) {
          <app-mobile-header />
          <app-pull-to-refresh />
        }
        <div class="relative flex min-h-0 w-full min-w-0 flex-1 flex-col">
          <div id="main-content" tabindex="-1" class="min-h-0 w-full min-w-0 flex-1 overflow-y-auto overflow-x-hidden outline-none">
            <router-outlet />
          </div>
          @if (loading()) {
            <!-- a slow lazy route or workspace load: the page below is on its way -->
            <div
              class="bg-background/85 animate-in fade-in-0 pointer-events-none absolute inset-0 z-10 flex items-center justify-center duration-150"
            >
              <app-trama-loader [size]="40" [caption]="store.status() === 'loading' ? 'Loading workspace…' : 'Loading…'" />
            </div>
          }
        </div>
        <app-shell-status-bar />
        <app-mobile-nav />
      </main>
    </div>

    <!-- Global overlays are heavy (create composer, palette, search) and only needed once the user acts:
         load them after first paint instead of in the initial bundle. -->
    @defer (on idle) {
      <app-command-palette />
      <app-shortcuts-dialog />
      <app-create-dialog />
      <app-search-dialog />
      <app-confirm-dialog />
    }

    <!-- "Ask Trama" (⌘J): loaded the first time it is opened; its chats and draft live in AssistantStore,
         so the panel keeps its state while the pages change underneath. -->
    @defer (when ui.askOpen()) {
      <app-assistant-overlay />
    }
  `,
})
export class AppShell {
  protected readonly ui = inject(UiStore);
  protected readonly viewport = inject(Viewport);
  protected readonly store = inject(TramaStore);
  private readonly navigation = inject(NavigationLoading);
  /** A navigation or workspace load that has taken longer than a blink. */
  protected readonly loading = computed(() => this.navigation.pending());
  private readonly sidebar = inject(HlmSidebarService);
  /** Installs the document-level shortcut listener (⌘K, ⌘B, ⌘J ask, C, G-chords, j/k…). */
  private readonly keyboard = inject(KeyboardShortcuts);

  /** 768-1023px: the page next to a 240px sidebar is too narrow for list rows, so start collapsed. */
  private readonly compact = signal(false);

  constructor() {
    const win = inject(DOCUMENT).defaultView;
    if (win?.matchMedia) {
      const query = win.matchMedia('(min-width: 768px) and (max-width: 1023.98px)');
      const onChange = (e: { matches: boolean }) => this.compact.set(e.matches);
      onChange(query);
      query.addEventListener('change', onChange);
      inject(DestroyRef).onDestroy(() => query.removeEventListener('change', onChange));
    }
    // Until the shell exists a slow load is shown full-screen by the root; from here on it is shown in the pane.
    this.navigation.shellMounted.set(true);
    inject(DestroyRef).onDestroy(() => this.navigation.shellMounted.set(false));
    // UiStore (persisted, driven by keyboard shortcuts) → Spartan sidebar state.
    effect(() => this.sidebar.setOpen(!this.ui.sidebarCollapsed() && !this.compact()));
  }
}
