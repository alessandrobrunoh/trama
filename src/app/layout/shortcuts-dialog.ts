import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { LucideDynamicIcon, LucideKeyboard, LucideSearch } from '@lucide/angular';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';
import { KeyboardShortcuts } from '../core/keyboard/keyboard-shortcuts.service';
import { SHORTCUT_GROUPS, type ShortcutGroup } from '../core/keyboard/shortcuts';
import { UiStore } from '../core/stores/ui.store';
import { Kbd } from '../shared/kbd';
import { V3_FIELD, V3DialogHead } from '../shared/v3';

/** Words people type for a key, so "cmd", "enter" or "arrow" find the right rows. */
const KEY_WORDS: Record<string, string> = {
  mod: 'mod cmd command ctrl control ⌘',
  shift: 'shift ⇧',
  alt: 'alt option ⌥',
  enter: 'enter return ↵',
  esc: 'esc escape',
  up: 'up arrow ↑',
  down: 'down arrow ↓',
  left: 'left arrow ←',
  right: 'right arrow →',
  space: 'space',
};

function searchText(label: string, keys: string, alt?: string): string {
  const k = `${keys} ${alt ?? ''}`
    .split(/[\s+]+/)
    .filter(Boolean)
    .map((x) => KEY_WORDS[x] ?? x)
    .join(' ');
  return `${label} ${k}`.toLowerCase();
}

/** `?` — Linear-style cheat sheet: searchable, page shortcuts first, two columns on wide screens. */
@Component({
  selector: 'app-shortcuts-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmDialogImports, Kbd, LucideDynamicIcon, V3DialogHead],
  template: `
    <hlm-dialog [state]="open() ? 'open' : 'closed'" (closed)="ui.closeModal()">
      <hlm-dialog-content *hlmDialogPortal="let ctx" class="flex max-h-[85svh] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl" [showCloseButton]="false">
        <v3-dialog-head kicker="HELP" (dismiss)="ui.closeModal()">
          <h2 hlmDialogTitle>Keyboard shortcuts</h2>
        </v3-dialog-head>
        <p hlmDialogDescription class="sr-only">Single-key shortcuts are ignored while you type in a field.</p>
        <div class="border-border relative border-b px-[18px] py-3">
          <svg [lucideIcon]="searchIcon" [size]="14" class="text-muted-foreground pointer-events-none absolute top-1/2 left-[30px] -translate-y-1/2"></svg>
          <input
            [class]="fieldClass"
            class="pl-8"
            placeholder="Search shortcuts…"
            aria-label="Search shortcuts"
            autocomplete="off"
            spellcheck="false"
            [value]="query()"
            (input)="query.set($any($event.target).value)"
          />
        </div>

        <div class="min-h-0 flex-1 overflow-y-auto px-[18px] py-4">
          @if (groups().length) {
            <div class="columns-1 gap-x-8 sm:columns-2">
              @for (g of groups(); track g.title) {
                <section class="mb-5 break-inside-avoid">
                  <h3 class="text-faint mb-1 font-mono text-[10.5px] uppercase">{{ g.title }}</h3>
                  <ul>
                    @for (i of g.items; track i.label + i.keys) {
                      <li class="flex min-h-8 items-center justify-between gap-3 text-[13px]">
                        <span class="min-w-0 truncate">{{ i.label }}</span>
                        <span class="flex shrink-0 items-center gap-1.5">
                          <app-kbd [keys]="i.keys" />
                          @if (i.alt) {
                            <span class="text-muted-foreground text-xs">or</span>
                            <app-kbd [keys]="i.alt" />
                          }
                        </span>
                      </li>
                    }
                  </ul>
                </section>
              }
            </div>
          } @else {
            <div class="text-muted-foreground flex flex-col items-center gap-1 py-12 text-center text-[13px]">
              <p>No shortcut matches “{{ query().trim() }}”.</p>
              <p class="text-xs">Try a word like “create”, “go” or a key like “mod”.</p>
            </div>
          }
        </div>

        <div class="border-border text-faint flex h-9 shrink-0 items-center gap-3 border-t px-[18px] font-mono text-[10.5px]">
          <span>Single-key shortcuts are ignored while you type in a field.</span>
          <span class="ml-auto flex items-center gap-1 max-sm:hidden"><app-kbd keys="mod+k" /> command palette</span>
        </div>
      </hlm-dialog-content>
    </hlm-dialog>
  `,
})
export class ShortcutsDialog {
  protected readonly fieldClass = V3_FIELD;
  protected readonly ui = inject(UiStore);
  private readonly kb = inject(KeyboardShortcuts);

  protected readonly keyboard = LucideKeyboard;
  protected readonly searchIcon = LucideSearch;
  protected readonly open = computed(() => this.ui.modal() === 'shortcuts');
  protected readonly query = signal('');

  /** Page shortcuts (grouped by their `group`, default "This page") first, then the global catalogue. */
  private readonly all = computed<ShortcutGroup[]>(() => {
    const page = new Map<string, ShortcutGroup>();
    for (const p of this.kb.pageShortcuts()) {
      if (p.hidden) continue;
      const title = p.group ?? 'This page';
      const g = page.get(title) ?? { title, items: [] };
      if (!g.items.some((i) => i.keys === p.keys)) g.items.push({ label: p.label, keys: p.keys });
      page.set(title, g);
    }
    return [...page.values(), ...SHORTCUT_GROUPS];
  });

  protected readonly groups = computed<ShortcutGroup[]>(() => {
    const terms = this.query().trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return this.all();
    return this.all()
      .map((g) => {
        const titleHit = terms.every((t) => g.title.toLowerCase().includes(t));
        const items = titleHit ? g.items : g.items.filter((i) => {
          const text = searchText(i.label, i.keys, i.alt);
          return terms.every((t) => text.includes(t));
        });
        return { title: g.title, items };
      })
      .filter((g) => g.items.length);
  });

  constructor() {
    // Fresh search each time the sheet opens.
    effect(() => {
      if (this.open()) this.query.set('');
    });
  }
}
