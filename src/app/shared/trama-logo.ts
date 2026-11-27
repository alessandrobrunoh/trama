// The Trama mark: two interlocking square strands, one amber (always, whatever the accent) and one in the text colour.
import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/** Strand A (amber): the bracket in the top-left corner. */
export const STRAND_A_PATH = 'M4 4h60v11h-60z m0 0h11v60h-11z m49 0h11v60h-11z m-49 49h26v11h-26z';
/** Strand B (foreground): the bracket in the bottom-right corner. */
export const STRAND_B_PATH = 'M36 36h11v60h-11z m0 49h60v11h-60z m49-49h11v60h-11z m-15 0h26v11h-26z';

@Component({
  selector: 'app-trama-logo',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'inline-flex shrink-0', '[style.width.px]': 'size()', '[style.height.px]': 'size()' },
  template: `
    <svg viewBox="0 0 100 100" [attr.width]="size()" [attr.height]="size()" aria-hidden="true">
      <path [attr.d]="strandA" class="fill-brand" />
      <path [attr.d]="strandB" class="fill-foreground" />
    </svg>
  `,
})
export class TramaLogo {
  /** Edge in px (the design ships 16, 20, 24, 28, 32, 48, 72, 128). */
  readonly size = input(24);
  protected readonly strandA = STRAND_A_PATH;
  protected readonly strandB = STRAND_B_PATH;
}
