// The Trama mark (v3 "Woven T"): two square strands, one in the text colour and one in the accent.
import { ChangeDetectionStrategy, Component, input } from '@angular/core';

@Component({
  selector: 'app-trama-logo',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'inline-flex shrink-0', '[style.width.px]': 'size()', '[style.height.px]': 'size()' },
  template: `
    <svg viewBox="-9.5 -9.5 119 119" [attr.width]="size()" [attr.height]="size()" aria-hidden="true">
      <path d="M0 0h70v16h-54v54h-16z" class="fill-foreground" />
      <path d="M84 30h16v70h-70v-16h54z" class="fill-primary" />
    </svg>
  `,
})
export class TramaLogo {
  /** Edge in px (the design ships 16, 20, 24, 28, 32, 48, 72, 128). */
  readonly size = input(24);
}
