import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { HlmCommandImports } from '@spartan-ng/helm/command';
import { UiStore } from '../../core/stores/ui.store';
import { CommandPanel } from './command-panel';

/** `/` global search: results grouped by type (server search with a local fuzzy fallback). */
@Component({
  selector: 'app-search-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmCommandImports, CommandPanel],
  template: `
    <hlm-command-dialog
      title="Search"
      description="Search workstreams, issues, decisions, executions, artifacts, repositories and teams."
      [state]="open() ? 'open' : 'closed'"
      (stateChange)="onState($event)"
      dialogContentClass="sm:max-w-xl top-[12%] sm:top-[18%] translate-y-0 max-sm:max-w-[calc(100%-1rem)]"
    >
      @if (open()) {
        <app-command-panel mode="search" />
      }
    </hlm-command-dialog>
  `,
})
export class SearchDialog {
  private readonly ui = inject(UiStore);
  protected readonly open = computed(() => this.ui.modal() === 'search');

  protected onState(s: string): void {
    if (s === 'closed' && this.ui.modal() === 'search') this.ui.closeModal();
  }
}
