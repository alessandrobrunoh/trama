import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { LucideDynamicIcon, LucideSearch } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { SHORTCUT_GROUPS } from '../../../core/keyboard/shortcuts';
import { UiStore } from '../../../core/stores/ui.store';
import { Kbd } from '../../../shared/kbd';
import { SECTION_KIT } from './section-kit';

/** Read-only reference of the global shortcuts (page shortcuts live in the ? cheat sheet). */
@Component({
  selector: 'app-shortcuts-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButtonImports, HlmInputImports, LucideDynamicIcon, Kbd, ...SECTION_KIT],
  host: { class: 'block' },
  template: `
    <app-section-header title="Keyboard shortcuts" description="Single-key shortcuts are ignored while you type in a field. Press ? anywhere for the cheat sheet, including shortcuts of the current page.">
      <button actions hlmBtn size="sm" variant="outline" (click)="ui.openModal('shortcuts')">
        Open cheat sheet <app-kbd keys="?" class="opacity-70" />
      </button>
    </app-section-header>

    <div class="relative mb-6 w-full sm:w-64">
      <svg [lucideIcon]="searchIcon" [size]="13" class="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2"></svg>
      <input hlmInput class="h-8 w-full pl-8 text-[13px]" placeholder="Filter shortcuts…" aria-label="Filter shortcuts" [value]="query()" (input)="query.set($any($event.target).value)" />
    </div>

    <div class="flex flex-col gap-8">
      @for (g of groups(); track g.title) {
        <app-settings-group [title]="g.title">
          @for (i of g.items; track i.label) {
            <div class="flex min-h-10 items-center justify-between gap-3 px-4 text-[13px]">
              <span class="min-w-0 truncate">{{ i.label }}</span>
              <span class="flex shrink-0 items-center gap-1.5">
                <app-kbd [keys]="i.keys" />
                @if (i.alt) {
                  <span class="text-muted-foreground text-xs">or</span>
                  <app-kbd [keys]="i.alt" />
                }
              </span>
            </div>
          }
        </app-settings-group>
      } @empty {
        <p class="text-muted-foreground py-8 text-center text-[13px]">No shortcut matches “{{ query().trim() }}”.</p>
      }
    </div>
  `,
})
export class ShortcutsSection {
  protected readonly ui = inject(UiStore);
  protected readonly searchIcon = LucideSearch;
  protected readonly query = signal('');
  protected readonly groups = computed(() => {
    const q = this.query().trim().toLowerCase();
    if (!q) return SHORTCUT_GROUPS;
    return SHORTCUT_GROUPS.map((g) => ({
      ...g,
      items: g.items.filter((i) => `${g.title} ${i.label} ${i.keys} ${i.alt ?? ''}`.toLowerCase().includes(q)),
    })).filter((g) => g.items.length);
  });
}
