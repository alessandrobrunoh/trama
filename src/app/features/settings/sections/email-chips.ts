import { ChangeDetectionStrategy, Component, input, model, signal } from '@angular/core';
import { LucideDynamicIcon, LucideX } from '@lucide/angular';

const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

export function isEmail(value: string): boolean {
  return EMAIL.test(value);
}

/** Splits pasted or typed text ("a@x.io, b@x.io") into addresses, lower-cased. */
export function splitEmails(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Field of email chips (members invite, project share). Enter, comma, space or leaving the field turns what
 * was typed into chips; Backspace on an empty field removes the last one. A chip that is not an address
 * stays visible in red so it can be fixed or dropped.
 */
@Component({
  selector: 'app-email-chips',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideDynamicIcon],
  host: { class: 'block' },
  template: `
    <div
      class="bg-background border-border focus-within:border-primary flex min-h-[34px] flex-wrap items-center gap-1.5 border px-2 py-1 transition-colors"
      (click)="field.focus()"
    >
      @for (email of emails(); track email) {
        <span
          class="bg-secondary inline-flex items-center gap-1 border px-1.5 py-px font-mono text-[11px] leading-[16px]"
          [class.border-border]="valid(email)"
          [class.border-red]="!valid(email)"
          [class.text-red]="!valid(email)"
        >
          {{ email }}
          <button
            type="button"
            class="text-muted-foreground hover:text-foreground"
            [disabled]="disabled()"
            [attr.aria-label]="'Remove ' + email"
            (click)="remove(email); $event.stopPropagation()"
          >
            <svg [lucideIcon]="xIcon" [size]="11"></svg>
          </button>
        </span>
      }
      <input
        #field
        type="email"
        autocomplete="off"
        class="placeholder:text-faint min-w-32 flex-1 bg-transparent py-0.5 text-[13px] outline-none"
        [attr.aria-label]="label()"
        [placeholder]="emails().length ? 'Add more…' : placeholder()"
        [disabled]="disabled()"
        [value]="draft()"
        (input)="onInput($any($event.target).value)"
        (keydown)="onKey($event)"
        (paste)="onPaste($event)"
        (blur)="commit()"
      />
    </div>
  `,
})
export class EmailChips {
  readonly emails = model<string[]>([]);
  readonly placeholder = input('name@company.com');
  readonly label = input('Email addresses');
  readonly disabled = input(false);

  protected readonly xIcon = LucideX;
  protected readonly draft = signal('');

  protected valid(email: string): boolean {
    return isEmail(email);
  }

  protected onInput(value: string): void {
    if (/[\s,;]$/.test(value)) {
      this.draft.set(value);
      this.commit();
    } else this.draft.set(value);
  }

  protected onKey(event: KeyboardEvent): void {
    if (event.key === 'Enter' && this.draft().trim()) {
      // Enter adds the chip; the dialog's own submit shortcut is ⌘↵ / Ctrl↵.
      if (event.metaKey || event.ctrlKey) return;
      event.preventDefault();
      this.commit();
    } else if (event.key === 'Backspace' && !this.draft() && this.emails().length) {
      this.emails.set(this.emails().slice(0, -1));
    }
  }

  protected onPaste(event: ClipboardEvent): void {
    const text = event.clipboardData?.getData('text') ?? '';
    if (!/[\s,;]/.test(text.trim())) return;
    event.preventDefault();
    this.add(splitEmails(this.draft() + ' ' + text));
    this.draft.set('');
  }

  /** Turns the typed text into chips. Called by the host too before it submits. */
  commit(): void {
    const parts = splitEmails(this.draft());
    this.draft.set('');
    if (parts.length) this.add(parts);
  }

  protected remove(email: string): void {
    this.emails.set(this.emails().filter((e) => e !== email));
  }

  private add(parts: string[]): void {
    const next = [...this.emails()];
    for (const part of parts) if (!next.includes(part)) next.push(part);
    this.emails.set(next);
  }
}
