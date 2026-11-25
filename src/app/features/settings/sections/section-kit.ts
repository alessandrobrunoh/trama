import { ChangeDetectionStrategy, Component, booleanAttribute, inject, input, signal } from '@angular/core';
import { LucideCheck, LucideCopy, LucideDynamicIcon } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { Clipboard } from '../../../core/notify/notifier';

/**
 * Settings page heading (v3 "H"): Newsreader 32px title over a 13.5px muted description, with an optional
 * right-aligned actions slot.
 */
@Component({
  selector: 'app-section-header',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'mb-7 flex flex-wrap items-end justify-between gap-x-4 gap-y-3' },
  template: `
    <div class="flex min-w-0 flex-col gap-1.5">
      <h2 class="font-title text-foreground text-[32px] leading-normal">{{ title() }}</h2>
      @if (description()) {
        <p class="text-muted-foreground max-w-[720px] text-[13.5px] leading-[21px]">{{ description() }}</p>
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
 * Flat section (v3 "SH"): Newsreader 20px title, an optional mono caption beside it and an optional
 * `[aside]` slot on the right, all over a 1px hairline. The content is projected as is.
 *   <app-settings-section title="Statuses" caption="drag to reorder"> … </app-settings-section>
 */
@Component({
  selector: 'app-settings-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <div class="border-border flex items-end gap-2.5 border-b pb-2">
      <h3 class="font-title text-foreground text-[20px] leading-normal">{{ title() }}</h3>
      @if (caption()) {
        <span class="text-faint pb-[3px] font-mono text-[10.5px] leading-none">{{ caption() }}</span>
      }
      <span class="flex-1"></span>
      <div class="flex shrink-0 items-center gap-2 empty:hidden"><ng-content select="[aside]" /></div>
    </div>
    <ng-content />
  `,
})
export class SettingsSection {
  readonly title = input.required<string>();
  readonly caption = input<string>();
}

/**
 * Titled group of hairline-separated rows (v3 section head, no card): Newsreader 20 title over a 1px rule,
 * rows below each with a bottom hairline.
 *   <app-settings-group title="Workspace"> <app-settings-row …/> … </app-settings-group>
 * Content projected with `[aside]` renders right of the title (e.g. a count or a small button); `caption`
 * is the mono note beside the title and `description` a muted sentence under it.
 */
@Component({
  selector: 'app-settings-group',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block [&+app-settings-group]:mt-8' },
  template: `
    @if (title()) {
      <div class="border-border border-b pb-2">
        <div class="flex min-h-6 items-end gap-2.5">
          <h3 class="font-title text-foreground text-[20px] leading-normal">{{ title() }}</h3>
          @if (caption()) {
            <span class="text-faint pb-[3px] font-mono text-[10.5px] leading-none">{{ caption() }}</span>
          }
          <span class="flex-1"></span>
          <div class="flex shrink-0 items-center gap-2 empty:hidden"><ng-content select="[aside]" /></div>
        </div>
        @if (description()) {
          <p class="text-muted-foreground mt-0.5 max-w-[720px] text-[12.5px] leading-snug">{{ description() }}</p>
        }
      </div>
    }
    <ng-content />
  `,
})
export class SettingsGroup {
  readonly title = input<string>();
  readonly caption = input<string>();
  readonly description = input<string>();
}

/**
 * Label/description on the left, control on the right (stacks on narrow screens).
 * `wide` gives the control a fixed 18rem column (inputs, selects); otherwise it hugs its content.
 */
@Component({
  selector: 'app-settings-row',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class:
      'border-border flex min-h-[46px] flex-col gap-2 border-b px-1 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-6',
  },
  template: `
    <div class="min-w-0 flex-1">
      <div class="text-foreground text-[13px]">{{ label() }}</div>
      @if (description()) {
        <div class="text-muted-foreground mt-0.5 text-[12px] leading-snug">{{ description() }}</div>
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

/** Notice shown to people who can see but not change a section (mono, hairline, no fill). */
@Component({
  selector: 'app-readonly-note',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'text-muted-foreground border-border mb-6 block border px-3 py-2 font-mono text-[11px] leading-snug' },
  template: `<ng-content />`,
})
export class ReadonlyNote {}

/** Copyable value (webhook URLs, secrets): mono text + copy button with a toast. */
@Component({
  selector: 'app-copy-field',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButtonImports, LucideDynamicIcon],
  host: { class: 'bg-bg-deep border-border flex min-w-0 items-center gap-2 border py-1 pr-1 pl-2.5' },
  template: `
    <code class="min-w-0 flex-1 font-mono text-[11.5px] break-all select-all" [class.blur-sm]="masked()">{{ value() }}</code>
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

export const SECTION_KIT = [SectionHeader, SettingsSection, SettingsGroup, SettingsRow, ReadonlyNote, CopyField] as const;
