import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import { TimeEntriesStore, TramaStore } from '../../core';
import { DAY, DEFAULT_IDLE_DAYS, activityLookup, isDone, isRunning } from './flow-stats';

/** One line above the task list: what is open, what is moving, what has gone idle, what was finished this week. */
@Component({
  selector: 'app-stats-strip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, HlmTooltip],
  host: { class: 'block' },
  template: `
    @if (figures(); as f) {
      <div class="text-muted-foreground flex flex-wrap items-center gap-x-5 gap-y-1 px-4 py-2 text-xs sm:px-6">
        <span><span class="text-foreground font-medium tabular-nums">{{ f.open }}</span> open</span>
        <span><span class="text-foreground font-medium tabular-nums">{{ f.running }}</span> in progress</span>
        @if (f.idle) {
          <span class="text-status-needs-input" [hlmTooltip]="'No activity for ' + idleDays + ' days'">
            <span class="font-medium tabular-nums">{{ f.idle }}</span> idle
          </span>
        }
        <span><span class="text-foreground font-medium tabular-nums">{{ f.doneWeek }}</span> completed in 7 days</span>
        <a class="hover:text-foreground ms-auto" [routerLink]="['/', store.slug(), 'stats']">Statistics</a>
      </div>
    }
  `,
})
export class StatsStrip {
  protected readonly store = inject(TramaStore);
  private readonly time = inject(TimeEntriesStore);
  protected readonly idleDays = DEFAULT_IDLE_DAYS;

  constructor() {
    void this.time.load();
  }

  protected readonly figures = computed(() => {
    const issues = this.store.issues();
    if (!issues.length) return null;
    const now = Date.now();
    const activityAt = activityLookup({
      events: this.store.eventsBySubject(),
      artifacts: this.store.artifactsByIssue(),
      entries: this.time.entries(),
      now,
    });
    const running = issues.filter(isRunning);
    return {
      open: issues.filter((i) => i.status !== 'done' && i.status !== 'canceled' && i.status !== 'draft').length,
      running: running.length,
      idle: running.filter((i) => now - activityAt(i) >= this.idleDays * DAY).length,
      doneWeek: issues.filter((i) => isDone(i) && now - Date.parse(i.completedAt!) < 7 * DAY).length,
    };
  });
}
