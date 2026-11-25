import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { WARP_PATH, WEFT_PATH } from './brand-logo';

/**
 * The Trama mark with explicit strand colours, for the brand page (construction, misuse, small sizes) where
 * the colours must not follow the theme. Weft (amber) sits behind, warp (ink) in front.
 */
@Component({
  selector: 'app-brand-mark',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'inline-block shrink-0 leading-none',
    '[style.width.px]': 'size()',
    '[style.height.px]': 'size()',
    'aria-hidden': 'true',
  },
  template: `
    <svg viewBox="0 0 96 96" preserveAspectRatio="none" class="size-full overflow-visible">
      <path [attr.d]="weftPath" [style.fill]="weft()" [attr.fill-opacity]="weftOpacity()" />
      <path [attr.d]="warpPath" [style.fill]="warp()" [attr.transform]="warpShift()" />
    </svg>
  `,
})
export class BrandMark {
  readonly size = input(96);
  readonly weft = input('#e2a93b');
  readonly warp = input('#dcdde0');
  readonly weftOpacity = input(1);
  /** SVG transform applied to the warp strand only ("Unweave it"). */
  readonly warpShift = input<string | null>(null);
  protected readonly weftPath = WEFT_PATH;
  protected readonly warpPath = WARP_PATH;
}
