import { Directive } from '@angular/core';
import { classes } from '@spartan-ng/helm/utils';

@Directive({
  selector: 'kbd[hlmKbd]',
  host: {
    'data-slot': 'kbd',
  },
})
export class HlmKbd {
  constructor() {
    classes(
      () =>
        "bg-background border-border border text-muted-foreground in-data-[slot=tooltip-content]:bg-accent h-[18px] w-fit min-w-[18px] gap-1 rounded-none px-[5px] font-mono text-[10.5px] font-normal [&_ng-icon:not([class*='text-'])]:text-[length:--spacing(3)] pointer-events-none inline-flex items-center justify-center select-none",
    );
  }
}
