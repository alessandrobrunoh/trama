import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core';
import { LucideDynamicIcon, LucideSearch } from '@lucide/angular';
import { SHORTCUT_GROUPS, type ShortcutGroup } from '../../../core/keyboard/shortcuts';
import { Kbd } from '../../../shared/kbd';
import { SECTION_KIT, type SegmentedOption } from './section-kit';

type Platform = 'mac' | 'windows';

const DETECTED: Platform =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? 'mac' : 'windows';

/**
 * Settings → Shortcuts (v4 frame): every global shortcut in two columns of cards, with a macOS / Windows switch
 * for the modifier keys and a filter. Read-only: page shortcuts live in the ? cheat sheet.
 */
@Component({
  selector: 'app-shortcuts-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideDynamicIcon, Kbd, ...SECTION_KIT],
  host: { class: 'flex flex-col gap-9 leading-[normal]' },
  template: `
    <app-section-header
      flush
      title="Shortcuts"
      description="Everything you can do without the mouse. Press ? anywhere to see this list."
    >
      <app-segmented actions aria-label="Platform" [options]="platforms" [value]="platform()" (valueChange)="platform.set($any($event))" />
    </app-section-header>

    <div class="flex items-center gap-2">
      <div class="relative w-full sm:w-80">
        <svg [lucideIcon]="searchIcon" [size]="14" class="text-faint pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2"></svg>
        <input
          [class]="field"
          placeholder="Search shortcuts"
          aria-label="Search shortcuts"
          [value]="query()"
          (input)="query.set($any($event.target).value)"
        />
      </div>
      <span class="flex-1"></span>
      <span class="text-faint font-mono text-[10.5px] leading-[normal]">{{ total() }} {{ total() === 1 ? 'shortcut' : 'shortcuts' }}</span>
    </div>

    @if (columns()[0].length || columns()[1].length) {
      <div class="grid items-start gap-6 lg:grid-cols-2">
        @for (col of columns(); track $index) {
          <div class="flex min-w-0 flex-col gap-6">
            @for (g of col; track g.title) {
              <section class="flex flex-col gap-2">
                <h3 class="text-muted-foreground font-mono text-[10.5px] leading-[normal] uppercase">{{ g.title }}</h3>
                <app-settings-card>
                  @for (i of g.items; track i.label) {
                    <div class="flex items-center gap-3 px-3 py-2 [&_kbd]:bg-secondary [&_kbd]:text-text-2 [&_kbd]:h-4" [class]="i.keys === 'mod+j' ? 'bg-primary/10' : ''">
                      <span class="text-text-2 min-w-0 flex-1 truncate text-[12.5px] leading-[normal]">{{ i.label }}</span>
                      <span class="flex shrink-0 items-center gap-[3px]">
                        <app-kbd [keys]="i.keys" [chord]="isChord(i.keys)" [platform]="platform()" />
                        @if (i.alt) {
                          <span class="text-faint font-mono text-[10.5px]">or</span>
                          <app-kbd [keys]="i.alt" [chord]="isChord(i.alt)" [platform]="platform()" />
                        }
                      </span>
                    </div>
                  }
                </app-settings-card>
              </section>
            }
          </div>
        }
      </div>
    } @else {
      <p class="border-border text-muted-foreground border border-dashed py-8 text-center text-[13px]">No shortcut matches “{{ query().trim() }}”.</p>
    }
  `,
})
export class ShortcutsSection {
  protected readonly field =
    'bg-background border-border text-foreground placeholder:text-faint focus-visible:border-primary w-full min-w-0 border py-1.5 pr-[9px] pl-8 font-sans text-[13px] leading-[normal] outline-none transition-colors';
  protected readonly searchIcon = LucideSearch;
  protected readonly query = signal('');
  protected readonly platform = signal<Platform>(DETECTED);
  protected readonly platforms: SegmentedOption[] = [
    { value: 'mac', label: 'macOS' },
    { value: 'windows', label: 'Windows' },
  ];

  protected readonly groups = computed<ShortcutGroup[]>(() => {
    const q = this.query().trim().toLowerCase();
    if (!q) return SHORTCUT_GROUPS;
    return SHORTCUT_GROUPS.map((g) => ({
      ...g,
      items: g.items.filter((i) => `${g.title} ${i.label} ${i.keys} ${i.alt ?? ''}`.toLowerCase().includes(q)),
    })).filter((g) => g.items.length);
  });

  protected readonly total = computed(() => this.groups().reduce((n, g) => n + g.items.length, 0));

  /** The groups split over two columns of about the same height. */
  protected readonly columns = computed<[ShortcutGroup[], ShortcutGroup[]]>(() => {
    const groups = this.groups();
    const half = this.total() / 2;
    const left: ShortcutGroup[] = [];
    const right: ShortcutGroup[] = [];
    let count = 0;
    for (const g of groups) {
      // A group goes left while the left column is still under half, so the big one is never split.
      (count < half ? left : right).push(g);
      count += g.items.length;
    }
    return [left, right];
  });

  /** `g i`: keys pressed one after the other. */
  protected isChord(keys: string): boolean {
    return /^g\s/i.test(keys);
  }
}
