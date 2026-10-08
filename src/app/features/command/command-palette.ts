import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { HlmCommandImports } from '@spartan-ng/helm/command';
import { UiStore } from '../../core/stores/ui.store';
import { COMMAND_DIALOG_CLASS, CommandPanel } from './command-panel';

/** ⌘K palette: navigation, actions and global search. Mounted once in AppShell. */
@Component({
  selector: 'app-command-palette',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmCommandImports, CommandPanel],
  template: `
    <hlm-command-dialog
      title="Command palette"
      description="Search for a screen, an action or any workstream, issue or decision."
      [state]="open() ? 'open' : 'closed'"
      (stateChange)="onState($event)"
      [dialogContentClass]="dialogClass"
    >
      @if (open()) {
        <app-command-panel mode="palette" />
      }
    </hlm-command-dialog>
  `,
})
export class CommandPalette {
  private readonly ui = inject(UiStore);
  protected readonly dialogClass = COMMAND_DIALOG_CLASS;
  protected readonly open = computed(() => this.ui.modal() === 'command');

  protected onState(s: string): void {
    if (s === 'closed' && this.ui.modal() === 'command') this.ui.closeModal();
  }
}
