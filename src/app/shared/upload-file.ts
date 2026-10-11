import { ChangeDetectionStrategy, Component, inject, input, output, signal } from '@angular/core';
import { LucideDynamicIcon, LucidePaperclip } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { Notifier } from '../core';
import { UPLOAD_ACCEPT, clientUploadError } from '../core/upload-url';

/** File picker. Emits a file the server will accept; the parent decides whether it becomes an artifact or markdown. */
@Component({
  selector: 'app-upload-file',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButtonImports, LucideDynamicIcon],
  host: { class: 'inline-flex' },
  template: `
    <input
      #picker
      class="sr-only"
      type="file"
      [accept]="accept"
      [disabled]="busy()"
      (change)="picked($event)"
    />
    <button
      hlmBtn
      type="button"
      [variant]="variant()"
      [size]="size()"
      [disabled]="busy()"
      [attr.aria-label]="label()"
      (click)="picker.click()"
    >
      <svg [lucideIcon]="icon" [size]="14"></svg>
      {{ label() }}
    </button>
  `,
})
export class UploadFile {
  private readonly notifier = inject(Notifier);
  readonly label = input('Upload');
  readonly variant = input<'ghost' | 'outline'>('outline');
  readonly size = input<'sm' | 'xs'>('sm');
  readonly busy = input(false);
  readonly file = output<File>();
  protected readonly icon = LucidePaperclip;
  protected readonly accept = UPLOAD_ACCEPT;
  protected readonly picking = signal(false);

  protected picked(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const reason = clientUploadError(file);
    if (reason) {
      this.notifier.error('Cannot upload that file', { description: reason });
      return;
    }
    this.file.emit(file);
  }
}
