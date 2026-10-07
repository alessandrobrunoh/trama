import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/** Section title + description with an optional right-aligned actions slot. */
@Component({
  selector: 'app-section-header',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'mb-4 flex flex-wrap items-start justify-between gap-x-4 gap-y-2' },
  template: `
    <div class="min-w-0">
      <h2 class="text-lg font-semibold tracking-tight">{{ title() }}</h2>
      @if (description()) {
        <p class="text-muted-foreground mt-0.5 max-w-prose text-sm leading-snug">{{ description() }}</p>
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

/** Hairline-bordered group whose children are separated by dividers. */
@Component({
  selector: 'app-settings-group',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'bg-background block overflow-hidden rounded-lg border' },
  template: `
    @if (title()) {
      <div class="bg-muted/40 text-muted-foreground border-b px-3 py-2 text-xs font-medium">{{ title() }}</div>
    }
    <div class="divide-y"><ng-content /></div>
  `,
})
export class SettingsGroup {
  readonly title = input<string>();
}

/** Label/description on the left, control on the right (stacks on narrow screens). */
@Component({
  selector: 'app-settings-row',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex min-h-12 flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-6' },
  template: `
    <div class="min-w-0 sm:max-w-[55%]">
      <div class="text-[13px] font-medium">{{ label() }}</div>
      @if (description()) {
        <div class="text-muted-foreground mt-0.5 text-xs leading-snug">{{ description() }}</div>
      }
    </div>
    <div class="min-w-0 sm:w-72 sm:shrink-0"><ng-content /></div>
  `,
})
export class SettingsRow {
  readonly label = input.required<string>();
  readonly description = input<string>();
}

/** Muted notice shown to people who can see but not change a section. */
@Component({
  selector: 'app-readonly-note',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'text-muted-foreground bg-muted/40 mb-4 block rounded-md border px-3 py-2 text-xs' },
  template: `<ng-content />`,
})
export class ReadonlyNote {}

export const SECTION_KIT = [SectionHeader, SettingsGroup, SettingsRow, ReadonlyNote] as const;
