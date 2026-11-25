import { Directive } from '@angular/core';
import { BrnCommandGroup } from '@spartan-ng/brain/command';
import { classes } from '@spartan-ng/helm/utils';

@Directive({
  selector: '[hlmCommandGroup],hlm-command-group',
  hostDirectives: [
    {
      directive: BrnCommandGroup,
      inputs: ['id'],
    },
  ],
  host: {
    'data-slot': 'command-group',
  },
})
export class HlmCommandGroup {
  constructor() {
    classes(
      () =>
        // v3 group: 8px padding, mono 10px faint uppercase label sitting right on top of its rows.
        'text-foreground **:data-[slot=command-group-label]:text-faint overflow-hidden p-2 **:data-[slot=command-group-label]:px-0 **:data-[slot=command-group-label]:py-0 **:data-[slot=command-group-label]:font-mono **:data-[slot=command-group-label]:text-[10px] **:data-[slot=command-group-label]:leading-[13px] **:data-[slot=command-group-label]:font-normal **:data-[slot=command-group-label]:uppercase block data-hidden:hidden',
    );
  }
}
