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
      <span
        class="text-foreground inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-full border leading-none"
        [class]="size() === 'md' ? 'h-6 px-2.5 text-xs' : 'h-5 px-2 text-[11px]'"
        [class.border-dashed]="v.archived"
        [class.opacity-70]="v.archived"
        [style.background]="tint(v.color)"
        [style.border-color]="edge(v.color)"
        [attr.title]="v.archived ? v.name + ' (archived)' : v.name"
      >
        <span class="size-1.5 shrink-0 rounded-full" [style.background]="v.color"></span>
        <span class="truncate">{{ v.name }}</span>
      </span>
    }
  `,
})
export class LabelChip {
  private readonly catalog = inject(LabelCatalog);
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
      <app-label-chip [labelId]="id" [size]="size()" />
    }
    @if (rest().length) {
      <span
        class="text-muted-foreground border-border-strong inline-flex h-5 shrink-0 items-center rounded-full border px-1.5 text-[11px] leading-none"
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

  private readonly known = computed(() => this.ids().filter((id) => this.catalog.byId().has(id)));
  protected readonly shown = computed(() => this.known().slice(0, this.max()));
  protected readonly rest = computed(() => this.known().slice(this.max()));
  protected readonly restNames = computed(() => this.rest().map((id) => this.catalog.get(id)?.name ?? id).join(', '));
}
