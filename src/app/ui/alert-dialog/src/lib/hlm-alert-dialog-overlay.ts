import { Directive, computed, effect, input, untracked } from '@angular/core';
import { BrnAlertDialogOverlay } from '@spartan-ng/brain/alert-dialog';
import { injectCustomClassSettable } from '@spartan-ng/brain/core';
import { hlm } from '@spartan-ng/helm/utils';
import type { ClassValue } from 'clsx';

@Directive({
  selector: '[hlmAlertDialogOverlay],hlm-alert-dialog-overlay',
  hostDirectives: [BrnAlertDialogOverlay],
})
export class HlmAlertDialogOverlay {
  private readonly _classSettable = injectCustomClassSettable({ optional: true, host: true });

  public readonly userClass = input<ClassValue>('', { alias: 'class' });
  protected readonly _computedClass = computed(() =>
    hlm(
      'data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 isolate bg-black/30 dark:bg-black/50 duration-100',
      this.userClass(),
    ),
  );

  constructor() {
    effect(() => {
      const classValue = this._computedClass();
      untracked(() => this._classSettable?.setClassToCustomElement(classValue));
    });
  }
}
