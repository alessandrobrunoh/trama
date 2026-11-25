import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { BRANCH_FORMATS, type BranchFormat } from '../../../core/branch-name';
import { BranchNames } from '../../../core/branch-prefs';
import {
  FONT_SIZES,
  HOME_VIEWS,
  HOME_VIEW_LABELS,
  MOTION_MODES,
  Preferences,
  SEND_KEYS,
  type FontSize,
  type MotionMode,
  type SendKey,
} from '../../../core/preferences';
import { oneOf } from '../../../core/stores/storage';
import { UiStore } from '../../../core/stores/ui.store';
import { ThemeService, type ThemeMode } from '../../../core/theme/theme.service';
import { Kbd } from '../../../shared/kbd';
import { AppSelect, type Option } from '../../create/form-kit';
import { SECTION_KIT, type SegmentedOption } from './section-kit';

/**
 * Fixed preview palettes of the theme cards (v4 frame 16). They illustrate each theme regardless of the one
 * currently applied, so they are literal values on purpose.
 */
const PREVIEW = {
  light: { page: '#F6F4F0', side: '#FFFFFF', line: '#E4E0D8', ink: '#1A1916', accent: '#E2A93B' },
  dark: { page: '#121110', side: '#181715', line: '#2A2825', ink: '#ECE8E1', accent: '#E2A93B' },
} as const;

const THEMES: { id: ThemeMode; label: string; hint: string }[] = [
  { id: 'system', label: 'System', hint: 'follows this device' },
  { id: 'light', label: 'Light', hint: '⌘⇧L' },
  { id: 'dark', label: 'Dark', hint: '⌘⇧L' },
];

const FONT_LABELS: Record<FontSize, string> = { small: 'Small', default: 'Default', large: 'Large', xlarge: 'X-large' };
const SEND_LABELS: Record<SendKey, string> = { 'mod-enter': '⌘ / Ctrl + Enter', enter: 'Enter' };
const MOTION_LABELS: Record<MotionMode, string> = { system: 'System', reduce: 'On', full: 'Off' };
const BRANCH_LABELS: Record<BranchFormat, string> = {
  'user/key-title': '{user}/{id}-{title}',
  'key-title': '{id}-{title}',
  'feature/key-title': 'feature/{id}-{title}',
};

/**
 * Settings · Preferences (v4 frame 16, the old Appearance and Preferences pages in one): theme, layout, how
 * you work and accessibility. Personal and per browser, saved as you change them.
 */
