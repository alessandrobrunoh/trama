import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { HlmAlertDialogImports } from '@spartan-ng/helm/alert-dialog';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { UiStore } from '../core/stores/ui.store';

/** Global destructive confirmation, driven by `ui.setConfirmDelete({...})`. */
@Component({
  selector: 'app-confirm-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmAlertDialogImports, HlmButtonImports, HlmInputImports],
  template: `
    <hlm-alert-dialog [state]="open() ? 'open' : 'closed'" (closed)="ui.setConfirmDelete(null)">
      <hlm-alert-dialog-content *hlmAlertDialogPortal="let ctx">
        <hlm-alert-dialog-header>
          <h2 hlmAlertDialogTitle>{{ state()?.title }}</h2>
          <p hlmAlertDialogDescription>{{ state()?.description }}</p>
        </hlm-alert-dialog-header>
        @if (state()?.requireText; as req) {
          <form class="flex flex-col gap-1.5" (submit)="submit($event)">
            <label class="text-xs font-medium" for="confirm-text">{{ req.label }}</label>
            <input
              id="confirm-text"
              hlmInput
              class="h-8 text-[13px]"
              autocomplete="off"
              autocapitalize="off"
              spellcheck="false"
              [value]="typed()"
              (input)="typed.set($any($event.target).value)"
            />
          </form>
        }
        <hlm-alert-dialog-footer>
          <button hlmAlertDialogCancel>Cancel</button>
          <button
            hlmAlertDialogAction
            [variant]="state()?.destructive === false ? 'default' : 'destructive'"
            [disabled]="busy() || !matches()"
            (click)="confirm()"
          >
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
  /** What the user typed for `requireText`. */
  protected readonly typed = signal('');
  /** True when no text is required, or what was typed is accepted. */
  protected readonly matches = computed(() => {
    const req = this.state()?.requireText;
    return !req || req.accept.includes(this.typed().trim());
  });

  constructor() {
    // every confirmation starts with an empty field
    effect(() => {
      this.state();
      untracked(() => this.typed.set(''));
    });
  }

  protected submit(event: Event): void {
    event.preventDefault();
    void this.confirm();
  }

  protected async confirm(): Promise<void> {
    const s = this.state();
    if (!s || this.busy() || !this.matches()) return;
    this.busy.set(true);
    try {
      await s.onConfirm(this.typed().trim());
    } finally {
      this.busy.set(false);
      this.ui.setConfirmDelete(null);
    }
  }
}
