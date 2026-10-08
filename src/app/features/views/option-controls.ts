import { ChangeDetectionStrategy, Component, computed, input, model, output, signal } from '@angular/core';
import { LucideChevronDown, LucideDynamicIcon, LucideX, type LucideIcon } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmCommandImports } from '@spartan-ng/helm/command';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import { HlmPopoverImports } from '@spartan-ng/helm/popover';
import type { ActorRef } from '../../core';
import { ActorAvatar } from '../../shared/actor-avatar';
import { StatusIcon, type AnyStatus, type StatusEntity } from '../../shared/status';

/** One selectable entry for `app-option-menu` / `app-entity-picker`. */
export interface PickOption {
  value: string;
  label: string;
  /** Secondary text (searchable in the picker). */
  hint?: string;
  /** Leading colour dot (a CSS colour, e.g. a team colour). */
  color?: string;
  status?: AnyStatus;
  /** Glyph family for `status` (issues = circles, workstreams = hexagons). */
  statusEntity?: StatusEntity;
  actor?: ActorRef;
  /** Render the label in the mono face (keys). */
  mono?: boolean;
}

@Component({
  selector: 'app-option-leading',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ActorAvatar, StatusIcon],
  host: { class: 'contents' },
  template: `
    @let o = option();
    @if (o.actor) {
      <app-actor-avatar [actor]="o.actor" [size]="16" />
    } @else if (o.status) {
      <app-status-icon [status]="o.status" [entity]="o.statusEntity ?? 'auto'" [size]="14" />
    } @else if (o.color) {
      <span class="size-2.5 shrink-0 rounded-[3px]" [style.background]="o.color"></span>
    }
  `,
})
export class OptionLeading {
  readonly option = input.required<PickOption>();
}

/**
 * Filter-chip style dropdown: a small outline button "Label: summary" opening a radio (single) or
 * checkbox (multi) menu. Value is an array of selected option values (empty = no filter).
 *
 *   <app-option-menu label="Team" [options]="teamOptions()" [(selected)]="teams" multi />
 */
@Component({
  selector: 'app-option-menu',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButtonImports, HlmDropdownMenuImports, LucideDynamicIcon, OptionLeading],
  host: { class: 'inline-flex' },
  template: `
    @if (variant() === 'segment') {
      <!-- value segment of a Linear-style filter chip: no border, the chip draws it -->
      <button
        type="button"
        class="hover:bg-accent aria-expanded:bg-accent flex h-full max-w-full items-center gap-1.5 px-2 text-xs font-medium outline-none"
        [hlmDropdownMenuTrigger]="menu"
        [attr.aria-label]="label()"
      >
        @if (leadingOption(); as lo) {
          <app-option-leading [option]="lo" />
        }
        <span class="max-w-48 truncate">{{ summary() || 'any' }}</span>
      </button>
    } @else {
    <button
      hlmBtn
      variant="outline"
      size="sm"
      type="button"
      class="max-w-full gap-1.5 font-normal"
      [class.border-primary/50]="selected().length > 0"
      [class.bg-primary/5]="selected().length > 0"
      [hlmDropdownMenuTrigger]="menu"
      [attr.aria-label]="label()"
    >
      @if (icon(); as ic) {
        <svg [lucideIcon]="ic" [size]="13" class="text-muted-foreground"></svg>
      }
      <span class="text-muted-foreground">{{ label() }}</span>
      @if (summary(); as s) {
        <span class="max-w-40 truncate font-medium">{{ s }}</span>
      }
      <svg [lucideIcon]="chevron" [size]="12" class="text-muted-foreground"></svg>
    </button>
    }
    <ng-template #menu>
      <hlm-dropdown-menu class="max-h-80 w-60 overflow-y-auto">
        @if (!multi() && allowClear()) {
          <button hlmDropdownMenuRadio [checked]="selected().length === 0" [keepOpen]="false" (triggered)="clear()">
            <span class="text-muted-foreground">{{ anyLabel() }}</span>
            <hlm-dropdown-menu-radio-indicator />
          </button>
        }
        @for (o of options(); track o.value) {
          @if (multi()) {
            <button hlmDropdownMenuCheckbox [checked]="isSel(o.value)" (triggered)="toggle(o.value)">
              <app-option-leading [option]="o" />
              <span class="truncate" [class.font-mono]="o.mono">{{ o.label }}</span>
              <hlm-dropdown-menu-checkbox-indicator />
            </button>
          } @else {
            <button hlmDropdownMenuRadio [checked]="isSel(o.value)" [keepOpen]="false" (triggered)="pick(o.value)">
              <app-option-leading [option]="o" />
              <span class="truncate" [class.font-mono]="o.mono">{{ o.label }}</span>
              <hlm-dropdown-menu-radio-indicator />
            </button>
          }
        }
        @if (multi() && selected().length) {
          <hlm-dropdown-menu-separator />
          <button hlmDropdownMenuItem (triggered)="clear()">
            <svg [lucideIcon]="x" [size]="13"></svg> Clear
          </button>
        }
      </hlm-dropdown-menu>
    </ng-template>
  `,
})
export class OptionMenu {
  readonly label = input.required<string>();
  readonly options = input.required<readonly PickOption[]>();
  readonly selected = model<string[]>([]);
  readonly multi = input(false);
  readonly allowClear = input(true);
  readonly anyLabel = input('Any');
  readonly icon = input<LucideIcon>();
  /** `segment`: borderless trigger for use inside a filter chip. */
  readonly variant = input<'outline' | 'segment'>('outline');

