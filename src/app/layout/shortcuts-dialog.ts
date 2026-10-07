import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';
import { SHORTCUT_GROUPS } from '../core/keyboard/shortcuts';
import { KeyboardShortcuts } from '../core/keyboard/keyboard-shortcuts.service';
import { UiStore } from '../core/stores/ui.store';
import { Kbd } from '../shared/kbd';

@Component({
  selector: 'app-shortcuts-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmDialogImports, Kbd],
  template: `
    <hlm-dialog [state]="open() ? 'open' : 'closed'" (closed)="ui.closeModal()">
      <hlm-dialog-content *hlmDialogPortal="let ctx" class="max-h-[85svh] overflow-y-auto sm:max-w-2xl">
        <hlm-dialog-header>
          <h2 hlmDialogTitle>Keyboard shortcuts</h2>
          <p hlmDialogDescription>Single-key shortcuts are ignored while you type in a field.</p>
        </hlm-dialog-header>
        <div class="grid gap-x-8 gap-y-5 sm:grid-cols-2">
          @for (g of groups(); track g.title) {
            <section>
              <h3 class="text-muted-foreground mb-1.5 text-xs font-medium">{{ g.title }}</h3>
              <ul class="divide-y">
                @for (i of g.items; track i.label) {
                  <li class="flex min-h-8 items-center justify-between gap-3 text-[13px]">
                    <span class="truncate">{{ i.label }}</span>
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
      </hlm-dialog-content>
    </hlm-dialog>
  `,
})
export class ShortcutsDialog {
  protected readonly ui = inject(UiStore);
  private readonly kb = inject(KeyboardShortcuts);
  protected readonly open = computed(() => this.ui.modal() === 'shortcuts');
  protected readonly groups = computed(() => {
    const page = this.kb.pageShortcuts();
    const base = [...SHORTCUT_GROUPS];
    if (page.length) {
      base.unshift({ title: 'This page', items: page.map((p) => ({ label: p.label, keys: p.keys })) });
    }
    return base;
  });
}
