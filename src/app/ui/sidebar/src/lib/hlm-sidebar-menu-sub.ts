import { Directive } from '@angular/core';
import { classes } from '@spartan-ng/helm/utils';

@Directive({
  selector: 'ul[hlmSidebarMenuSub]',
  host: {
    'data-slot': 'sidebar-menu-sub',
    'data-sidebar': 'menu-sub',
  },
})
export class HlmSidebarMenuSub {
  constructor() {
    classes(
      () =>
        'mx-3.5 gap-1 ps-2.5 py-0.5 group-data-[collapsible=icon]:hidden rtl:-translate-x-px flex min-w-0 flex-col',
    );
  }
}
