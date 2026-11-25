import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import {
  LucideArrowBigUp,
  LucideArrowDown,
  LucideArrowLeft,
  LucideArrowRight,
  LucideArrowUp,
  LucideChevronUp,
  LucideCommand,
  LucideCornerDownLeft,
  LucideDelete,
  LucideDynamicIcon,
  LucideOption,
  type LucideIcon,
} from '@lucide/angular';
import { HlmKbd } from '@spartan-ng/helm/kbd';

const isMac =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** One piece of a key cap: plain text, or an icon for the symbols the self-hosted mono font lacks. */
export interface KbdPart {
  readonly text?: string;
  readonly icon?: LucideIcon;
  /** Spoken name of the key. */
  readonly label: string;
}

const text = (value: string, label = value): KbdPart => ({ text: value, label });
const icon = (value: LucideIcon, label: string): KbdPart => ({ icon: value, label });

/**
 * Platform-aware parts for modifier / special key names. The IBM Plex Mono subset has no ⌘ ⇧ ⌥ ⌃ ↵ ⌫ ←
 * →, so those are drawn as lucide icons instead of depending on whichever fallback font the OS picks.
 */
const glyphs = (mac: boolean): Record<string, KbdPart> => ({
  mod: mac ? icon(LucideCommand, 'Command') : text('Ctrl'),
  cmd: icon(LucideCommand, 'Command'),
  ctrl: mac ? icon(LucideChevronUp, 'Control') : text('Ctrl'),
  alt: mac ? icon(LucideOption, 'Option') : text('Alt'),
  option: icon(LucideOption, 'Option'),
  shift: icon(LucideArrowBigUp, 'Shift'),
  enter: icon(LucideCornerDownLeft, 'Enter'),
  return: icon(LucideCornerDownLeft, 'Return'),
  esc: text('Esc'),
  escape: text('Esc'),
  up: icon(LucideArrowUp, 'Up'),
  down: icon(LucideArrowDown, 'Down'),
  left: icon(LucideArrowLeft, 'Left'),
  right: icon(LucideArrowRight, 'Right'),
  backspace: icon(LucideDelete, 'Backspace'),
  delete: icon(LucideDelete, 'Delete'),
  tab: text('Tab'),
  space: text('Space'),
});

const GLYPHS_MAC = glyphs(true);
const GLYPHS_OTHER = glyphs(false);

/** Characters people type in `keys` instead of a name ("⌘+k"): same parts as the named keys. */
const SYMBOLS: Record<string, string> = {
  '⌘': 'cmd',
  '⇧': 'shift',
  '⌥': 'option',
  '⌃': 'ctrl',
  '↵': 'enter',
  '⌫': 'backspace',
  '←': 'left',
  '→': 'right',
  '↑': 'up',
  '↓': 'down',
};

/** A key cap: the parts shown side by side, plus the "+" joiner used off macOS ("Ctrl+K"). */
export interface KbdChip {
  readonly parts: readonly KbdPart[];
  readonly label: string;
}

export function kbdPart(key: string, mac = isMac): KbdPart {
  const name = SYMBOLS[key] ?? key.toLowerCase();
  return (mac ? GLYPHS_MAC : GLYPHS_OTHER)[name] ?? text(key.length === 1 ? key.toUpperCase() : key);
}

/**
 * Keyboard shortcut chip(s) in IBM Plex Mono. "mod" renders ⌘ on macOS and Ctrl elsewhere.
 *   <app-kbd keys="mod+k" />     → [⌘K]
 *   <app-kbd keys="g i" />       → [G][I]
 *   <app-kbd keys="mod+shift+p" />
 * In a menu item put it last with `class="ml-auto"` (hlm dropdown items also have <hlm-dropdown-menu-shortcut>).
 */
@Component({
  selector: 'app-kbd',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmKbd, LucideDynamicIcon],
  host: { class: 'inline-flex items-center gap-0.5' },
  template: `
    @for (chip of chips(); track $index) {
      @if (chord() && $index > 0) {
        <span class="text-muted-foreground mx-0.5 text-[11px]">then</span>
      }
      <kbd hlmKbd [attr.aria-label]="chip.label">
        @for (part of chip.parts; track $index) {
          @if (part.icon) {
            <svg
              [lucideIcon]="part.icon"
              [size]="11"
              [strokeWidth]="2"
              class="shrink-0"
              aria-hidden="true"
            ></svg>
          } @else {
            {{ part.text }}
          }
        }
      </kbd>
    }
  `,
})
export class Kbd {
  readonly keys = input.required<string | readonly string[]>();
  /** Keys are pressed one after the other ("g i"), so show "G then I". */
  readonly chord = input(false);
  /** Draws the keys of another platform than the one the app runs on (the Shortcuts page). */
  readonly platform = input<'mac' | 'windows' | null>(null);

  private readonly mac = computed(() => {
    const p = this.platform();
    return p ? p === 'mac' : isMac;
  });

  protected readonly parts = computed<readonly KbdPart[]>(() => {
    const raw = this.keys();
    const mac = this.mac();
    const list = typeof raw === 'string' ? raw.split(/[\s+]+/) : [...raw];
    return list.filter(Boolean).map((k) => kbdPart(k, mac));
  });
  /** v3: a combo is one key cap ("⌘K", "⇧R"); chords ("g i") and lists stay one cap per key. */
  protected readonly chips = computed<readonly KbdChip[]>(() => {
    const raw = this.keys();
    const parts = this.parts();
    const combo = !this.chord() && typeof raw === 'string' && raw.includes('+');
    const caps = combo ? [parts] : parts.map((p) => [p]);
    return caps.map((cap) => ({
      parts: this.mac() ? cap : cap.flatMap((p, i) => (i ? [text('+'), p] : [p])),
      label: cap.map((p) => p.label).join(' '),
    }));
  });
}
