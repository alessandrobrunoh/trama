// Personal preferences (Settings → Preferences). Stored in this browser only, like the theme.
//
// Display options are applied as attributes on <html> and read by rules in styles.css, so they take
// effect without any component knowing about them. src/index.html applies the same attributes before
// first paint (keep the two in sync).
import { DOCUMENT } from '@angular/common';
import { Injectable, effect, inject, signal } from '@angular/core';
import { oneOf, readJson, writeJson } from './stores/storage';

export const PREFERENCES_STORAGE_KEY = 'trama.preferences.v1';

/** Page opened after signing in and from "/". */
export const HOME_VIEWS = ['overview', 'inbox', 'my-work', 'issues', 'workstreams'] as const;
export type HomeView = (typeof HOME_VIEWS)[number];

export const HOME_VIEW_LABELS: Record<HomeView, string> = {
  overview: 'Overview',
  inbox: 'Inbox',
  'my-work': 'My work',
  issues: 'Issues',
  workstreams: 'Workstreams',
};

/** Key that posts a comment. With `mod-enter`, plain Enter adds a new line. */
export const SEND_KEYS = ['mod-enter', 'enter'] as const;
export type SendKey = (typeof SEND_KEYS)[number];

export const FONT_SIZES = ['small', 'default', 'large', 'xlarge'] as const;
export type FontSize = (typeof FONT_SIZES)[number];

/** Multiplier applied to the root font size (and to the fixed px text sizes, see styles.css). */
export const FONT_SCALE: Record<FontSize, number> = {
  small: 0.9,
  default: 1,
  large: 1.1,
  xlarge: 1.2,
};

/** `system` follows the operating system's "reduce motion" setting. */
export const MOTION_MODES = ['system', 'reduce', 'full'] as const;
export type MotionMode = (typeof MOTION_MODES)[number];

interface Persisted {
  homeView: HomeView;
  sendKey: SendKey;
  fontSize: FontSize;
  pointerCursors: boolean;
  underlineLinks: boolean;
  motion: MotionMode;
  emojiShortcodes: boolean;
}

@Injectable({ providedIn: 'root' })
export class Preferences {
  private readonly document = inject(DOCUMENT);
  private readonly saved = readJson<Persisted>(PREFERENCES_STORAGE_KEY);

  readonly homeView = signal<HomeView>(oneOf(
      // "My Attention" became the Inbox.
      (this.saved?.homeView as string | undefined) === 'attention' ? 'inbox' : this.saved?.homeView,
      HOME_VIEWS,
      'overview',
    ));
  readonly sendKey = signal<SendKey>(oneOf(this.saved?.sendKey, SEND_KEYS, 'mod-enter'));
  readonly fontSize = signal<FontSize>(oneOf(this.saved?.fontSize, FONT_SIZES, 'default'));
  readonly pointerCursors = signal<boolean>(
    typeof this.saved?.pointerCursors === 'boolean' ? this.saved.pointerCursors : true,
  );
  readonly underlineLinks = signal<boolean>(
    typeof this.saved?.underlineLinks === 'boolean' ? this.saved.underlineLinks : false,
  );
  readonly motion = signal<MotionMode>(oneOf(this.saved?.motion, MOTION_MODES, 'system'));
  /** Typing `:skull:` in a comment turns it into 💀. */
  readonly emojiShortcodes = signal<boolean>(
    typeof this.saved?.emojiShortcodes === 'boolean' ? this.saved.emojiShortcodes : false,
  );

  /** True when comments are posted with plain Enter (Shift+Enter inserts a new line). */
  sendsOnEnter(): boolean {
    return this.sendKey() === 'enter';
  }

  constructor() {
    effect(() => {
      const root = this.document.documentElement;
      root.style.setProperty('--font-scale', String(FONT_SCALE[this.fontSize()]));
      root.dataset['fontSize'] = this.fontSize();
      root.dataset['pointerCursors'] = String(this.pointerCursors());
      root.dataset['underlineLinks'] = String(this.underlineLinks());
      root.dataset['motion'] = this.motion();
      writeJson(PREFERENCES_STORAGE_KEY, {
        homeView: this.homeView(),
        sendKey: this.sendKey(),
        fontSize: this.fontSize(),
        pointerCursors: this.pointerCursors(),
        underlineLinks: this.underlineLinks(),
        motion: this.motion(),
        emojiShortcodes: this.emojiShortcodes(),
      } satisfies Persisted);
    });
  }

  /** Back to the defaults. */
  reset(): void {
    this.homeView.set('overview');
    this.sendKey.set('mod-enter');
    this.fontSize.set('default');
    this.pointerCursors.set(true);
    this.underlineLinks.set(false);
    this.motion.set('system');
    this.emojiShortcodes.set(false);
  }
}
