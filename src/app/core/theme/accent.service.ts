import { DOCUMENT } from '@angular/common';
import { Injectable, effect, inject } from '@angular/core';
import { TramaStore } from '../stores/trama.store';

/** CSS variables that carry the accent; styles.css defines their defaults for light and dark. */
const ACCENT_VARS = ['--primary', '--ring', '--chart-1', '--sidebar-primary', '--sidebar-ring'] as const;
const FOREGROUND_VARS = ['--primary-foreground', '--sidebar-primary-foreground'] as const;

/** Readable text on `hex`: white on dark colours, near-black on light ones. */
function onColor(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#1b1c1f' : '#ffffff';
}

/**
 * The workspace icon colour (Settings → Workspace) is also its accent: buttons, focus rings, links and
 * selection all follow it. Without a colour set, the stylesheet's default accent applies.
 */
@Injectable({ providedIn: 'root' })
export class AccentService {
  private readonly style = inject(DOCUMENT).documentElement.style;
  private readonly store = inject(TramaStore);

  constructor() {
    effect(() => {
      const color = this.store.settings().iconColor;
      const valid = !!color && /^#[0-9a-f]{6}$/i.test(color);
      for (const v of ACCENT_VARS) valid ? this.style.setProperty(v, color) : this.style.removeProperty(v);
      for (const v of FOREGROUND_VARS) valid ? this.style.setProperty(v, onColor(color)) : this.style.removeProperty(v);
    });
  }
}
