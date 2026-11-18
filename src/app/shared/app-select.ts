import { ChangeDetectionStrategy, Component, Directive, computed, input, model } from '@angular/core';
import { BrnComboboxInput } from '@spartan-ng/brain/combobox';
import { HlmComboboxImports } from '@spartan-ng/helm/combobox';

export interface Option<T extends string = string> {
  value: T;
  label: string;
  hint?: string;
  disabled?: boolean;
}

@Directive()
abstract class SelectInputs {
  readonly options = input.required<readonly Option[]>();
  readonly placeholder = input('Select…');
  readonly label = input('');
  readonly disabled = input(false);
  readonly invalid = input(false);
  readonly size = input<'default' | 'sm'>('default');
  readonly controlId = input<string>();

  protected readonly byValue = computed(() => new Map(this.options().map((o) => [o.value, o])));
  protected readonly toLabel = (value: unknown) => this.byValue().get(String(value))?.label ?? '';
  protected readonly filter = (value: unknown, search: string) => {
    const option = this.byValue().get(String(value));
    const text = `${option?.label ?? ''} ${option?.hint ?? ''}`.toLocaleLowerCase();
    return search.trim().toLocaleLowerCase().split(/\s+/).every((word) => text.includes(word));
  };
}

const OPTIONS = `
  <hlm-combobox-content *hlmComboboxPortal class="min-w-0">
    <input brnComboboxInput type="text" aria-label="Search options" placeholder="Search options…"
      class="border-border w-full border-b px-3 py-2 text-sm focus-visible:outline-2 focus-visible:-outline-offset-2" />
    <div hlmComboboxList>
      @for (option of options(); track option.value) {
        <hlm-combobox-item [value]="option.value" [disabled]="option.disabled ?? false">
          <span class="min-w-0 truncate">{{ option.label }}</span>
          @if (option.hint) {
            <span class="text-muted-foreground ml-auto shrink-0 font-mono text-xs">{{ option.hint }}</span>
          }
        </hlm-combobox-item>
      }
    </div>
    <p hlmComboboxEmpty role="status">No matching options</p>
  </hlm-combobox-content>
`;

const TRIGGER = `
  <hlm-combobox-trigger [buttonId]="controlId() ?? triggerId" [forceInvalid]="invalid()"
    [class]="size() === 'sm' ? 'h-8 w-full justify-between' : 'w-full justify-between'">
    @if (label()) {
      <span class="sr-only">{{ label() }}: </span>
    }
    <span class="min-w-0 truncate" [class.text-muted-foreground]="!selection()">
      {{ selection() || placeholder() }}
    </span>
  </hlm-combobox-trigger>
`;

let nextId = 0;

/** String-valued picker. An explicit empty-string option can clear the selection. */
@Component({
  selector: 'app-select',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmComboboxImports, BrnComboboxInput],
  host: { class: 'block min-w-0' },
  template: `
    <hlm-combobox [value]="value()" (valueChange)="value.set($event ?? '')"
      [disabled]="disabled()" [itemToString]="toLabel" [filter]="filter"
      [isSingleValuePresent]="hasOption" autoHighlight>
      ${TRIGGER}
      ${OPTIONS}
    </hlm-combobox>
  `,
})
export class AppSelect extends SelectInputs {
  readonly value = model('');
  protected readonly triggerId = `app-select-${nextId++}`;
  protected readonly selection = computed(() => this.toLabel(this.value()));
  protected readonly hasOption = (value: unknown) =>
    typeof value === 'string' && this.byValue().has(value);
}

/** Array-valued picker that stays open while choices are toggled. */
@Component({
  selector: 'app-multi-select',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmComboboxImports, BrnComboboxInput],
  host: { class: 'block min-w-0' },
  template: `
    <hlm-combobox-multiple [value]="value()" (valueChange)="value.set($event ?? [])"
      [disabled]="disabled()" [itemToString]="toLabel" [filter]="filter"
      [closeOnSelect]="false" autoHighlight>
      ${TRIGGER}
      ${OPTIONS}
    </hlm-combobox-multiple>
  `,
})
export class AppMultiSelect extends SelectInputs {
  readonly value = model<string[]>([]);
  protected readonly triggerId = `app-select-${nextId++}`;
  protected readonly selection = computed(() => this.value().map(this.toLabel).filter(Boolean).join(', '));
}
