import { Directive } from '@angular/core';
import { classes } from '@spartan-ng/helm/utils';

@Directive({
  selector: '[hlmCommandShortcut],hlm-command-shortcut',
  host: {
    'data-slot': 'command-shortcut',
  },
})
export class HlmCommandShortcut {
  constructor() {
    classes(
      () =>
        // Mono 10.5 faint; an <app-kbd> inside is flattened to plain text (frame 14: "C", "⇧C", "G I").
        'text-faint ms-auto font-mono text-[10.5px] tracking-normal [&_kbd]:h-auto [&_kbd]:min-w-0 [&_kbd]:border-0 [&_kbd]:bg-transparent [&_kbd]:p-0 [&_kbd]:text-[10.5px] [&_kbd]:text-faint',
    );
  }
}
