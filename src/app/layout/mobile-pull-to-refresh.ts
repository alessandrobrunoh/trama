import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  afterNextRender,
  inject,
  signal,
} from '@angular/core';
import { LucideArrowDown, LucideDynamicIcon, LucideRefreshCw } from '@lucide/angular';
import { NablaStore } from '../core/stores/nabla.store';
import { haptic } from '../core/viewport';

const TRIGGER = 72;
const MAX_PULL = 110;

/**
 * Pull-to-refresh for the shell's scrolling area (phones). Pulling down while the content is at its top
 * re-reads the workspace (`NablaStore.refetch`, the same call live-sync uses). Touch only; the page is not
 * moved, only a small indicator follows the finger.
 */
@Component({
  selector: 'app-pull-to-refresh',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideDynamicIcon],
  host: { class: 'ptr md:hidden', role: 'status' },
  template: `
    <div
      class="ptr__bubble"
      [class.ptr__bubble--settling]="!pulling()"
      [style.transform]="'translateY(' + (offset() - 44) + 'px)'"
      [style.opacity]="refreshing() ? 1 : progress()"
      aria-hidden="true"
    >
      @if (refreshing()) {
        <svg [lucideIcon]="spinner" [size]="20" class="ptr__spin"></svg>
      } @else {
        <svg
          [lucideIcon]="arrow"
          [size]="20"
          [style.transform]="'rotate(' + (progress() >= 1 ? 180 : 0) + 'deg)'"
          class="ptr__arrow"
        ></svg>
      }
    </div>
    <span class="sr-only">{{ refreshing() ? 'Refreshing' : '' }}</span>
  `,
})
export class PullToRefresh {
  private readonly store = inject(NablaStore);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly arrow = LucideArrowDown;
  protected readonly spinner = LucideRefreshCw;
  protected readonly offset = signal(0);
  protected readonly pulling = signal(false);
  protected readonly refreshing = signal(false);
  protected progress = () => Math.min(1, this.offset() / TRIGGER);

  constructor() {
    afterNextRender(() => {
      const scroller = document.getElementById('main-content');
      if (!scroller) return;
      let startY = 0;
      let startX = 0;
      let active = false;
      let armed = false;

      const atTop = (from: EventTarget | null): boolean => {
        let el = from instanceof HTMLElement ? from : null;
        while (el && el !== scroller.parentElement) {
          if (el.scrollHeight > el.clientHeight + 1 && el.scrollTop > 0) return false;
          el = el.parentElement;
        }
        return scroller.scrollTop <= 0;
      };

      const start = (e: TouchEvent): void => {
        if (this.refreshing() || e.touches.length !== 1) return;
        if (!atTop(e.target) || (e.target as HTMLElement).closest('[data-no-ptr]')) return;
        startY = e.touches[0].clientY;
        startX = e.touches[0].clientX;
        active = true;
        armed = false;
      };
      const move = (e: TouchEvent): void => {
        if (!active) return;
        const dy = e.touches[0].clientY - startY;
        const dx = e.touches[0].clientX - startX;
        if (!this.pulling()) {
          if (dy < 8 || Math.abs(dx) > dy) {
            if (dy < -4) active = false;
            return;
          }
          this.pulling.set(true);
        }
        const pull = Math.min(MAX_PULL, dy * 0.5);
        this.offset.set(pull);
        if (pull >= TRIGGER && !armed) {
          armed = true;
          haptic('tap');
        } else if (pull < TRIGGER) armed = false;
      };
      const end = (): void => {
        if (!active) return;
        active = false;
        const fire = this.pulling() && this.offset() >= TRIGGER;
        this.pulling.set(false);
        if (!fire) {
          this.offset.set(0);
          return;
        }
        this.refreshing.set(true);
        this.offset.set(52);
        haptic('success');
        void Promise.all([this.store.refetch().catch(() => undefined), new Promise((r) => setTimeout(r, 700))]).then(() => {
          this.refreshing.set(false);
          this.offset.set(0);
        });
      };

      scroller.addEventListener('touchstart', start, { passive: true });
      scroller.addEventListener('touchmove', move, { passive: true });
      scroller.addEventListener('touchend', end, { passive: true });
      scroller.addEventListener('touchcancel', end, { passive: true });
      this.destroyRef.onDestroy(() => {
        scroller.removeEventListener('touchstart', start);
        scroller.removeEventListener('touchmove', move);
        scroller.removeEventListener('touchend', end);
        scroller.removeEventListener('touchcancel', end);
      });
    });
  }
}
