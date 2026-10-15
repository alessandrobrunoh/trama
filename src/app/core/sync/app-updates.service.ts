// AppUpdates — gets a deployed release onto open clients (installed PWAs above all).
//
// The service worker keeps serving the cached build until it learns about a new one, and a phone app
// that is only resumed, never reloaded, can run an old client against a new API for days. Check on
// resume and every 30 minutes; once the new build is downloaded, offer a reload. A broken cache
// (UNRECOVERABLE_STATE) reloads right away: the app cannot load its lazy chunks anymore.
import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, inject } from '@angular/core';
import { SwUpdate } from '@angular/service-worker';
import { Notifier } from '../notify/notifier';

const CHECK_INTERVAL_MS = 30 * 60_000;

@Injectable({ providedIn: 'root' })
export class AppUpdates {
  private readonly sw = inject(SwUpdate);
  private readonly document = inject(DOCUMENT);
  private readonly notifier = inject(Notifier);
  private offered = false;

  constructor() {
    if (!this.sw.isEnabled) return;

    const sub = this.sw.versionUpdates.subscribe((event) => {
      if (event.type === 'VERSION_READY') this.offerReload();
    });
    const unrecoverable = this.sw.unrecoverable.subscribe(() => this.document.location.reload());

    const check = () => void this.sw.checkForUpdate().catch(() => undefined);
    const onVisible = () => {
      if (this.document.visibilityState === 'visible') check();
    };
    const timer = setInterval(check, CHECK_INTERVAL_MS);
    this.document.addEventListener('visibilitychange', onVisible);
    inject(DestroyRef).onDestroy(() => {
      sub.unsubscribe();
      unrecoverable.unsubscribe();
      clearInterval(timer);
      this.document.removeEventListener('visibilitychange', onVisible);
    });
  }

  private offerReload(): void {
    if (this.offered) return;
    this.offered = true;
    this.notifier.info('A new version of Trama is available', {
      description: 'Reload to update.',
      duration: Infinity,
      action: { label: 'Reload', run: () => this.document.location.reload() },
    });
  }
}
