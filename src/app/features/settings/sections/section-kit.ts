import { ChangeDetectionStrategy, Component, booleanAttribute, inject, input, signal } from '@angular/core';
import { LucideCheck, LucideCopy, LucideDynamicIcon } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { Clipboard } from '../../../core/notify/notifier';

/** Section title + description with an optional right-aligned actions slot (Linear settings heading). */
@Component({
  selector: 'app-section-header',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'mb-8 flex flex-wrap items-end justify-between gap-x-4 gap-y-3' },
  template: `
    <div class="min-w-0">
      <h2 class="text-xl font-semibold tracking-tight">{{ title() }}</h2>
      @if (description()) {
        <p class="text-muted-foreground mt-1 max-w-prose text-[13px] leading-snug">{{ description() }}</p>
      }
    </div>
    <div class="flex shrink-0 items-center gap-2 empty:hidden">
      <ng-content select="[actions]" />
    </div>
  `,
})
export class SectionHeader {
  readonly title = input.required<string>();
  readonly description = input<string>();
}

/**
 * Titled group of hairline-separated rows:
 *   <app-settings-group title="Workspace"> <app-settings-row …/> … </app-settings-group>
 * Content projected with `[aside]` renders right of the title (e.g. a count or a small button).
 */
@Component({
  selector: 'app-settings-group',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    @if (title()) {
      <div class="mb-2 flex min-h-6 items-end justify-between gap-3 px-0.5">
        <div class="min-w-0">
          <h3 class="text-[13px] font-medium">{{ title() }}</h3>
          @if (description()) {
            <p class="text-muted-foreground mt-0.5 text-xs leading-snug">{{ description() }}</p>
          }
        </div>
        <div class="flex shrink-0 items-center gap-2 empty:hidden"><ng-content select="[aside]" /></div>
      </div>
    }
    <div class="bg-card divide-border overflow-hidden rounded-lg border [&>*+*]:border-t"><ng-content /></div>
  `,
})
export class SettingsGroup {
  readonly title = input<string>();
  readonly description = input<string>();
}

/**
 * Label/description on the left, control on the right (stacks on narrow screens).
 * `wide` gives the control a fixed 18rem column (inputs, selects); otherwise it hugs its content.
 */
@Component({
  selector: 'app-settings-row',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex min-h-14 flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6' },
  template: `
    <div class="min-w-0 flex-1">
      <div class="text-[13px] font-medium">{{ label() }}</div>
      @if (description()) {
        <div class="text-muted-foreground mt-0.5 text-xs leading-snug">{{ description() }}</div>
      }
    </div>
    <div class="min-w-0" [class]="wide() ? 'sm:w-72 sm:shrink-0' : 'flex shrink-0 flex-wrap items-center gap-2 sm:justify-end'">
      <ng-content />
    </div>
  `,
})
export class SettingsRow {
  readonly label = input.required<string>();
  readonly description = input<string>();
  readonly wide = input(false, { transform: booleanAttribute });
}

/** Muted notice shown to people who can see but not change a section. */
@Component({
  selector: 'app-readonly-note',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'text-muted-foreground bg-muted/40 mb-6 block rounded-md border px-3 py-2 text-xs' },
  template: `<ng-content />`,
})
export class ReadonlyNote {}

/** Copyable value (webhook URLs, secrets): mono text + copy button with a toast. */
@Component({
  selector: 'app-copy-field',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButtonImports, LucideDynamicIcon],
  host: { class: 'bg-muted/50 flex min-w-0 items-center gap-2 rounded-md border py-1 pr-1 pl-2.5' },
  template: `
    <code class="min-w-0 flex-1 font-mono text-xs break-all select-all" [class.blur-sm]="masked()">{{ value() }}</code>
    <ng-content />
    <button hlmBtn variant="ghost" size="icon-sm" class="text-muted-foreground size-7 shrink-0" [attr.aria-label]="'Copy ' + (label() || 'value')" (click)="copy()">
      <svg [lucideIcon]="copied() ? checkIcon : copyIcon" [size]="13"></svg>
    </button>
  `,
})
export class CopyField {
  private readonly clipboard = inject(Clipboard);
  readonly value = input.required<string>();
  /** Used in the toast ("Webhook URL copied") and the button label. */
  readonly label = input<string>('');
  /** Blur the text until it is copied or revealed by the caller. */
  readonly masked = input(false, { transform: booleanAttribute });
  protected readonly copied = signal(false);
  protected readonly copyIcon = LucideCopy;
  protected readonly checkIcon = LucideCheck;

  protected async copy(): Promise<void> {
    const ok = await this.clipboard.copy(this.value(), this.label() ? `${this.label()} copied` : 'Copied to clipboard');
    if (!ok) return;
    this.copied.set(true);
    setTimeout(() => this.copied.set(false), 1500);
  }
}

export const SECTION_KIT = [SectionHeader, SettingsGroup, SettingsRow, ReadonlyNote, CopyField] as const;
