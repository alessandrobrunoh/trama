import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';
import { KeyboardShortcuts } from '../core/keyboard/keyboard-shortcuts.service';
import { SHORTCUT_GROUPS, type ShortcutGroup } from '../core/keyboard/shortcuts';
import { UiStore } from '../core/stores/ui.store';
import { Kbd } from '../shared/kbd';
import { V3DialogHead } from '../shared/v3';

/** `?` — the cheat sheet: page shortcuts first, then the global ones, two columns on wide screens. */
@Component({
  selector: 'app-shortcuts-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmDialogImports, Kbd, V3DialogHead],
  template: `
    <hlm-dialog [state]="open() ? 'open' : 'closed'" (closed)="ui.closeModal()">
      <hlm-dialog-content *hlmDialogPortal="let ctx" class="flex max-h-[85svh] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl" [showCloseButton]="false">
        <v3-dialog-head kicker="HELP" (dismiss)="ui.closeModal()">
          <h2 hlmDialogTitle>Keyboard shortcuts</h2>
        </v3-dialog-head>
        <p hlmDialogDescription class="sr-only">Single-key shortcuts are ignored while you type in a field.</p>
        <div class="min-h-0 flex-1 overflow-y-auto px-[18px] py-4">
          <div class="columns-1 gap-x-8 sm:columns-2">
            @for (g of groups(); track g.title) {
              <section class="mb-5 break-inside-avoid">
                <h3 class="text-faint mb-1 font-mono text-[10.5px] uppercase">{{ g.title }}</h3>
                <ul>
                  @for (i of g.items; track i.label + i.keys) {
                    <li class="flex min-h-8 items-center justify-between gap-3 text-[13px]">
                      <span class="min-w-0 truncate">{{ i.label }}</span>
                      <span class="flex shrink-0 items-center gap-1.5">
                        <app-kbd [keys]="i.keys" />
                        @if (i.alt) {
                          <span class="text-muted-foreground text-xs">or</span>
                          <app-kbd [keys]="i.alt" />
                        }
                      </span>
                    </li>
                  }
                </ul>
              </section>
            }
          </div>
        </div>
      </hlm-dialog-content>
    </hlm-dialog>
  `,
})
export class ShortcutsDialog {
  protected readonly ui = inject(UiStore);
  private readonly kb = inject(KeyboardShortcuts);

  protected readonly open = computed(() => this.ui.modal() === 'shortcuts');

  /** Page shortcuts (grouped by their `group`, default "This page") first, then the global catalogue. */
  protected readonly groups = computed<ShortcutGroup[]>(() => {
    const page = new Map<string, ShortcutGroup>();
    for (const p of this.kb.pageShortcuts()) {
      if (p.hidden) continue;
      const title = p.group ?? 'This page';
      const g = page.get(title) ?? { title, items: [] };
      if (!g.items.some((i) => i.keys === p.keys)) g.items.push({ label: p.label, keys: p.keys });
      page.set(title, g);
    }
    return [...page.values(), ...SHORTCUT_GROUPS];
  });
}
