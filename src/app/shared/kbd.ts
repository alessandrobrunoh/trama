import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { HlmKbd } from '@spartan-ng/helm/kbd';

const isMac =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Platform-aware glyphs for modifier / special key names. */
const GLYPHS: Record<string, string> = {
  mod: isMac ? '⌘' : 'Ctrl',
  cmd: '⌘',
  ctrl: isMac ? '⌃' : 'Ctrl',
  alt: isMac ? '⌥' : 'Alt',
  option: '⌥',
  shift: '⇧',
  enter: '↵',
  return: '↵',
  esc: 'Esc',
  escape: 'Esc',
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
  backspace: '⌫',
  delete: '⌫',
  tab: 'Tab',
  space: 'Space',
};

/**
 * Keyboard shortcut chip(s) in Geist Mono. "mod" renders ⌘ on macOS and Ctrl elsewhere.
 *   <app-kbd keys="mod+k" />     → [⌘][K]
 *   <app-kbd keys="g i" />       → [G][I]
 *   <app-kbd keys="mod+shift+p" />
 * In a menu item put it last with `class="ml-auto"` (hlm dropdown items also have <hlm-dropdown-menu-shortcut>).
 */
@Component({
  selector: 'app-kbd',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmKbd],
  host: { class: 'inline-flex items-center gap-0.5' },
  template: `
    @for (k of parts(); track $index) {
      <kbd hlmKbd class="font-mono text-[11px]">{{ k }}</kbd>
    }
  `,
})
export class Kbd {
  readonly keys = input.required<string | readonly string[]>();

  protected readonly parts = computed(() => {
    const raw = this.keys();
    const list = typeof raw === 'string' ? raw.split(/[\s+]+/) : [...raw];
    return list
      .filter(Boolean)
      .map((k) => GLYPHS[k.toLowerCase()] ?? (k.length === 1 ? k.toUpperCase() : k));
  });
}
