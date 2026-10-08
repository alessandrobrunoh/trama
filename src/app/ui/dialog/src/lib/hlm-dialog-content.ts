import type { BooleanInput } from '@angular/cdk/coercion';
import type { ComponentType } from '@angular/cdk/portal';
import { NgComponentOutlet } from '@angular/common';
import {
  booleanAttribute,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  input,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideX } from '@ng-icons/lucide';
import { BrnDialogRef, injectBrnDialogContext } from '@spartan-ng/brain/dialog';
import { HlmButton } from '@spartan-ng/helm/button';

import { classes } from '@spartan-ng/helm/utils';
import { HlmDialogClose } from './hlm-dialog-close';

type HlmDialogContentContext = {
  $component?: ComponentType<unknown>;
  $dynamicComponentClass?: string;
  $showCloseButton?: boolean;
  $closeLabel?: string;
};

@Component({
  selector: 'hlm-dialog-content',
  imports: [NgComponentOutlet, HlmButton, HlmDialogClose, NgIcon],
  providers: [provideIcons({ lucideX })],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    'data-slot': 'dialog-content',
    '[attr.data-state]': 'state()',
  },
  template: `
    @if (component) {
      <ng-container [ngComponentOutlet]="component" />
    } @else {
      <ng-content />
    }

    <span
      class="sheet-handle"
      aria-hidden="true"
      (pointerdown)="dragStart($event)"
      (pointermove)="dragMove($event)"
      (pointerup)="dragEnd($event)"
      (pointercancel)="dragEnd($event)"
    ></span>

    @if (showCloseButton()) {
      <button hlmBtn variant="ghost" size="icon-sm" class="absolute end-2 top-2" hlmDialogClose>
        <span class="sr-only">{{ closeLabel() }}</span>
        <ng-icon name="lucideX" />
      </button>
    }
  `,
})
export class HlmDialogContent {
  private readonly _dialogRef = inject(BrnDialogRef);
  private readonly _dialogContext = injectBrnDialogContext<HlmDialogContentContext | null>({
    optional: true,
  });

  public readonly showCloseButton = input<boolean, BooleanInput>(
    this._dialogContext?.$showCloseButton ?? true,
    {
      transform: booleanAttribute,
    },
  );
  public readonly closeLabel = input<string>(this._dialogContext?.$closeLabel ?? 'Close');

  public readonly state = computed(() => this._dialogRef?.state() ?? 'closed');

  public readonly component = this._dialogContext?.$component;
  private readonly _dynamicComponentClass = this._dialogContext?.$dynamicComponentClass;

  private readonly _host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private _drag: { id: number; startY: number; startT: number; dy: number } | null = null;

  constructor() {
    this._followVisualViewport();
    classes(() => [
      'bg-popover text-popover-foreground data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 shadow-md grid max-w-[calc(100%-2rem)] gap-4 rounded-xl p-4 text-sm duration-100 sm:max-w-sm relative mx-auto w-full outline-none sm:mx-0',
      this._dynamicComponentClass,
    ]);
  }

  /** Swipe down on the handle (mobile bottom sheet) to dismiss. See `hlm-dialog-content` in styles.css. */
  protected dragStart(ev: PointerEvent): void {
    this._drag = { id: ev.pointerId, startY: ev.clientY, startT: ev.timeStamp, dy: 0 };
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
    this._host.style.transition = 'none';
  }

  protected dragMove(ev: PointerEvent): void {
    const d = this._drag;
    if (!d || d.id !== ev.pointerId) return;
    d.dy = Math.max(0, ev.clientY - d.startY);
    this._host.style.setProperty('--sheet-drag', `${d.dy}px`);
  }

  protected dragEnd(ev: PointerEvent): void {
    const d = this._drag;
    if (!d || d.id !== ev.pointerId) return;
    this._drag = null;
    const fast = d.dy / Math.max(1, ev.timeStamp - d.startT) > 0.5;
    if (d.dy > 96 || (fast && d.dy > 24)) {
      this._host.style.transition = '';
      this._dialogRef?.close();
    } else {
      this._host.style.transition = 'transform 180ms ease-out';
      this._host.style.removeProperty('--sheet-drag');
    }
  }

  /** Keeps the bottom sheet above the on-screen keyboard (iOS does not resize fixed layers). */
  private _followVisualViewport(): void {
    const vv = typeof window === 'undefined' ? undefined : window.visualViewport;
    const container =
      typeof document === 'undefined'
        ? null
        : document.querySelector<HTMLElement>('.cdk-overlay-container');
    if (!vv || !container || !window.matchMedia('(max-width: 639.98px)').matches) return;
    const sync = () => {
      container.style.top = `${vv.offsetTop}px`;
      container.style.height = `${vv.height}px`;
      container.style.bottom = 'auto';
    };
    sync();
    vv.addEventListener('resize', sync);
    vv.addEventListener('scroll', sync);
    inject(DestroyRef).onDestroy(() => {
      vv.removeEventListener('resize', sync);
      vv.removeEventListener('scroll', sync);
      container.style.removeProperty('top');
      container.style.removeProperty('height');
      container.style.removeProperty('bottom');
    });
  }
}
