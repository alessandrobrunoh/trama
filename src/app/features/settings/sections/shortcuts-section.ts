import { ChangeDetectionStrategy, Component } from '@angular/core';
import { SHORTCUT_GROUPS } from '../../../core/keyboard/shortcuts';
import { Kbd } from '../../../shared/kbd';
import { SECTION_KIT } from './section-kit';

@Component({
  selector: 'app-shortcuts-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Kbd, ...SECTION_KIT],
  template: `
    <app-section-header title="Keyboard shortcuts" description="Single-key shortcuts are ignored while you type in a field." />
    <div class="flex flex-col gap-5">
      @for (g of groups; track g.title) {
        <app-settings-group [title]="g.title">
          @for (i of g.items; track i.label) {
            <div class="flex min-h-9 items-center justify-between gap-3 px-3 text-[13px]">
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
      }
    </div>
  `,
})
export class ShortcutsSection {
  protected readonly groups = SHORTCUT_GROUPS;
}
