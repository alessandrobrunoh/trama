// The Trama loader: the two strands of the mark slide into the interlocked position and back out,
// one ~1.2s loop. With reduced motion the mark stays put and pulses gently instead.
import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { STRAND_A_PATH, STRAND_B_PATH } from './trama-logo';

@Component({
  selector: 'app-trama-loader',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'inline-flex flex-col items-center gap-3',
    role: 'status',
    'aria-live': 'polite',
    '[attr.aria-label]': 'caption() || label()',
  },
  template: `
    <svg
      class="trama-loader"
      viewBox="0 0 100 100"
      [attr.width]="size()"
      [attr.height]="size()"
      aria-hidden="true"
    >
      <path class="strand strand-a" [attr.d]="strandA" fill="var(--brand)" />
      <path class="strand strand-b" [attr.d]="strandB" fill="var(--foreground)" />
    </svg>
    @if (caption(); as text) {
      <span class="text-faint font-mono text-[10.5px] leading-none" aria-hidden="true">{{ text }}</span>
    }
  `,
  styles: `
    :host {
      color: var(--foreground);
    }
    .trama-loader {
      overflow: visible;
      display: block;
    }
    .strand {
      animation-duration: 1.2s;
      animation-timing-function: cubic-bezier(0.65, 0, 0.35, 1);
      animation-iteration-count: infinite;
    }
    .strand-a {
      animation-name: trama-strand-a;
    }
    .strand-b {
      animation-name: trama-strand-b;
    }
    @keyframes trama-strand-a {
      0%,
      100% {
        transform: translate(-16px, -16px);
      }
      40%,
      62% {
        transform: translate(0, 0);
      }
    }
    @keyframes trama-strand-b {
      0%,
      100% {
        transform: translate(16px, 16px);
      }
      40%,
      62% {
        transform: translate(0, 0);
      }
    }
    @keyframes trama-pulse {
      0%,
      100% {
        opacity: 0.4;
      }
      50% {
        opacity: 1;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .strand {
        animation: none;
      }
      .trama-loader {
        animation: trama-pulse 1.8s ease-in-out infinite;
      }
    }
  `,
})
export class TramaLoader {
  /** Edge of the mark in px. */
  readonly size = input(40);
  /** Optional mono caption under the mark ("Loading workspace…"). */
  readonly caption = input<string>();
  /** Spoken label when there is no caption. */
  readonly label = input('Loading');

  protected readonly strandA = STRAND_A_PATH;
  protected readonly strandB = STRAND_B_PATH;
}
