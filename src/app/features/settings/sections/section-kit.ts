import { ChangeDetectionStrategy, Component, booleanAttribute, computed, inject, input, model, signal } from '@angular/core';
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
  host: { class: 'flex flex-wrap items-end justify-between gap-x-6 gap-y-3', '[class.mb-7]': '!flush()' },
  template: `
    <div class="flex min-w-0 flex-1 flex-col gap-1.5">
      <h2 class="font-title text-foreground text-[32px] leading-[normal]">{{ title() }}</h2>
      @if (description()) {
        <p class="text-muted-foreground text-[13.5px] leading-[21px]">{{ description() }}</p>
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
  /** The page lays its blocks out with a 36px gap (v4 settings frames): no bottom margin. */
  readonly flush = input(false, { transform: booleanAttribute });
}

/**
 * Flat section (v4 "Sec"): Newsreader 20px title, an optional mono caption beside it and an optional
 * `[aside]` slot on the right, a 12px gap, then the content as is (no rule under the title).
 *   <app-settings-section title="Statuses" caption="drag to reorder"> … </app-settings-section>
 */
@Component({
  selector: 'app-settings-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex flex-col gap-3' },
  template: `
    <div class="flex items-end gap-2.5">
      <h3 class="font-title text-foreground text-[20px] leading-[normal]">{{ title() }}</h3>
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
          <h3 class="font-title text-foreground text-[20px] leading-[normal]">{{ title() }}</h3>
          @if (caption()) {
            <span class="text-faint pb-[3px] font-mono text-[10.5px] leading-none">{{ caption() }}</span>
          }
          <span class="flex-1"></span>
          <div class="flex shrink-0 items-center gap-2 empty:hidden"><ng-content select="[aside]" /></div>
        </div>
        @if (description()) {
          <p class="text-muted-foreground mt-0.5 text-[12.5px] leading-snug">{{ description() }}</p>
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

// ───────────────────────── v4 settings frames: blocks, cards, rows, switches ─────────────────────────

/**
 * Field edge + fill of the v4 settings frames: 7/10 padding (1px of it is the hairline), 13px text,
 * `bg-background`, accent edge on focus.
 */
export const SETTINGS_FIELD =
  'bg-background border-border text-foreground placeholder:text-faint focus-visible:border-primary w-full min-w-0 border px-[9px] py-1.5 font-sans text-[13px] leading-[normal] outline-none transition-colors disabled:cursor-not-allowed disabled:opacity-50';

/**
 * Makes a `<app-select>` inside the element look like a field of the v4 frames (13px sans text, 7/10 padding,
 * background fill) instead of the 26px mono combobox default. Put it on the container of the selects.
 */
export const SETTINGS_SELECT =
  '[&_[data-slot=combobox-trigger]]:bg-background [&_[data-slot=combobox-trigger]]:border-border [&_[data-slot=combobox-trigger]]:text-foreground [&_[data-slot=combobox-trigger]]:h-auto [&_[data-slot=combobox-trigger]]:px-[9px] [&_[data-slot=combobox-trigger]]:py-1.5 [&_[data-slot=combobox-trigger]]:font-sans [&_[data-slot=combobox-trigger]]:text-[13px] [&_[data-slot=combobox-trigger]]:leading-[normal]';

/**
 * Block of a settings page (v4 "Sec"): Newsreader 20 title, an optional mono caption, an optional `[aside]`
 * slot on the right and an optional muted description, 12px above the projected content (a card, a table …).
 */
@Component({
  selector: 'app-settings-block',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex flex-col gap-3' },
  template: `
    <div class="flex items-end gap-2.5">
      <h3 class="font-title text-foreground text-[20px] leading-[normal]" [class.text-red]="danger()">{{ title() }}</h3>
      @if (caption()) {
        <span class="text-faint pb-[3px] font-mono text-[10.5px] leading-none">{{ caption() }}</span>
      }
      <span class="flex-1"></span>
      <div class="flex shrink-0 items-center gap-2 pb-0.5 empty:hidden"><ng-content select="[aside]" /></div>
    </div>
    @if (description()) {
      <p class="text-muted-foreground text-[12.5px] leading-[normal]">{{ description() }}</p>
    }
    <ng-content />
  `,
})
export class SettingsBlock {
  readonly title = input.required<string>();
  readonly caption = input<string>();
  readonly description = input<string>();
  readonly danger = input(false, { transform: booleanAttribute });
}

/**
 * Card of hairline-separated rows (v4 "Card"): `bg-card` panel with a 1px edge. `danger` tints the edge red
 * (the Danger zone card), `accent` the amber notice variant.
 */
@Component({
  selector: 'app-settings-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'bg-card divide-border block divide-y border', '[class]': 'edge()' },
  template: `<ng-content />`,
})
export class SettingsCard {
  readonly tone = input<'default' | 'danger'>('default');
  protected readonly edge = computed(() => (this.tone() === 'danger' ? 'border-red/35' : 'border-border'));
}

/**
 * Row of a card (v4 "Row"): 13.5px label over a 12.5px muted description on the left, the control on the
 * right (projected). `wide` gives the control a 320px column (inputs, selects); `danger` paints the label red.
 * Stacks on narrow screens. Text that belongs under the description goes in `[below]`.
 */
@Component({
  selector: 'app-card-row',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex flex-col gap-2.5 px-4 py-3.5 sm:flex-row sm:items-center sm:gap-6', '[class]': 'selectField' },
  template: `
    <div class="flex min-w-0 flex-1 flex-col gap-[3px]">
      <span class="text-[13.5px] leading-[normal]" [class]="danger() ? 'text-red' : 'text-foreground'">{{ label() }}</span>
      @if (description()) {
        <span class="text-muted-foreground text-[12.5px] leading-[18px]">{{ description() }}</span>
      }
      <ng-content select="[below]" />
    </div>
    <div
      class="flex min-w-0 shrink-0 flex-wrap items-center gap-2 sm:justify-end"
      [class]="wide() ? 'sm:w-80 [&>*:only-child]:w-full sm:[&>*]:min-w-0' : ''"
    >
      <ng-content />
    </div>
  `,
})
export class CardRow {
  readonly label = input.required<string>();
  readonly description = input<string>();
  readonly wide = input(false, { transform: booleanAttribute });
  readonly danger = input(false, { transform: booleanAttribute });
  protected readonly selectField = SETTINGS_SELECT;
}

/**
 * Switch of the v4 settings frames: 30×18, 2px padding, 14px square knob. On = accent fill with the knob
 * (on-accent colour) to the right; off = raised fill with a hairline and a faint knob on the left.
 * Same API as `<v3-toggle>`.
 */
@Component({
  selector: 'app-switch',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'inline-flex shrink-0', '[attr.aria-label]': 'null' },
  template: `
    <button
      type="button"
      role="switch"
      class="focus-visible:ring-ring/50 flex h-[18px] w-[30px] shrink-0 items-center p-0.5 transition-colors outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50"
      [class]="checked() ? 'bg-primary justify-end' : 'bg-secondary border-border justify-start border'"
      [attr.aria-checked]="checked()"
      [attr.aria-label]="ariaLabel()"
      [disabled]="disabled()"
      (click)="checked.set(!checked())"
    >
      <span class="size-3.5" [class]="checked() ? 'bg-primary-foreground' : 'bg-faint'" aria-hidden="true"></span>
    </button>
  `,
})
export class SettingsSwitch {
  readonly checked = model(false);
  readonly disabled = input(false, { transform: booleanAttribute });
  readonly ariaLabel = input<string | null>(null, { alias: 'aria-label' });
}

