import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { LucideCheck, LucideDynamicIcon, LucideGitBranch } from '@lucide/angular';
import { HlmSwitchImports } from '@spartan-ng/helm/switch';
import { BranchNames } from '../../../core/branch-prefs';
import type { BranchFormat } from '../../../core/branch-name';
import { UiStore } from '../../../core/stores/ui.store';
import { ThemeService, type ThemeMode } from '../../../core/theme/theme.service';
import { Kbd } from '../../../shared/kbd';
import { SECTION_KIT } from './section-kit';

/**
 * Fixed preview palettes. These illustrate each theme regardless of the one currently applied
 * (the live tokens can only describe the active theme), so they are literal values on purpose.
 */
const PREVIEW = {
  light: { chrome: '#f4f4f5', panel: '#ffffff', line: '#e4e4e7', text: '#d4d4d8', strong: '#a1a1aa', accent: '#b5583a' },
  dark: { chrome: '#08090a', panel: '#141518', line: '#26272b', text: '#3a3b40', strong: '#5c5e66', accent: '#d0714f' },
} as const;

const THEMES: { id: ThemeMode; label: string; hint: string }[] = [
  { id: 'system', label: 'System', hint: 'Follows this device' },
  { id: 'light', label: 'Light', hint: 'Bright surfaces' },
  { id: 'dark', label: 'Dark', hint: 'Low-light, high focus' },
];

const BRANCH_FORMATS: { id: BranchFormat; label: string }[] = [
  { id: 'user/key-title', label: 'Your name, key and title' },
  { id: 'key-title', label: 'Key and title' },
  { id: 'feature/key-title', label: 'Feature prefix, key and title' },
];

