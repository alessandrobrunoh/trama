import { CdkMenuBar } from '@angular/cdk/menu';
import { Directive } from '@angular/core';
import { classes } from '@spartan-ng/helm/utils';

@Directive({
  selector: '[hlmMenubar],hlm-menubar',
  hostDirectives: [CdkMenuBar],
  host: {
    'data-slot': 'menubar',
  },
})
export class HlmMenubar {
  constructor() {
    classes(() => 'bg-secondary h-8 gap-0.5 rounded-lg p-[3px] flex items-center');
  }
}