/** One choice of a `<app-segmented>`. */
export interface SegmentedOption {
  value: string;
  label: string;
}

/**
 * Segmented control of the v4 settings frames: a 2px inset in `bg-background` with a hairline, mono 11.5
 * options at 4/10 padding; the selected one is raised (`bg-selected`) and in text colour.
 */
@Component({
  selector: 'app-segmented',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'bg-background border-border inline-flex w-fit shrink-0 items-stretch gap-0.5 border p-0.5',
    role: 'radiogroup',
    '[attr.aria-label]': 'ariaLabel()',
  },
  template: `
    @for (o of options(); track o.value) {
      <button
        type="button"
        role="radio"
        class="focus-visible:ring-ring/50 px-2.5 py-1 font-mono text-[11.5px] leading-[normal] whitespace-nowrap outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50"
        [class]="o.value === value() ? 'bg-selected text-foreground' : 'text-muted-foreground hover:text-foreground'"
        [attr.aria-checked]="o.value === value()"
        [disabled]="disabled()"
        (click)="value.set(o.value)"
      >
        {{ o.label }}
      </button>
    }
  `,
})
export class SettingsSegmented {
  readonly options = input.required<readonly SegmentedOption[]>();
  readonly value = model<string>('');
  readonly disabled = input(false, { transform: booleanAttribute });
  readonly ariaLabel = input<string | null>(null, { alias: 'aria-label' });
}

/** One cell of a `<app-stat-strip>`. */
export interface StatCell {
  label: string;
  value: string;
  /** Mono note under the value. */
  note?: string;
}

/**
 * Strip of stats (v4 "Stats"): equal cells in a card edge, a hairline between them; mono 10.5 label, Newsreader
 * value (18 by default, 22 with `large`), optional mono note.
 */
@Component({
  selector: 'app-stat-strip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'bg-card border-border grid grid-cols-2 border sm:flex' },
  template: `
    @for (c of cells(); track c.label) {
      <div
        class="border-border flex min-w-0 flex-1 gap-1 px-4 py-3.5 [&:nth-child(even)]:border-l [&:nth-child(n+3)]:border-t sm:[&:nth-child(n+3)]:border-t-0 sm:[&:not(:first-child)]:border-l"
        [class]="valueFirst() ? 'flex-col-reverse' : 'flex-col'"
      >
        <span class="text-faint font-mono text-[10.5px] leading-[normal] uppercase">{{ c.label }}</span>
        <span class="font-title text-foreground truncate leading-[normal]" [class]="large() ? 'text-[22px]' : 'text-[18px]'">{{ c.value }}</span>
        @if (c.note) {
          <span class="text-faint truncate font-mono text-[10.5px] leading-[normal]">{{ c.note }}</span>
        }
      </div>
    }
  `,
})
export class StatStrip {
  readonly cells = input.required<readonly StatCell[]>();
  readonly large = input(false, { transform: booleanAttribute });
  /** Value above the label (the Import counts) instead of the label above the value. */
  readonly valueFirst = input(false, { transform: booleanAttribute });
}

export const SECTION_KIT = [
  SectionHeader,
  SettingsSection,
  SettingsGroup,
  SettingsRow,
  ReadonlyNote,
  CopyField,
  SettingsBlock,
  SettingsCard,
  CardRow,
  SettingsSwitch,
  SettingsSegmented,
  StatStrip,
] as const;
