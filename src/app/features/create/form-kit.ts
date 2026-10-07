import { ChangeDetectionStrategy, Component, computed, input, model } from '@angular/core';
import { HlmSelectImports } from '@spartan-ng/helm/select';

export interface Option<T extends string = string> {
  value: T;
  label: string;
  /** Muted trailing text (e.g. a key). */
  hint?: string;
}

/**
 * Thin wrapper around Spartan's select for the very common "pick one of N" case.
 *   <app-select [options]="opts" [(value)]="x" placeholder="Team" />
 * An option with value '' is the "none" entry.
 */
@Component({
  selector: 'app-select',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmSelectImports],
  host: { class: 'block min-w-0' },
  template: `
    <hlm-select [value]="value()" (valueChange)="onChange($event)" [itemToString]="toStr()" [disabled]="disabled()">
      <hlm-select-trigger class="w-full" [size]="size()" [attr.aria-label]="label() || placeholder()" [aria-invalid]="invalid() ? true : undefined">
        <hlm-select-value [placeholder]="placeholder()" />
      </hlm-select-trigger>
      <hlm-select-content *hlmSelectPortal>
        @for (o of options(); track o.value) {
          <hlm-select-item [value]="o.value">
            <span class="truncate">{{ o.label }}</span>
            @if (o.hint) {
              <span class="text-muted-foreground ml-auto pl-3 font-mono text-xs">{{ o.hint }}</span>
            }
          </hlm-select-item>
        }
      </hlm-select-content>
    </hlm-select>
  `,
})
export class AppSelect {
  readonly options = input.required<readonly Option[]>();
  readonly value = model<string>('');
  readonly placeholder = input('Select…');
  readonly label = input('');
  readonly disabled = input(false);
  readonly invalid = input(false);
  readonly size = input<'default' | 'sm'>('default');

  protected readonly toStr = computed(() => {
    const map = new Map(this.options().map((o) => [o.value, o.label]));
    return (v: unknown) => map.get(v as string) ?? '';
  });

  protected onChange(v: unknown): void {
    this.value.set((v as string | null | undefined) ?? '');
  }
}

/** Multi-select over the same option shape; shows the chosen labels comma-separated. */
@Component({
  selector: 'app-multi-select',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmSelectImports],
  host: { class: 'block min-w-0' },
  template: `
    <hlm-select-multiple [value]="value()" (valueChange)="onChange($event)" [itemToString]="toStr()" [disabled]="disabled()">
      <hlm-select-trigger class="w-full" [attr.aria-label]="label() || placeholder()">
        <hlm-select-value [placeholder]="placeholder()" />
      </hlm-select-trigger>
      <hlm-select-content *hlmSelectPortal>
        @for (o of options(); track o.value) {
          <hlm-select-item [value]="o.value">
            <span class="truncate">{{ o.label }}</span>
            @if (o.hint) {
              <span class="text-muted-foreground ml-auto pl-3 font-mono text-xs">{{ o.hint }}</span>
            }
          </hlm-select-item>
        }
      </hlm-select-content>
    </hlm-select-multiple>
  `,
})
export class AppMultiSelect {
  readonly options = input.required<readonly Option[]>();
  readonly value = model<string[]>([]);
  readonly placeholder = input('Select…');
  readonly label = input('');
  readonly disabled = input(false);

  protected readonly toStr = computed(() => {
    const map = new Map(this.options().map((o) => [o.value, o.label]));
    return (v: unknown) => map.get(v as string) ?? '';
  });

  protected onChange(v: unknown): void {
    this.value.set(Array.isArray(v) ? (v as string[]) : []);
  }
}

/** Label + control + hint/error row used by every form. */
@Component({
  selector: 'app-form-row',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex min-w-0 flex-col gap-1.5' },
  template: `
    @if (label()) {
      <label [attr.for]="for()" class="text-[13px] leading-none font-medium">
        {{ label() }}
        @if (optional()) {
          <span class="text-muted-foreground font-normal"> · optional</span>
        }
      </label>
    }
    <ng-content />
    @if (error()) {
      <p class="text-destructive text-xs" role="alert">{{ error() }}</p>
    } @else if (hint()) {
      <p class="text-muted-foreground text-xs leading-snug">{{ hint() }}</p>
    }
  `,
})
export class FormRow {
  readonly label = input('');
  readonly for = input<string>();
  readonly hint = input('');
  readonly error = input<string | null>(null);
  readonly optional = input(false);
}
