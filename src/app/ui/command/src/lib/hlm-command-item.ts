import { Directive } from '@angular/core';
import { BrnCommandItem } from '@spartan-ng/brain/command';
import { classes } from '@spartan-ng/helm/utils';

@Directive({
  selector: 'button[hlmCommandItem],button[hlm-command-item]',
  hostDirectives: [
    {
      directive: BrnCommandItem,
      inputs: ['value', 'disabled', 'id'],
      outputs: ['selected'],
    },
  ],
  host: {
    'data-slot': 'command-item',
  },
})
export class HlmCommandItem {
  constructor() {
    classes(
      () =>
        "data-selected:bg-selected data-selected:text-foreground relative flex min-h-8 cursor-default items-center gap-2 rounded-md px-2 py-1 text-start text-[13px] transition-colors outline-hidden select-none [&_ng-icon:not([class*='text-'])]:text-[length:--spacing(4)] group/command-item w-full data-disabled:pointer-events-none data-disabled:opacity-50 data-hidden:hidden [&>ng-icon]:pointer-events-none [&>ng-icon]:shrink-0",
    );
  }
}
