import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { MilestoneState } from './milestone-model';

const DIAMOND = '8,1.4 14.6,8 8,14.6 1.4,8';

/**
 * Milestone glyph: a diamond that fills from the bottom with progress (the diamond is to a
 * milestone what the hexagon is to a workstream). Solid with a check when done, red outline when
 * overdue and incomplete.
 */
@Component({
  selector: 'app-milestone-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'inline-flex shrink-0',
    '[class]': 'color()',
    '[style.color]': 'colorStyle()',
  },
  template: `
    <svg [attr.width]="size()" [attr.height]="size()" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      @if (state() === 'done') {
        <polygon [attr.points]="diamond" fill="currentColor" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
        <path d="M5.4 8.2 7.2 10l3.5-3.7" stroke="var(--background)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
      } @else {
        <defs>
          <clipPath [attr.id]="clipId"><polygon [attr.points]="diamond" /></clipPath>
        </defs>
        @if (backdrop()) {
          <polygon [attr.points]="diamond" fill="var(--background)" />
        }
        @if (fraction() > 0) {
          <rect x="0" width="16" [attr.y]="14.6 - fraction() * 13.2" height="16" [attr.clip-path]="'url(#' + clipId + ')'" fill="currentColor" fill-opacity="0.85" />
        }
        <polygon [attr.points]="diamond" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" [attr.stroke-dasharray]="state() === 'empty' ? '2.2 1.8' : null" />
      }
    </svg>
  `,
})
export class MilestoneIcon {
  readonly fraction = input(0);
  readonly state = input<MilestoneState>('idle');
  readonly size = input(14);
  /** Opaque centre, for icons drawn over other content (timeline bars). */
  readonly backdrop = input(false);

  private static seq = 0;
  protected readonly clipId = `msclip-${++MilestoneIcon.seq}`;
  protected readonly diamond = DIAMOND;
  protected readonly color = computed(() => (this.state() === 'idle' || this.state() === 'empty' ? 'text-muted-foreground' : ''));
  protected readonly colorStyle = computed(() => {
    switch (this.state()) {
      case 'done':
        return 'var(--status-shipped)';
      case 'overdue':
        return 'var(--status-blocked)';
      case 'active':
        return 'var(--entity-workstream)';
      default:
        return null;
    }
  });
}
