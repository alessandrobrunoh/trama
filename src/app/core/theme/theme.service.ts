import { DOCUMENT } from '@angular/common';
import { Injectable, computed, effect, inject, signal } from '@angular/core';

export type ThemeMode = 'light' | 'dark' | 'system';

/** localStorage key; the inline script in index.html reads the same key to avoid a flash. */
export const THEME_STORAGE_KEY = 'trama.theme';

/**
 * Light / dark / system theme.
 *  - `mode`     user preference (persisted)
 *  - `resolved` what is actually applied ('light' | 'dark')
 * Applies the `dark` class (and `color-scheme`) on <html>. In `system` mode it follows
 * `prefers-color-scheme` live. `toggle()` (⌘J) flips the *resolved* theme and pins it.
 * If something else flips `html.dark` (e.g. core's ThemeToggle), the service adopts it.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly document = inject(DOCUMENT);
  private readonly media: MediaQueryList | null =
    typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;

  readonly mode = signal<ThemeMode>(this.read());
  private readonly systemDark = signal(this.media?.matches ?? false);

  readonly resolved = computed<'light' | 'dark'>(() => {
    const m = this.mode();
    return m === 'system' ? (this.systemDark() ? 'dark' : 'light') : m;
  });
  readonly isDark = computed(() => this.resolved() === 'dark');

  constructor() {
    this.media?.addEventListener('change', (e) => this.systemDark.set(e.matches));

    effect(() => {
      const dark = this.isDark();
      const el = this.document.documentElement;
      el.classList.toggle('dark', dark);
      el.style.colorScheme = dark ? 'dark' : 'light';
    });

    effect(() => {
      try {
        localStorage.setItem(THEME_STORAGE_KEY, this.mode());
      } catch {
        /* storage unavailable (private mode) – preference lives for the session only */
      }
    });

    // Adopt external class flips (keeps ThemeToggle-style callers consistent).
    if (typeof MutationObserver !== 'undefined') {
      new MutationObserver(() => {
        const dark = this.document.documentElement.classList.contains('dark');
        if (dark !== this.isDark()) this.mode.set(dark ? 'dark' : 'light');
      }).observe(this.document.documentElement, { attributes: true, attributeFilter: ['class'] });
    }
  }

  set(mode: ThemeMode): void {
    this.mode.set(mode);
  }

  /** ⌘J: flip between light and dark based on what is currently shown. */
  toggle(): void {
    this.mode.set(this.isDark() ? 'light' : 'dark');
  }

  private read(): ThemeMode {
    try {
      const v = localStorage.getItem(THEME_STORAGE_KEY);
      if (v === 'light' || v === 'dark' || v === 'system') return v;
    } catch {
      /* ignore */
    }
    return 'system';
  }
}
