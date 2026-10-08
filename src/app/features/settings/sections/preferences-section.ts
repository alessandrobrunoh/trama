import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmSwitchImports } from '@spartan-ng/helm/switch';
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
import { AppSelect, type Option } from '../../create/form-kit';
import { SECTION_KIT } from './section-kit';

const FONT_LABELS: Record<FontSize, string> = {
  small: 'Small',
  default: 'Default',
  large: 'Large',
  xlarge: 'Extra large',
};
const SEND_LABELS: Record<SendKey, string> = { 'mod-enter': '⌘ / Ctrl + Enter', enter: 'Enter' };
const MOTION_LABELS: Record<MotionMode, string> = {
  system: 'Follow system',
  reduce: 'Reduce',
  full: 'Allow all',
};

/** Personal, per-browser preferences: where to land, how comments are sent, and display options. */
@Component({
  selector: 'app-preferences-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButtonImports, HlmSwitchImports, AppSelect, ...SECTION_KIT],
  host: { class: 'flex flex-col gap-10' },
  template: `
    <div>
      <app-section-header
        title="Preferences"
        description="Personal settings for this browser. They don’t affect anyone else in the workspace."
      >
        <button actions hlmBtn variant="ghost" size="sm" (click)="prefs.reset()">
          Reset to defaults
        </button>
      </app-section-header>

      <app-settings-group title="General">
        <app-settings-row
          label="Default home view"
          description="The page you land on after signing in or opening Trama."
          wide
        >
          <app-select
            size="sm"
            label="Default home view"
            [options]="homeOptions"
            [value]="prefs.homeView()"
            (valueChange)="setHome($event)"
          />
        </app-settings-row>
        <app-settings-row
          label="Send comments with"
          description="With Enter, use Shift + Enter for a new line."
          wide
        >
          <app-select
            size="sm"
            label="Send comments with"
            [options]="sendOptions"
            [value]="prefs.sendKey()"
            (valueChange)="setSendKey($event)"
          />
        </app-settings-row>
      </app-settings-group>
    </div>

    <app-settings-group title="Display">
      <app-settings-row
        label="Font size"
        description="Scales text and spacing across the app."
        wide
      >
        <app-select
          size="sm"
          label="Font size"
          [options]="fontOptions"
          [value]="prefs.fontSize()"
          (valueChange)="setFontSize($event)"
        />
      </app-settings-row>
      <app-settings-row
        label="Use pointer cursors"
        description="Show a hand cursor when hovering over buttons and links."
      >
        <hlm-switch
          [checked]="prefs.pointerCursors()"
          (checkedChange)="prefs.pointerCursors.set($event)"
          aria-label="Use pointer cursors"
        />
      </app-settings-row>
      <app-settings-row
        label="Underline links"
        description="Always underline links in descriptions and comments."
      >
        <hlm-switch
          [checked]="prefs.underlineLinks()"
          (checkedChange)="prefs.underlineLinks.set($event)"
          aria-label="Underline links"
        />
      </app-settings-row>
      <app-settings-row
        label="Animations"
        description="Reduce motion removes transitions and animated effects."
        wide
      >
        <app-select
          size="sm"
          label="Animations"
          [options]="motionOptions"
          [value]="prefs.motion()"
          (valueChange)="setMotion($event)"
        />
      </app-settings-row>
    </app-settings-group>
  `,
})
export class PreferencesSection {
  protected readonly prefs = inject(Preferences);

  protected readonly homeOptions: Option[] = HOME_VIEWS.map((v) => ({
    value: v,
    label: HOME_VIEW_LABELS[v],
  }));
  protected readonly sendOptions: Option[] = SEND_KEYS.map((v) => ({
    value: v,
    label: SEND_LABELS[v],
  }));
  protected readonly fontOptions: Option[] = FONT_SIZES.map((v) => ({
    value: v,
    label: FONT_LABELS[v],
  }));
  protected readonly motionOptions: Option[] = MOTION_MODES.map((v) => ({
    value: v,
    label: MOTION_LABELS[v],
  }));

  protected setHome(value: string): void {
    this.prefs.homeView.set(oneOf(value, HOME_VIEWS, 'overview'));
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
}
