import { ChangeDetectionStrategy, Component, effect, inject, untracked } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { HlmSidebarImports, HlmSidebarService, provideHlmSidebarConfig } from '@spartan-ng/helm/sidebar';
import { KeyboardShortcuts } from '../core/keyboard/keyboard-shortcuts.service';
import { UiStore } from '../core/stores/ui.store';
import { CommandPalette } from './command-palette';
import { CreateDialog } from '../features/create/create-dialog';
import { SearchDialog } from '../features/command/search-dialog';
import { ConfirmDialog } from './confirm-dialog';
import { AppSidebar } from './sidebar';
import { ShortcutsDialog } from './shortcuts-dialog';
import { TopBar } from './top-bar';

/**
 * Router parent for `/:workspaceSlug/...`.
 *   desktop: [sidebar | top bar + scrolling content]   (⌘B collapses the sidebar)
 *   mobile (≤768px): the same sidebar becomes a left sheet, opened from the top bar trigger
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
  ],
  providers: [
    // ⌘B is owned by core's KeyboardShortcuts (-> UiStore); disable Spartan's own listener.
    provideHlmSidebarConfig({
      sidebarKeyboardShortcut: '',
      sidebarWidth: '15rem',
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
    <div hlmSidebarWrapper class="h-svh min-h-0 overflow-hidden">
      <hlm-sidebar collapsible="offcanvas" class="[&_[data-slot=sidebar-inner]]:bg-sidebar">
        <app-sidebar />
      </hlm-sidebar>
      <main hlmSidebarInset class="h-svh min-w-0 overflow-hidden">
        <app-top-bar />
        <div id="main-content" tabindex="-1" class="min-h-0 flex-1 overflow-y-auto overflow-x-hidden outline-none">
          <router-outlet />
        </div>
      </main>
    </div>

    <app-command-palette />
    <app-shortcuts-dialog />
    <app-confirm-dialog />
    <app-create-dialog />
    <app-search-dialog />
  `,
})
export class AppShell {
  private readonly ui = inject(UiStore);
  private readonly sidebar = inject(HlmSidebarService);
  /** Installs the document-level shortcut listener (⌘K, ⌘B, ⌘J, C, G-chords, j/k…). */
  private readonly keyboard = inject(KeyboardShortcuts);

  constructor() {
    // UiStore (persisted, driven by keyboard shortcuts) → Spartan sidebar state.
    effect(() => this.sidebar.setOpen(!this.ui.sidebarCollapsed()));
    effect(() => this.sidebar.setOpenMobile(this.ui.mobileSidebarOpen()));
    // Spartan → UiStore (sheet closed by overlay click / Esc / link tap).
    effect(() => {
      const open = this.sidebar.openMobile();
      untracked(() => this.ui.setMobileSidebar(open));
    });
  }
}