@Component({
  selector: 'app-appearance-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet, LucideDynamicIcon, HlmSwitchImports, Kbd, ...SECTION_KIT],
  host: { class: 'flex flex-col gap-10' },
  template: `
    <div>
      <app-section-header title="Appearance" description="Choose how Trama looks on this device. Stored in this browser only." />

      <app-settings-group title="Interface theme">
        <div class="grid grid-cols-1 gap-3 p-4 sm:grid-cols-3" role="radiogroup" aria-label="Interface theme">
          @for (t of themes; track t.id) {
            <button
              type="button"
              role="radio"
              [attr.aria-checked]="theme.mode() === t.id"
              class="group focus-visible:ring-ring/50 flex flex-col gap-2 rounded-lg text-left outline-none focus-visible:ring-3"
              (click)="theme.set(t.id)"
            >
              <span
                class="relative block aspect-[16/10] overflow-hidden rounded-md border-2 transition-colors"
                [class.border-primary]="theme.mode() === t.id"
                [class.border-transparent]="theme.mode() !== t.id"
              >
                <span class="ring-border absolute inset-0 flex overflow-hidden rounded-[4px] ring-1">
                  @if (t.id === 'system') {
                    <span class="relative block w-1/2 overflow-hidden">
                      <span class="absolute inset-y-0 left-0 w-[200%]">
                        <ng-container *ngTemplateOutlet="mock; context: { $implicit: preview.light }" />
                      </span>
                    </span>
                    <span class="relative block w-1/2 overflow-hidden">
                      <span class="absolute inset-y-0 right-0 w-[200%]">
                        <ng-container *ngTemplateOutlet="mock; context: { $implicit: preview.dark }" />
                      </span>
                    </span>
                  } @else {
                    <span class="relative block w-full">
                      <ng-container *ngTemplateOutlet="mock; context: { $implicit: t.id === 'light' ? preview.light : preview.dark }" />
                    </span>
                  }
                </span>
                @if (theme.mode() === t.id) {
                  <span class="bg-primary text-primary-foreground absolute right-1.5 bottom-1.5 flex size-4 items-center justify-center rounded-full">
                    <svg [lucideIcon]="check" [size]="11" [strokeWidth]="3"></svg>
                  </span>
                }
              </span>
              <span class="px-0.5">
                <span class="block text-[13px] font-medium">{{ t.label }}</span>
                <span class="text-muted-foreground block text-xs">{{ t.hint }}</span>
              </span>
            </button>
          }
        </div>
        <app-settings-row label="Quick toggle" description="Flip between light and dark from anywhere.">
          <app-kbd keys="mod+j" />
        </app-settings-row>
      </app-settings-group>
    </div>

    <app-settings-group title="Layout">
      <app-settings-row label="Collapse sidebar" description="Hide the navigation to give lists and boards the full width.">
        <span class="flex items-center gap-3">
          <app-kbd keys="mod+b" class="max-sm:hidden" />
          <hlm-switch [checked]="ui.sidebarCollapsed()" (checkedChange)="ui.setSidebarCollapsed($event)" aria-label="Collapse sidebar" />
        </span>
      </app-settings-row>
    </app-settings-group>

    <app-settings-group title="Git branch name format" description="Used by “Copy git branch name” on issues and workstreams (⌘⇧G). Stored in this browser only.">
      <div class="flex flex-col gap-2 p-4" role="radiogroup" aria-label="Git branch name format">
        @for (f of branchFormats; track f.id) {
          <button
            type="button"
            role="radio"
            [attr.aria-checked]="branches.format() === f.id"
            class="focus-visible:ring-ring/50 flex items-start gap-3 rounded-lg border p-3 text-left outline-none transition-colors focus-visible:ring-3"
            [class]="branches.format() === f.id ? 'border-primary bg-accent/50' : 'border-border hover:border-border-strong hover:bg-hover'"
            (click)="branches.setFormat(f.id)"
          >
            <span
              class="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border"
              [class]="branches.format() === f.id ? 'bg-primary border-primary text-primary-foreground' : 'border-border-strong'"
              aria-hidden="true"
            >
              @if (branches.format() === f.id) {
                <svg [lucideIcon]="check" [size]="10" [strokeWidth]="3"></svg>
              }
            </span>
            <span class="min-w-0 flex-1">
              <span class="block text-[13px] font-medium">{{ f.label }}</span>
              <code class="text-muted-foreground mt-0.5 block truncate font-mono text-xs">{{ branches.name(sample.key, sample.title, f.id) }}</code>
            </span>
          </button>
        }
      </div>
      <div class="bg-muted/30 flex items-center gap-2 px-4 py-2.5 text-xs">
        <svg [lucideIcon]="branchIcon" [size]="13" class="text-muted-foreground shrink-0"></svg>
        <span class="text-muted-foreground shrink-0">Preview</span>
        <code class="min-w-0 truncate font-mono">{{ branches.name(sample.key, sample.title) }}</code>
      </div>
    </app-settings-group>

    <ng-template #mock let-p>
      <span class="absolute inset-0 flex" [style.background]="p.chrome">
        <span class="flex w-[28%] flex-col gap-1 p-1.5">
          <span class="h-1 w-3/4 rounded-full" [style.background]="p.strong"></span>
          <span class="mt-1 h-1 w-2/3 rounded-full" [style.background]="p.text"></span>
          <span class="h-1 w-1/2 rounded-full" [style.background]="p.text"></span>
          <span class="h-1 w-3/5 rounded-full" [style.background]="p.text"></span>
        </span>
        <span class="my-1 mr-1 flex flex-1 flex-col gap-1 rounded-[3px] border p-1.5" [style.background]="p.panel" [style.border-color]="p.line">
          <span class="h-1.5 w-1/3 rounded-full" [style.background]="p.strong"></span>
          @for (r of rows; track r) {
            <span class="flex items-center gap-1 border-t pt-1" [style.border-color]="p.line">
              <span class="size-1.5 rounded-full" [style.background]="r === 1 ? p.accent : p.strong"></span>
              <span class="h-1 rounded-full" [style.width.%]="40 + r * 9" [style.background]="p.text"></span>
            </span>
          }
        </span>
      </span>
    </ng-template>
  `,
})
export class AppearanceSection {
  protected readonly theme = inject(ThemeService);
  protected readonly ui = inject(UiStore);
  protected readonly themes = THEMES;
  protected readonly preview = PREVIEW;
  protected readonly rows = [1, 2, 3, 4];
  protected readonly check = LucideCheck;
  protected readonly branchIcon = LucideGitBranch;
  protected readonly branches = inject(BranchNames);
  protected readonly branchFormats = BRANCH_FORMATS;
  /** The preview issue; the “you” part comes from the signed-in user. */
  protected readonly sample = { key: 'BUG-142', title: 'Remove deprecated v1 sessions table' };
}
