import { ChangeDetectionStrategy, Component, effect, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { HlmSidebarImports, HlmSidebarService, provideHlmSidebarConfig } from '@spartan-ng/helm/sidebar';
import { KeyboardShortcuts } from '../core/keyboard/keyboard-shortcuts.service';
import { GO_TO_ROUTES } from '../core/keyboard/shortcuts';
import { UiStore } from '../core/stores/ui.store';
import { CommandPalette } from './command-palette';
import { CreateDialog } from '../features/create/create-dialog';
import { CustomerDialogs } from '../features/customers/customer-dialogs';
import { SearchDialog } from '../features/command/search-dialog';
import { ConfirmDialog } from './confirm-dialog';
import { AppSidebar } from './sidebar';
import { ShortcutsDialog } from './shortcuts-dialog';
import { CustomizeSidebarDialog } from './customize-sidebar-dialog';
import { TopBar } from './top-bar';
import { AssistantOverlay } from '../features/ai/assistant-overlay';
import { MobileHeader } from './mobile-header';
import { MobileNav } from './mobile-nav';
import { Viewport } from '../core/viewport';

/**
 * Router parent for `/:workspaceSlug/...`.
 *   desktop: [sidebar | top bar + scrolling content]   (⌘B collapses the sidebar)
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
    CustomizeSidebarDialog,
    ConfirmDialog,
    CreateDialog,
    CustomerDialogs,
    SearchDialog,
    AssistantOverlay,
    MobileNav,
    MobileHeader,
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
    <div hlmSidebarWrapper class="bg-sidebar h-svh min-h-0 overflow-hidden max-md:h-dvh">
      <hlm-sidebar collapsible="offcanvas" variant="inset" mobileSide="bottom" sidebarContainerClass="p-0" class="[&_[data-slot=sidebar-inner]]:bg-sidebar [&_[data-slot=sidebar-inner]]:max-md:rounded-t-[28px]">
        <app-sidebar />
      </hlm-sidebar>
      <main hlmSidebarInset class="h-svh min-w-0 overflow-hidden max-md:h-dvh md:h-[calc(100svh-1rem)]">
        <app-top-bar />
        @if (viewport.isMobile()) {
          <app-mobile-header />
        }
        <div id="main-content" tabindex="-1" class="min-h-0 w-full min-w-0 flex-1 overflow-y-auto overflow-x-hidden outline-none">
          <router-outlet />
        </div>
        <app-mobile-nav />
      </main>
    </div>

    @if (ui.pendingG()) {
      <!-- G-chord hint: shows where the second key goes -->
      <div
        class="bg-popover text-popover-foreground animate-in fade-in-0 slide-in-from-bottom-1 fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-lg p-2 shadow-md duration-100 max-md:hidden"
        role="status"
      >
        <div class="text-muted-foreground px-1 pb-1.5 text-[11px] font-medium">Go to…</div>
        <div class="grid grid-cols-3 gap-x-4 gap-y-1">
          @for (r of goRoutes; track r[0]) {
            <span class="flex items-center gap-2 px-1 text-xs">
              <kbd class="border-border-strong bg-muted text-muted-foreground flex size-5 items-center justify-center rounded border font-mono text-[11px]">{{ r[0].toUpperCase() }}</kbd>
              {{ r[1].label }}
            </span>
          }
        </div>
      </div>
    }

    <!-- Global overlays are heavy (create composer, palette, search) and only needed once the user acts:
         load them after first paint instead of in the initial bundle. -->
    @defer (on idle) {
      <app-command-palette />
      <app-shortcuts-dialog />
      <app-customize-sidebar-dialog />
      <app-create-dialog />
      <app-customer-dialogs />
      <app-search-dialog />
    }
    <app-confirm-dialog />
    <app-assistant-overlay />
  `,
})
export class AppShell {
  protected readonly ui = inject(UiStore);
  protected readonly viewport = inject(Viewport);
  protected readonly goRoutes = Object.entries(GO_TO_ROUTES);
  private readonly sidebar = inject(HlmSidebarService);
  /** Installs the document-level shortcut listener (⌘K, ⌘B, ⌘J, C, G-chords, j/k…). */
  private readonly keyboard = inject(KeyboardShortcuts);

  constructor() {
    // UiStore (persisted, driven by keyboard shortcuts) → Spartan sidebar state.
    effect(() => this.sidebar.setOpen(!this.ui.sidebarCollapsed()));
  }
}
