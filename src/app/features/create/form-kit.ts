import { ChangeDetectionStrategy, Component, input } from '@angular/core';

export { AppSelect, AppMultiSelect, type Option } from '../../shared/app-select';

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
