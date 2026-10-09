// Viewport — what kind of screen we are on, shared by the shell and touch-only UI.
//   isMobile      < 768px (the `md` breakpoint): phones, narrow windows
//   coarsePointer the primary pointer is a finger (phones and tablets)
//   keyboardInset height of the on-screen keyboard, from the visual viewport (0 when closed)
//   online        navigator.onLine
// It also mirrors the keyboard into `--kb-inset` and `html[data-keyboard]` so CSS can dock bars above it.
import { DestroyRef, Injectable, inject, signal } from '@angular/core';

const MOBILE_QUERY = '(max-width: 767.98px)';
const COARSE_QUERY = '(pointer: coarse)';
/** Below this the visual viewport shrink is browser chrome (URL bar), not a keyboard. */
const KEYBOARD_MIN_INSET = 120;

@Injectable({ providedIn: 'root' })
export class Viewport {
  readonly isMobile = signal(false);
  readonly coarsePointer = signal(false);
  readonly keyboardInset = signal(0);
  readonly online = signal(true);
  /** Installed PWA (display-mode: standalone, or iOS "Add to Home Screen"). */
  readonly standalone = signal(false);

  constructor() {
    if (typeof window === 'undefined') return;
    const destroyRef = inject(DestroyRef);
    const cleanups: Array<() => void> = [];
    const listen = <T extends EventTarget>(
      target: T,
      type: string,
      handler: EventListener,
      options?: AddEventListenerOptions,
    ): void => {
      target.addEventListener(type, handler, options);
      cleanups.push(() => target.removeEventListener(type, handler, options));
    };

    const mobile = window.matchMedia(MOBILE_QUERY);
    const coarse = window.matchMedia(COARSE_QUERY);
    const standalone = window.matchMedia('(display-mode: standalone)');
    const syncMedia = (): void => {
      this.isMobile.set(mobile.matches);
      this.coarsePointer.set(coarse.matches);
      this.standalone.set(
        standalone.matches || (navigator as Navigator & { standalone?: boolean }).standalone === true,
      );
      document.documentElement.dataset['mobile'] = String(mobile.matches);
    };
    syncMedia();
    listen(mobile, 'change', syncMedia);
    listen(coarse, 'change', syncMedia);
    listen(standalone, 'change', syncMedia);

    // Browser / status bar colour follows the theme the app shows (it can differ from the OS setting).
    const syncThemeColor = (): void => {
      const color = getComputedStyle(document.documentElement).getPropertyValue('--background').trim();
      if (!color) return;
      document
        .querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')
        .forEach((meta) => (meta.content = color));
    };
    syncThemeColor();
    const themeObserver = new MutationObserver(syncThemeColor);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    cleanups.push(() => themeObserver.disconnect());

    this.online.set(navigator.onLine);
    listen(window, 'online', () => this.online.set(true));
    listen(window, 'offline', () => this.online.set(false));

    const vv = window.visualViewport;
    if (vv) {
      const syncKeyboard = (): void => {
        const inset = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
        const open = coarse.matches && inset > KEYBOARD_MIN_INSET;
        const value = open ? inset : 0;
        if (value === this.keyboardInset()) return;
        this.keyboardInset.set(value);
        const root = document.documentElement;
        root.style.setProperty('--kb-inset', `${value}px`);
        if (open) root.dataset['keyboard'] = 'open';
        else delete root.dataset['keyboard'];
      };
      listen(vv, 'resize', syncKeyboard);
      listen(vv, 'scroll', syncKeyboard);
    }

    destroyRef.onDestroy(() => cleanups.forEach((fn) => fn()));
  }
}

/** Light tactile feedback for confirmed gestures (no-op where unsupported or when motion is reduced). */
export function haptic(kind: 'tap' | 'success' | 'warn' = 'tap'): void {
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return;
  const root = document.documentElement;
  if (root.dataset['motion'] === 'reduce') return;
  if (
    root.dataset['motion'] !== 'full' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
    return;
  navigator.vibrate(kind === 'tap' ? 8 : kind === 'success' ? [10, 40, 10] : [18, 30, 18]);
}
