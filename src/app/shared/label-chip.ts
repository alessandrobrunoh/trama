// One look for a label everywhere: a tinted pill with the label's color dot and name.
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { LabelCatalog } from './label-catalog';

/** Tint of a pill for a `#rrggbb` color. Works on light and dark backgrounds. */
export const labelTint = (color: string): string => `color-mix(in srgb, ${color} 14%, transparent)`;
export const labelEdge = (color: string): string => `color-mix(in srgb, ${color} 38%, transparent)`;

/**
 * `<app-label-chip labelId="lb_bug" />` resolves name and color from the workspace catalog.
 * Pass `name` and `color` instead to preview a label that is not saved yet.
 * An id that is no longer in the catalog renders nothing (a delete is still reaching the screen).
 */
@Component({
  selector: 'app-label-chip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'inline-flex min-w-0 max-w-full' },
  template: `
    @if (view(); as v) {
      @if (variant() === 'hairline') {
        <!-- v3 property column: a hairline box, mono 10.5, no color dot. -->
        <span
          class="border-border text-muted-foreground inline-flex max-w-full min-w-0 items-center border px-1.5 font-mono text-[10.5px] leading-[14px]"
          [class.opacity-70]="v.archived"
          [attr.title]="v.archived ? v.name + ' (archived)' : v.name"
        >
          <span class="truncate">{{ v.name }}</span>
        </span>
      } @else {
      <span
        class="text-foreground inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-full leading-none"
        [class]="size() === 'md' ? 'h-6 px-2.5 text-xs' : 'h-5 px-2 text-[11px]'"
        [class.opacity-70]="v.archived"
        [style.background]="tint(v.color)"
        [attr.title]="v.archived ? v.name + ' (archived)' : v.name"
      >
        <span class="size-1.5 shrink-0 rounded-full" [style.background]="v.color"></span>
        <span class="truncate">{{ v.name }}</span>
      </span>
      }
    }
  `,
})
export class LabelChip {
  private readonly catalog = inject(LabelCatalog);
  /** `pill`: the tinted pill with a color dot everywhere; `hairline`: the plain box of the task's property column. */
  readonly variant = input<'pill' | 'hairline'>('pill');
  readonly labelId = input<string>();
  readonly name = input<string>();
  readonly color = input<string>();
  readonly size = input<'sm' | 'md'>('sm');

  protected readonly tint = labelTint;
  protected readonly edge = labelEdge;
  protected readonly view = computed(() => {
    const id = this.labelId();
    if (id) {
      const label = this.catalog.get(id);
      return label ? { name: label.name, color: label.color, archived: !!label.archived } : null;
    }
    const name = this.name()?.trim();
    return name ? { name, color: this.color() ?? 'var(--color-muted-foreground)', archived: false } : null;
  });
}

/** A row of label chips with a "+N" for the rest. Hides itself when nothing resolves. */
@Component({
  selector: 'app-label-chips',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LabelChip],
  host: { class: 'inline-flex min-w-0 max-w-full flex-wrap items-center gap-1' },
  template: `
    @for (id of shown(); track id) {
      <app-label-chip [labelId]="id" [size]="size()" [variant]="variant()" />
    }
    @if (rest().length) {
      <span
        class="text-muted-foreground bg-foreground/[0.06] inline-flex h-5 shrink-0 items-center rounded-full px-1.5 text-[11px] leading-none"
        [attr.title]="restNames()"
      >+{{ rest().length }}</span>
    }
  `,
})
export class LabelChips {
  private readonly catalog = inject(LabelCatalog);
  readonly ids = input.required<readonly string[]>();
  readonly max = input(3);
  readonly size = input<'sm' | 'md'>('sm');
  readonly variant = input<'pill' | 'hairline'>('pill');

  private readonly known = computed(() => this.ids().filter((id) => this.catalog.byId().has(id)));
  protected readonly shown = computed(() => this.known().slice(0, this.max()));
  protected readonly rest = computed(() => this.known().slice(this.max()));
  protected readonly restNames = computed(() => this.rest().map((id) => this.catalog.get(id)?.name ?? id).join(', '));
}
