// Compact progress ring for an issue group, independent of any parent resource.
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';

@Component({
  selector: 'app-issue-progress',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmTooltip],
  host: { class: 'inline-flex items-center' },
  template: `
    <span class="inline-flex items-center gap-1.5 text-xs whitespace-nowrap tabular-nums" [hlmTooltip]="tip()" position="bottom">
      @if (total() > 0) {
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="6" stroke="var(--border-strong)" stroke-width="2" />
          @if (active() > 0) {
            <circle cx="8" cy="8" r="6" stroke="var(--status-in-progress)" stroke-opacity="0.45" stroke-width="2"
              [attr.stroke-dasharray]="arc(done() + active()) + ' 40'" transform="rotate(-90 8 8)" />
          }
          @if (done() > 0) {
            <circle cx="8" cy="8" r="6" stroke="var(--status-done)" stroke-width="2" stroke-linecap="round"
              [attr.stroke-dasharray]="arc(done()) + ' 40'" transform="rotate(-90 8 8)" />
          }
        </svg>
        <span [class.text-muted-foreground]="done() < total()">{{ done() }}/{{ total() }}</span>
        @if (!compact()) {
          <span class="text-muted-foreground">issues</span>
        }
      } @else if (!compact()) {
        <span class="text-muted-foreground/60">No issues</span>
      }
    </span>
  `,
})
export class IssueProgress {
  readonly done = input(0);
  readonly active = input(0);
  readonly total = input(0);
  readonly compact = input(false);
  private readonly circumference = 2 * Math.PI * 6;

  protected arc(count: number): string {
    return ((Math.min(count, this.total()) / Math.max(1, this.total())) * this.circumference).toFixed(2);
  }

  protected readonly tip = computed(() =>
    this.total()
      ? `${this.done()} of ${this.total()} issues done${this.active() ? `, ${this.active()} in progress` : ''}`
      : 'No issues',
  );
}
