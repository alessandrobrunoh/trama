import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideSearch } from '@ng-icons/lucide';
import { BrnCommandInput } from '@spartan-ng/brain/command';
import { classes } from '@spartan-ng/helm/utils';

/**
 * v3 picker search (frame 17): a 37px row with a 13px faint search glyph and a Sans 13 field, accent caret,
 * closed by a hairline.
 */
@Component({
  selector: 'hlm-command-input',
  imports: [NgIcon, BrnCommandInput],
  providers: [provideIcons({ lucideSearch })],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    'data-slot': 'command-input-wrapper',
  },
  template: `
    <ng-icon name="lucideSearch" class="text-faint shrink-0 text-[13px]" />
    <input
      brnCommandInput
      data-slot="command-input"
      class="placeholder:text-faint caret-primary min-w-0 flex-1 bg-transparent text-[13px] outline-hidden disabled:cursor-not-allowed disabled:opacity-50"
      [id]="inputId()"
      [placeholder]="placeholder()"
    />
  `,
})
export class HlmCommandInput {
  public readonly inputId = input<string | undefined>();
  public readonly placeholder = input<string>('');

  constructor() {
    classes(() => 'border-border flex h-[37.5px] shrink-0 items-center gap-2 border-b px-3');
  }
}
