// The running timer as the header of a task shows it (v3 timer pill, DESIGN.md §4): a red square, the task key, the
// elapsed time and a stop button. Rendered only while the timer runs on that task.
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import { TimeEntriesStore } from '../../core';

@Component({
  selector: 'app-task-timer-pill',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmTooltip],
  host: { class: 'contents' },
  template: `
    @if (running()) {
      <span class="border-red/40 bg-red/12 flex shrink-0 items-center gap-2 border py-0.5 ps-2 pe-1" role="timer" [attr.aria-label]="'Timer running on ' + taskKey() + ', ' + elapsed()">
        <span class="bg-red size-1.5" aria-hidden="true"></span>
        <span class="text-muted-foreground font-mono text-[10.5px] leading-[13px]">{{ taskKey() }}</span>
        <span class="text-foreground font-mono text-[11px] leading-[14px] tabular-nums">{{ elapsed() }}</span>
        <button
          type="button"
          class="bg-red/20 hover:bg-red/35 flex size-[18px] items-center justify-center"
          hlmTooltip="Stop timer"
          aria-label="Stop timer"
          [disabled]="time.busy()"
          (click)="time.stop()"
        >
          <span class="bg-foreground size-[7px]" aria-hidden="true"></span>
        </button>
      </span>
    }
  `,
})
export class TaskTimerPill {
  protected readonly time = inject(TimeEntriesStore);

  readonly issueId = input.required<string>();
  readonly taskKey = input.required<string>();

  private readonly now = signal(Date.now());

  protected readonly running = computed(() => {
    const r = this.time.running();
    return r && r.issueId === this.issueId() ? r : null;
  });
  protected readonly elapsed = computed(() => {
    const r = this.running();
    if (!r) return '';
    const s = Math.max(0, Math.floor((this.now() - Date.parse(r.startedAt)) / 1000));
    const pad = (n: number): string => String(n).padStart(2, '0');
    return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
  });

  constructor() {
    effect((onCleanup) => {
      if (!this.running()) return;
      this.now.set(Date.now());
      const timer = setInterval(() => this.now.set(Date.now()), 1000);
      onCleanup(() => clearInterval(timer));
    });
  }
}
