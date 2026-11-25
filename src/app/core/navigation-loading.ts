import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import {
  NavigationCancel,
  NavigationEnd,
  NavigationError,
  NavigationSkipped,
  NavigationStart,
  Router,
} from '@angular/router';

/** A navigation faster than this never shows the loader, so quick page switches do not flash. */
export const NAVIGATION_LOADER_DELAY_MS = 150;

/**
 * Whether the router is busy with a navigation that is taking noticeable time (lazy chunk, guards
 * waiting on the workspace snapshot). `pending` turns true only after `NAVIGATION_LOADER_DELAY_MS`.
 * `shellMounted` is set by `AppShell`: before it exists the root shows a full-screen loader, afterwards
 * the shell shows it inside the content pane.
 */
@Injectable({ providedIn: 'root' })
export class NavigationLoading {
  private readonly _pending = signal(false);
  readonly pending = this._pending.asReadonly();
  readonly shellMounted = signal(false);

  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    const router = inject(Router);
    const sub = router.events.subscribe((e) => {
      if (e instanceof NavigationStart) this.start();
      else if (
        e instanceof NavigationEnd ||
        e instanceof NavigationCancel ||
        e instanceof NavigationError ||
        e instanceof NavigationSkipped
      ) {
        this.stop();
      }
    });
    inject(DestroyRef).onDestroy(() => {
      sub.unsubscribe();
      this.stop();
    });
  }

  private start(): void {
    // A redirect starts a new navigation before the old one ends: keep the clock of the first one.
    if (this.timer !== undefined || this._pending()) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this._pending.set(true);
    }, NAVIGATION_LOADER_DELAY_MS);
  }

  private stop(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this._pending.set(false);
  }
}
