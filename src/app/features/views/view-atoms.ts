/**
 * Small v3 atoms used by the public view page, the share popover and the views list. They only need
 * plain strings (no workspace store), so the public page can use them without a session.
 *   <v3-name-avatar name="Alessandro Bruno" [size]="20" />   square initials, colour from the name
 *   <v3-label-chip label="Bug" />                            ■ Bug (hairline box, dot by label)
 *   <v3-filter-chip field="Group" op="by" value="Status" />  Group by Status (hairline box)
 */
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { initials } from '../../core/utils';

/** Avatar fills from the v3 foundations (blue, red, green, violet). */
const AVATAR_FILL = ['#2b3a5c', '#4a2c26', '#2e4430', '#3f3552'] as const;

/** A stable index for a string (so a person keeps their colour). */
function hash(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return h;
}

/** Square avatar: initials in mono on a fill picked from the name. */
@Component({
  selector: 'v3-name-avatar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class:
      'inline-flex shrink-0 items-center justify-center font-mono leading-none text-[#dce3f7] select-none',
    '[style.width.px]': 'size()',
    '[style.height.px]': 'size()',
    '[style.background]': 'fill()',
    '[style.font-size.px]': 'size() * 0.43',
    '[attr.title]': 'name()',
    role: 'img',
    '[attr.aria-label]': 'name()',
  },
  template: `{{ text() }}`,
})
export class V3NameAvatar {
  readonly name = input.required<string>();
  readonly size = input(20);
  protected readonly text = computed(() => initials(this.name()));
  protected readonly fill = computed(() => AVATAR_FILL[hash(this.name()) % AVATAR_FILL.length]);
}

/** Dot colour for the labels the app ships with; everything else gets the faint dot. */
function labelDot(label: string): string {
  switch (label.trim().toLowerCase()) {
    case 'bug':
      return 'bg-red';
    case 'feature':
      return 'bg-status-in-progress';
    case 'improvement':
      return 'bg-delta-line';
    default:
      return 'bg-faint';
  }
}

/** Label: 6px square dot + mono 10.5 label in a hairline box. */
@Component({
  selector: 'v3-label-chip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class:
      'border-border text-muted-foreground inline-flex shrink-0 items-center gap-1.5 border font-mono text-[10.5px] leading-[14px] whitespace-nowrap',
    '[class]': "compact() ? 'px-[7px] py-px' : 'px-2 py-0.5'",
  },
  template: `<span class="size-1.5 shrink-0" [class]="dot()" aria-hidden="true"></span>{{ label() }}`,
})
export class V3LabelChip {
  readonly label = input.required<string>();
  /** Board cards use the tighter box (1px / 7px). */
  readonly compact = input(false);
  protected readonly dot = computed(() => labelDot(this.label()));
}

/** Filter chip: "Group by Status" with the field and operator faint and the value in text colour. */
@Component({
  selector: 'v3-filter-chip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class:
      'border-border inline-flex shrink-0 items-center gap-1.5 border px-[9px] py-1 font-mono text-[11px] leading-[14px] whitespace-nowrap',
  },
  template: `
    <span class="text-faint">{{ field() }}</span>
    <span class="text-faint">{{ op() }}</span>
    <span class="text-foreground">{{ value() }}</span>
  `,
})
export class V3FilterChip {
  readonly field = input.required<string>();
  readonly op = input('is');
  readonly value = input.required<string>();
}