@Component({
  selector: 'app-preferences-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet, HlmButtonImports, AppSelect, Kbd, ...SECTION_KIT],
  host: { class: 'flex flex-col gap-9' },
  template: `
    <app-section-header
      flush
      title="Preferences"
      description="How Trama looks and behaves for you. Only you see these; they stay in this browser."
    >
      <button actions hlmBtn variant="ghost" size="sm" (click)="prefs.reset()">Reset to defaults</button>
    </app-section-header>

    <app-settings-block title="Theme">
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-3" role="radiogroup" aria-label="Interface theme">
        @for (t of themes; track t.id) {
          <button
            type="button"
            role="radio"
            [attr.aria-checked]="theme.mode() === t.id"
            class="focus-visible:ring-ring/50 flex flex-col text-left outline-none focus-visible:ring-2"
            [class]="theme.mode() === t.id ? 'outline-primary outline-2 -outline-offset-1' : 'border-border hover:border-border-strong border'"
            (click)="theme.set(t.id)"
          >
            <span class="flex h-24 w-full overflow-hidden">
              @if (t.id === 'system') {
                <span class="flex min-w-0 flex-1 overflow-hidden">
                  <ng-container *ngTemplateOutlet="mini; context: { $implicit: preview.light }" />
                </span>
                <span class="flex min-w-0 flex-1 overflow-hidden">
                  <ng-container *ngTemplateOutlet="mini; context: { $implicit: preview.dark }" />
                </span>
              } @else {
                <span class="flex min-w-0 flex-1 overflow-hidden">
                  <ng-container *ngTemplateOutlet="mini; context: { $implicit: t.id === 'light' ? preview.light : preview.dark }" />
                </span>
              }
            </span>
            <span class="bg-card flex items-center gap-2 px-2.5 py-[9px]">
              <span
                class="bg-background flex size-4 shrink-0 items-center justify-center border"
                [class]="theme.mode() === t.id ? 'border-primary' : 'border-border-strong'"
                aria-hidden="true"
              >
                @if (theme.mode() === t.id) {
                  <span class="bg-primary size-2"></span>
                }
              </span>
              <span class="text-foreground text-[13px]">{{ t.label }}</span>
              <span class="flex-1"></span>
              <span class="text-faint font-mono text-[10.5px]">{{ t.hint }}</span>
            </span>
          </button>
        }
      </div>
    </app-settings-block>

    <app-settings-block title="Layout">
      <app-settings-card>
        <app-card-row label="Font size" description="Scales text and spacing across the app.">
          <app-segmented
            aria-label="Font size"
            [options]="fontOptions"
            [value]="prefs.fontSize()"
            (valueChange)="setFontSize($event)"
          />
        </app-card-row>
        <app-card-row label="Collapse sidebar">
          <app-kbd keys="mod+b" class="max-sm:hidden" />
          <app-switch
            aria-label="Collapse sidebar"
            [checked]="ui.sidebarCollapsed()"
            (checkedChange)="ui.setSidebarCollapsed($event)"
          />
        </app-card-row>
      </app-settings-card>
    </app-settings-block>

    <app-settings-block title="Working">
      <app-settings-card>
        <app-card-row label="Home view" description="What opens when you start Trama.">
          <div class="w-44">
            <app-select
              label="Home view"
              [options]="homeOptions"
              [value]="prefs.homeView()"
              (valueChange)="setHome($event)"
            />
          </div>
        </app-card-row>
        <app-card-row label="Send comments with" description="With Enter, use Shift + Enter for a new line.">
          <app-segmented
            aria-label="Send comments with"
            [options]="sendOptions"
            [value]="prefs.sendKey()"
            (valueChange)="setSendKey($event)"
          />
        </app-card-row>
        <app-card-row label="Convert emoji shortcodes" description="Typing :skull: in a comment turns it into 💀.">
          <app-switch
            aria-label="Convert emoji shortcodes"
            [checked]="prefs.emojiShortcodes()"
            (checkedChange)="prefs.emojiShortcodes.set($event)"
          />
        </app-card-row>
        <app-card-row label="Git branch format" description="Used by Copy branch name on a task. Stored in this browser only.">
          <div class="w-56">
            <app-select
              label="Git branch format"
              [options]="branchOptions"
              [value]="branches.format()"
              (valueChange)="setBranchFormat($event)"
            />
          </div>
        </app-card-row>
        <div class="bg-bg-deep flex items-center gap-6 px-4 py-3">
          <span class="text-foreground flex-1 text-[13.5px]">Preview</span>
          <code class="text-text-2 min-w-0 truncate font-mono text-[12px]">{{ branches.name(sample.key, sample.title) }}</code>
        </div>
      </app-settings-card>
    </app-settings-block>

    <app-settings-block title="Accessibility">
      <app-settings-card>
        <app-card-row label="Reduce motion" description="Turns off transitions and animated charts.">
          <app-segmented
            aria-label="Reduce motion"
            [options]="motionOptions"
            [value]="prefs.motion()"
            (valueChange)="setMotion($event)"
          />
        </app-card-row>
        <app-card-row label="Pointer cursors" description="Show a hand cursor on buttons and links.">
          <app-switch
            aria-label="Pointer cursors"
            [checked]="prefs.pointerCursors()"
            (checkedChange)="prefs.pointerCursors.set($event)"
          />
        </app-card-row>
        <app-card-row label="Underline links" description="In descriptions and comments.">
          <app-switch
            aria-label="Underline links"
            [checked]="prefs.underlineLinks()"
            (checkedChange)="prefs.underlineLinks.set($event)"
          />
        </app-card-row>
      </app-settings-card>
    </app-settings-block>

    <ng-template #mini let-p>
      <span class="flex min-w-0 flex-1" [style.background]="p.page">
        <span
          class="flex w-11 shrink-0 flex-col gap-[5px] border-r p-2"
          [style.background]="p.side"
          [style.border-color]="p.line"
        >
          <span class="h-1 w-5 opacity-60" [style.background]="p.ink"></span>
          <span class="h-1 w-[26px] opacity-30" [style.background]="p.ink"></span>
          <span class="h-1 w-[22px] opacity-30" [style.background]="p.ink"></span>
          <span class="h-1 w-6" [style.background]="p.accent"></span>
        </span>
        <span class="flex min-w-0 flex-1 flex-col gap-1.5 p-2.5">
          <span class="h-1.5 w-[60px] opacity-80" [style.background]="p.ink"></span>
          <span class="h-1 w-full opacity-25" [style.background]="p.ink"></span>
          <span class="h-1 w-full opacity-25" [style.background]="p.ink"></span>
          <span class="h-1 w-[70px] opacity-25" [style.background]="p.ink"></span>
          <span class="h-[9px] w-7" [style.background]="p.accent"></span>
        </span>
      </span>
    </ng-template>
  `,
})
export class PreferencesSection {
  protected readonly theme = inject(ThemeService);
  protected readonly ui = inject(UiStore);
  protected readonly prefs = inject(Preferences);
  protected readonly branches = inject(BranchNames);

  protected readonly themes = THEMES;
  protected readonly preview = PREVIEW;
  /** The preview task; the “you” part comes from the signed-in user. */
  protected readonly sample = { key: 'ACM-142', title: 'Fix login redirect loop' };

  protected readonly homeOptions: Option[] = HOME_VIEWS.map((v) => ({ value: v, label: HOME_VIEW_LABELS[v] }));
  protected readonly sendOptions: SegmentedOption[] = SEND_KEYS.map((v) => ({ value: v, label: SEND_LABELS[v] }));
  protected readonly fontOptions: SegmentedOption[] = FONT_SIZES.map((v) => ({ value: v, label: FONT_LABELS[v] }));
  protected readonly motionOptions: SegmentedOption[] = MOTION_MODES.map((v) => ({ value: v, label: MOTION_LABELS[v] }));
  protected readonly branchOptions: Option[] = BRANCH_FORMATS.map((v) => ({ value: v, label: BRANCH_LABELS[v] }));

  protected setHome(value: string): void {
    this.prefs.homeView.set(oneOf(value, HOME_VIEWS, 'inbox'));
  }
  protected setSendKey(value: string): void {
    this.prefs.sendKey.set(oneOf(value, SEND_KEYS, 'mod-enter'));
  }
  protected setFontSize(value: string): void {
    this.prefs.fontSize.set(oneOf(value, FONT_SIZES, 'default'));
  }
  protected setMotion(value: string): void {
    this.prefs.motion.set(oneOf(value, MOTION_MODES, 'system'));
  }
  protected setBranchFormat(value: string): void {
    this.branches.setFormat(oneOf(value, BRANCH_FORMATS, 'user/key-title'));
  }
}
