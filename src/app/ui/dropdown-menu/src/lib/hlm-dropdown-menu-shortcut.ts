import { Directive } from '@angular/core';
import { classes } from '@spartan-ng/helm/utils';

@Directive({
  selector: '[hlmDropdownMenuShortcut],hlm-dropdown-menu-shortcut',
  host: { 'data-slot': 'dropdown-menu-shortcut' },
})
export class HlmDropdownMenuShortcut {
  constructor() {
    classes(
      () =>
        // Mono 11 faint, no key-cap frame (an <app-kbd> inside is flattened to plain text).
        'text-faint ms-auto font-mono text-[11px] tracking-normal [&_kbd]:h-auto [&_kbd]:min-w-0 [&_kbd]:border-0 [&_kbd]:bg-transparent [&_kbd]:p-0 [&_kbd]:text-[11px] [&_kbd]:text-faint',
    );
  }
}
