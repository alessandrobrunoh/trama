import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { HlmAlertDialogImports } from '@spartan-ng/helm/alert-dialog';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { UiStore } from '../core/stores/ui.store';

/** Global destructive confirmation, driven by `ui.setConfirmDelete({...})`. */
@Component({
  selector: 'app-confirm-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmAlertDialogImports, HlmButtonImports],
  template: `
    <hlm-alert-dialog [state]="open() ? 'open' : 'closed'" (closed)="ui.setConfirmDelete(null)">
      <hlm-alert-dialog-content *hlmAlertDialogPortal="let ctx">
        <hlm-alert-dialog-header>
          <h2 hlmAlertDialogTitle>{{ state()?.title }}</h2>
          <p hlmAlertDialogDescription>{{ state()?.description }}</p>
        </hlm-alert-dialog-header>
        <hlm-alert-dialog-footer>
          <button hlmAlertDialogCancel>Cancel</button>
          <button hlmAlertDialogAction [variant]="state()?.destructive === false ? 'default' : 'destructive'" [disabled]="busy()" (click)="confirm()">
            {{ state()?.confirmLabel ?? 'Delete' }}
          </button>
        </hlm-alert-dialog-footer>
      </hlm-alert-dialog-content>
    </hlm-alert-dialog>
  `,
})
export class ConfirmDialog {
  protected readonly ui = inject(UiStore);
  protected readonly state = this.ui.confirmDelete;
  protected readonly open = computed(() => this.ui.modal() === 'confirm-delete' && !!this.state());
  protected readonly busy = signal(false);

  protected async confirm(): Promise<void> {
    const s = this.state();
    if (!s) return;
    this.busy.set(true);
    try {
      await s.onConfirm();
    } finally {
      this.busy.set(false);
      this.ui.setConfirmDelete(null);
    }
  }
}
