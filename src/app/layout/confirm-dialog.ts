import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { HlmAlertDialogImports } from '@spartan-ng/helm/alert-dialog';
import { HlmKbd } from '@spartan-ng/helm/kbd';
import { Kbd } from '../shared/kbd';
import { V3_FIELD, V3DialogFoot, V3DialogHead, V3Field } from '../shared/v3';
import { UiStore } from '../core/stores/ui.store';

/**
 * Global destructive confirmation, driven by `ui.setConfirmDelete({...})`.
 * v3 · 18 Delete confirm: kicker + Newsreader title, text-2 body, Cancel `esc` · filled red Delete `⌘⌫`.
 */
@Component({
  selector: 'app-confirm-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmAlertDialogImports, HlmKbd, Kbd, V3DialogHead, V3DialogFoot, V3Field],
  template: `
    <hlm-alert-dialog [state]="open() ? 'open' : 'closed'" (closed)="ui.setConfirmDelete(null)">
      <hlm-alert-dialog-content
        *hlmAlertDialogPortal="let ctx"
        class="gap-0 p-0"
        (keydown.meta.backspace)="shortcut($event)"
        (keydown.control.backspace)="shortcut($event)"
      >
        <v3-dialog-head [kicker]="destructive() ? 'DELETE' : 'CONFIRM'" (dismiss)="ui.setConfirmDelete(null)">
          <h2 hlmAlertDialogTitle>{{ state()?.title }}</h2>
        </v3-dialog-head>
        <div class="flex flex-col gap-3.5 p-[18px]">
          <p hlmAlertDialogDescription class="text-text-2 text-[13.5px] leading-[21px] text-pretty">
            {{ state()?.description }}
          </p>
          @if (state()?.requireText; as req) {
            <form (submit)="submit($event)">
              <v3-field [label]="req.label" for="confirm-text">
                <input
                  id="confirm-text"
                  [class]="fieldClass"
                  autocomplete="off"
                  autocapitalize="off"
                  spellcheck="false"
                  [value]="typed()"
                  (input)="typed.set($any($event.target).value)"
                />
              </v3-field>
            </form>
          }
        </div>
        <v3-dialog-foot>
          <button hlmAlertDialogCancel>Cancel <kbd hlmKbd class="h-4">esc</kbd></button>
          @if (destructive()) {
            <!-- Btn / Danger, filled: red fill, light label, translucent key cap -->
            <button
              hlmAlertDialogAction
              variant="destructive"
              class="bg-destructive! hover:bg-destructive/85! border-transparent! text-white! [&_kbd]:bg-white/15 [&_kbd]:text-white"
              [disabled]="busy() || !matches()"
              (click)="confirm()"
            >
              {{ state()?.confirmLabel ?? 'Delete' }}
              <app-kbd keys="mod+backspace" class="[&_kbd]:h-4" />
            </button>
          } @else {
            <button
              hlmAlertDialogAction
              variant="default"
              [disabled]="busy() || !matches()"
              (click)="confirm()"
            >
              {{ state()?.confirmLabel ?? 'Delete' }}
            </button>
          }
        </v3-dialog-foot>
      </hlm-alert-dialog-content>
    </hlm-alert-dialog>
  `,
})
export class ConfirmDialog {
  protected readonly ui = inject(UiStore);
  protected readonly state = this.ui.confirmDelete;
  protected readonly open = computed(() => this.ui.modal() === 'confirm-delete' && !!this.state());
  protected readonly busy = signal(false);
  protected readonly fieldClass = V3_FIELD;
  protected readonly destructive = computed(() => this.state()?.destructive !== false);
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

  /** ⌘⌫ confirms a destructive action; left alone inside the text field, where it deletes a line. */
  protected shortcut(event: Event): void {
    if (!this.destructive() || (event.target as HTMLElement | null)?.tagName === 'INPUT') return;
    event.preventDefault();
    void this.confirm();
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
