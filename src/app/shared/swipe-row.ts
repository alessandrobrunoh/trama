import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { haptic } from '../core/viewport';

/**
 * Touch row with swipe actions, iOS Mail style.
 *   <app-swipe-row (startCommit)="assignMe()" (endCommit)="done()">
 *     <button swipeStart …>Assign</button>         revealed by swiping right
 *     <button swipeEnd …>Priority</button>          revealed by swiping left (first one commits on a full swipe)
 *     …row content…
 *   </app-swipe-row>
 * Gestures never replace a control: the actions are real buttons in the DOM (reachable with the
 * keyboard and screen readers: focusing one reveals its side) and rows keep their tappable pickers.
 * Vertical panning stays native (`touch-action: pan-y`); the row only claims clearly horizontal drags.
 */
@Component({
  selector: 'app-swipe-row',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'swipe-row',
    '[class.swipe-row--dragging]': 'dragging()',
    '[style.--swipe-x.px]': 'offset()',
    '(focusin)': 'onFocusIn($event)',
    '(focusout)': 'onFocusOut($event)',
  },
  template: `
    <div class="swipe-row__actions swipe-row__actions--start">
      <ng-content select="[swipeStart]" />
    </div>
    <div class="swipe-row__actions swipe-row__actions--end">
      <ng-content select="[swipeEnd]" />
    </div>
    <div
      class="swipe-row__content"
      (pointerdown)="down($event)"
      (pointermove)="move($event)"
      (pointerup)="up($event)"
      (pointercancel)="cancel($event)"
      (keydown.escape)="close()"
    >
      <ng-content />
    </div>
  `,
})
export class SwipeRow {
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef);

  /** Width of the revealed action area per side (px). 0 disables that side. */
  readonly startWidth = input(0);
  readonly endWidth = input(0);
  /** Swiping past this share of the row's width commits the first action of that side. */
  readonly commitAt = input(0.55);
  readonly disabled = input(false);

  readonly startCommit = output<void>();
  readonly endCommit = output<void>();

  protected readonly dragging = signal(false);
  protected readonly offset = signal(0);

  private pointer: { id: number; x: number; y: number; base: number; locked: boolean } | null = null;
  private suppressClick = false;
  private crossed = false;

  protected down(ev: PointerEvent): void {
    if (this.disabled() || ev.pointerType === 'mouse' || !ev.isPrimary) return;
    // Controls inside the row (status picker, avatar…) keep their own taps.
    this.pointer = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, base: this.offset(), locked: false };
    this.crossed = false;
  }

  protected move(ev: PointerEvent): void {
    const p = this.pointer;
    if (!p || p.id !== ev.pointerId) return;
    const dx = ev.clientX - p.x;
    const dy = ev.clientY - p.y;
    if (!p.locked) {
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) {
        this.pointer = null; // a scroll: let it be
        return;
      }
      if (Math.abs(dx) < 12 || Math.abs(dx) < Math.abs(dy) * 1.6) return;
      p.locked = true;
      this.dragging.set(true);
      (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
    }
    const width = this.el.nativeElement.clientWidth;
    let next = p.base + dx;
    const maxStart = this.startWidth() > 0 ? width : 0;
    const maxEnd = this.endWidth() > 0 ? width : 0;
    next = Math.min(maxStart, Math.max(-maxEnd, next));
    // Rubber band past the revealed width.
    const reveal = next > 0 ? this.startWidth() : this.endWidth();
    const abs = Math.abs(next);
    const eased = abs > reveal ? reveal + (abs - reveal) * 0.6 : abs;
    this.offset.set(Math.sign(next) * eased);
    const over = abs / width >= this.commitAt();
    if (over !== this.crossed) {
      this.crossed = over;
      if (over) haptic('tap');
    }
  }

  protected up(ev: PointerEvent): void {
    const p = this.pointer;
    if (!p || p.id !== ev.pointerId) return;
    this.pointer = null;
    if (!p.locked) return;
    this.dragging.set(false);
    this.suppressClick = true; // the lift after a swipe must not open the row
    setTimeout(() => (this.suppressClick = false), 60);
    const width = this.el.nativeElement.clientWidth;
    const x = this.offset();
    if (x > 0 && Math.abs(x) / width >= this.commitAt() * 0.9) return this.commit('start');
    if (x < 0 && Math.abs(x) / width >= this.commitAt() * 0.9) return this.commit('end');
    if (x > this.startWidth() * 0.45) this.offset.set(this.startWidth());
    else if (x < -this.endWidth() * 0.45) this.offset.set(-this.endWidth());
    else this.offset.set(0);
  }

  protected cancel(ev: PointerEvent): void {
    if (this.pointer?.id !== ev.pointerId) return;
    this.pointer = null;
    this.dragging.set(false);
    this.offset.set(0);
  }

  private commit(side: 'start' | 'end'): void {
    haptic('success');
    this.offset.set(0);
    if (side === 'start') this.startCommit.emit();
    else this.endCommit.emit();
  }

  constructor() {
    // A tap on an open row (or the lift that ends a swipe) closes it instead of following the link underneath.
    // Capture phase, so it runs before the row's own click handlers.
    const host = this.el.nativeElement;
    const onClick = (ev: MouseEvent): void => {
      if ((ev.target as HTMLElement).closest('.swipe-row__actions')) return;
      if (this.suppressClick || this.offset() !== 0) {
        ev.preventDefault();
        ev.stopPropagation();
        this.offset.set(0);
      }
    };
    host.addEventListener('click', onClick, { capture: true });
    inject(DestroyRef).onDestroy(() => host.removeEventListener('click', onClick, true));
  }

  close(): void {
    this.offset.set(0);
  }

  // Keyboard / screen reader: focusing an action reveals its side.
  protected onFocusIn(ev: FocusEvent): void {
    const t = ev.target as HTMLElement;
    if (t.closest('.swipe-row__actions--start')) this.offset.set(this.startWidth());
    else if (t.closest('.swipe-row__actions--end')) this.offset.set(-this.endWidth());
  }

  protected onFocusOut(ev: FocusEvent): void {
    const next = ev.relatedTarget as HTMLElement | null;
    if (!next || !this.el.nativeElement.contains(next)) this.offset.set(0);
  }
}
