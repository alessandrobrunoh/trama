import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { formatSpan } from '../../../core/format';
import { TimeEntriesStore } from '../../../core/stores/time-entries.store';
import { TramaStore } from '../../../core/stores/trama.store';
import { SECTION_KIT } from './section-kit';

/**
 * Settings · Time tracking (v3 frame 26). Trama has no per-workspace timer options yet (rounding, idle
 * detection, billable rates, suggestions from Delta threads), so this page shows what is real: the timer and
 * the entries of the signed-in person, and the two workspace settings the timesheet follows (week start,
 * time zone), which are edited in General.
 */
@Component({
  selector: 'app-time-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, HlmButtonImports, ...SECTION_KIT],
  host: { class: 'flex flex-col' },
  template: `
    <app-section-header
      title="Time tracking"
      description="Time is always logged by people. The timer runs on one task at a time, and an entry belongs to whoever logged it."
    />

    <div class="grid grid-cols-1 gap-x-10 gap-y-6 lg:grid-cols-2">
      <app-settings-section title="Timer" caption="this account">
        <div class="flex flex-col gap-3 pt-3">
          <div class="flex items-center gap-2.5">
            <span class="text-foreground text-[13px]">Running now</span>
            <span class="flex-1"></span>
            @if (timers.running()) {
              <span class="border-border text-foreground inline-flex items-center gap-2 border px-2.5 py-1 font-mono text-[11.5px]">
                <span class="bg-red size-1.5" aria-hidden="true"></span>
                {{ runningKey() ?? 'a timer' }}
              </span>
            } @else {
              <span class="border-border text-faint border px-2.5 py-1 font-mono text-[11.5px]">no timer</span>
            }
          </div>
          <div class="flex items-center gap-2.5">
            <span class="text-foreground text-[13px]">Entries logged</span>
            <span class="flex-1"></span>
            <span class="border-border text-foreground border px-2.5 py-1 font-mono text-[11.5px]">{{ finished().length }}</span>
          </div>
          <div class="flex items-center gap-2.5">
            <span class="text-foreground text-[13px]">Time logged in total</span>
            <span class="flex-1"></span>
            <span class="border-border text-foreground border px-2.5 py-1 font-mono text-[11.5px]">{{ total() }}</span>
          </div>
        </div>
      </app-settings-section>

      <app-settings-section title="Timesheet" caption="follows the workspace">
        <div class="flex flex-col gap-3 pt-3">
          <div class="flex items-center gap-2.5">
            <span class="text-foreground text-[13px]">Week starts on</span>
            <span class="flex-1"></span>
            <span class="border-border text-foreground border px-2.5 py-1 font-mono text-[11.5px]">{{ weekStart() }}</span>
          </div>
          <div class="flex items-center gap-2.5">
            <span class="text-foreground text-[13px]">Time zone</span>
            <span class="flex-1"></span>
            <span class="border-border text-foreground border px-2.5 py-1 font-mono text-[11.5px]">{{ timeZone() }}</span>
          </div>
          <div class="flex items-center gap-2.5">
            <span class="text-faint text-[12px]">Both are workspace settings.</span>
            <span class="flex-1"></span>
            <a hlmBtn variant="outline" [routerLink]="['/', store.slug(), 'settings', 'workspace']">Change in General</a>
          </div>
        </div>
      </app-settings-section>
    </div>
  `,
})
export class TimeSection {
  protected readonly store = inject(TramaStore);
  protected readonly timers = inject(TimeEntriesStore);

  protected readonly runningKey = computed(() => {
    const id = this.timers.running()?.issueId;
    return id ? (this.store.getIssue(id)?.key ?? null) : null;
  });
  protected readonly finished = computed(() => this.timers.entries().filter((e) => !!e.endedAt));
  protected readonly total = computed(() => {
    const ms = this.finished().reduce((sum, e) => sum + (Date.parse(e.endedAt ?? e.startedAt) - Date.parse(e.startedAt)), 0);
    return this.finished().length ? formatSpan(ms) : '—';
  });
  protected readonly weekStart = computed(() => {
    const w = this.store.settings().weekStart;
    return w.charAt(0).toUpperCase() + w.slice(1);
  });
  protected readonly timeZone = computed(() => this.store.settings().timeZone);

  constructor() {
    void this.timers.load();
  }
}