  protected readonly chevron = LucideChevronDown;
  protected readonly x = LucideX;

  /** Glyph of the single selected option (segment variant). */
  protected readonly leadingOption = computed(() => {
    const sel = this.selected();
    return sel.length === 1 ? this.options().find((o) => o.value === sel[0]) : undefined;
  });
  protected readonly summary = computed(() => {
    const sel = this.selected();
    if (!sel.length) return '';
    const byValue = new Map(this.options().map((o) => [o.value, o.label]));
    if (sel.length === 1) return byValue.get(sel[0]) ?? sel[0];
    return `${byValue.get(sel[0]) ?? sel[0]} +${sel.length - 1}`;
  });

  protected isSel(v: string): boolean {
    return this.selected().includes(v);
  }
  protected toggle(v: string): void {
    this.selected.update((s) => (s.includes(v) ? s.filter((x) => x !== v) : [...s, v]));
  }
  protected pick(v: string): void {
    this.selected.set([v]);
  }
  protected clear(): void {
    this.selected.set([]);
  }
}

/**
 * "Add …" picker: a trigger button (projected content) opening a searchable list. Emits the value
 * of the chosen option; the parent decides what that means (add a team, supersede by…).
 *
 *   <app-entity-picker [options]="free()" placeholder="Find workstream…" (picked)="add($event)">
 *     <svg lucidePlus [size]="13"></svg> Add
 *   </app-entity-picker>
 */
@Component({
  selector: 'app-entity-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButtonImports, HlmPopoverImports, HlmCommandImports, OptionLeading],
  host: { class: 'inline-flex' },
  template: `
    <hlm-popover [state]="open() ? 'open' : 'closed'" (stateChanged)="open.set($event === 'open')" align="start" [sideOffset]="6">
      <button
        hlmPopoverTrigger
        hlmBtn
        type="button"
        [variant]="variant()"
        [size]="size()"
        [disabled]="disabled()"
        class="gap-1.5"
      >
        <ng-content />
      </button>
      <hlm-popover-content *hlmPopoverPortal="let ctx" class="w-72 gap-0 p-0">
        <hlm-command>
          <hlm-command-input [placeholder]="placeholder()" />
          <div *hlmCommandEmptyState hlmCommandEmpty>{{ emptyText() }}</div>
          <hlm-command-list class="max-h-64">
            <hlm-command-group>
              @for (o of options(); track o.value) {
                <button hlmCommandItem [value]="o.label + ' ' + (o.hint ?? '')" (selected)="choose(o)">
                  <app-option-leading [option]="o" />
                  <span class="shrink-0" [class.font-mono]="o.mono" [class.text-xs]="o.mono">{{ o.label }}</span>
                  @if (o.hint) {
                    <span class="text-muted-foreground truncate text-xs">{{ o.hint }}</span>
                  }
                </button>
              }
            </hlm-command-group>
          </hlm-command-list>
        </hlm-command>
      </hlm-popover-content>
    </hlm-popover>
  `,
})
export class EntityPicker {
  readonly options = input.required<readonly PickOption[]>();
  readonly placeholder = input('Search…');
  readonly emptyText = input('Nothing to pick.');
  readonly variant = input<'outline' | 'ghost' | 'secondary' | 'default'>('outline');
  readonly size = input<'sm' | 'default' | 'xs'>('sm');
  readonly disabled = input(false);
  readonly picked = output<string>();

  protected readonly open = signal(false);

  protected choose(o: PickOption): void {
    this.open.set(false);
    this.picked.emit(o.value);
  }
}
