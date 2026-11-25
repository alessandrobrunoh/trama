// The milestones of the Progress tab (v3 "33 · Project · Progress"): one line each with the milestone's own
// burn-up as a sparkline, what is done of its scope, when it is projected to land, and its badge.
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { format } from 'date-fns';
import { TramaStore, type Project } from '../../core';
import { dateOfDay, dayOf, fmtNum, todayDay, usesPoints } from '../milestones/milestone-model';
import { MilestoneInfo } from '../milestones/milestone-stats';
import { buildBurnView, burnBadge, dueText, type BurnTone } from './project-burnup-model';
import { ProjectBurnup } from './project-burnup';

const DIAMOND: Record<BurnTone, string> = {
  ok: 'stroke-status-done',
  warn: 'stroke-status-in-progress',
  late: 'stroke-red',
  idle: 'stroke-faint',
};
const TEXT: Record<BurnTone, string> = {
  ok: 'text-status-done',
  warn: 'text-status-in-progress',
  late: 'text-red',
  idle: 'text-muted-foreground',
};
const FILL: Record<BurnTone, string> = {
  ok: 'bg-status-done/10',
  warn: 'bg-status-in-progress/10',
  late: 'bg-red/10',
  idle: 'bg-muted-foreground/10',
};
const DOT: Record<BurnTone, string> = {
  ok: 'bg-status-done',
  warn: 'bg-status-in-progress',
  late: 'bg-red',
  idle: 'bg-muted-foreground',
};

@Component({
  selector: 'app-project-milestone-rows',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ProjectBurnup],
  host: { class: 'flex flex-col' },
  template: `
    <header class="flex items-center justify-between pb-2.5">
      <h2 class="font-title text-foreground text-lg leading-[22px]">Milestones</h2>
      @if (rows().length) {
        <span class="text-faint font-mono text-[11px]">{{ caption() }}</span>
      }
    </header>
    @for (r of rows(); track r.id) {
      <div class="border-border flex items-center gap-4 border-t py-3" role="group" [attr.aria-label]="r.name">
        <div class="flex min-w-0 flex-1 items-center gap-2.5">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" class="shrink-0" aria-hidden="true">
            <path d="M6 .75 11.25 6 6 11.25.75 6Z" stroke-width="1.5" stroke-linejoin="round" [class]="r.diamond" />
          </svg>
          <div class="flex min-w-0 flex-col gap-0.5">
            <span class="text-foreground truncate text-[13.5px] leading-4 font-medium">{{ r.name }}</span>
            <span class="text-faint font-mono text-[11px] leading-[14px]">{{ r.when }}</span>
          </div>
        </div>
        <app-project-burnup class="max-md:hidden" [project]="project()" [milestone]="r.ms" [mini]="true" />
        <div class="flex w-[150px] shrink-0 flex-col items-end gap-0.5 max-sm:hidden">
          <span class="text-foreground font-mono text-xs leading-4">{{ r.stats }}</span>
          <span class="text-faint font-mono text-[10.5px] leading-[13px]">{{ r.note }}</span>
        </div>
        <div class="flex w-[84px] shrink-0 justify-end">
          <span class="inline-flex items-center gap-1.5 px-2 py-[3px] text-xs leading-4" [class]="r.fill + ' ' + r.text">
            <span class="size-[7px] shrink-0" [class]="r.dot" aria-hidden="true"></span>{{ r.badge }}
          </span>
        </div>
      </div>
    }
    @if (!rows().length) {
      <p class="text-faint border-border border-t py-3 font-mono text-[11px]">
        No milestones yet. Add some on the Overview tab.
      </p>
    }
  `,
})
export class ProjectMilestoneRows {
  private readonly store = inject(TramaStore);
  private readonly info = inject(MilestoneInfo);

  readonly project = input.required<Project>();

  protected readonly rows = computed(() => {
    const p = this.project();
    const list = this.store.milestonesByProject().get(p.id) ?? [];
    const projectIssues = this.store.issuesByProject().get(p.id) ?? [];
    const points = usesPoints(projectIssues, this.store.estimateScale());
    const stats = this.info.stats();
    const states = this.info.states();
    const today = todayDay();
    const startDay = dayOf(p.startDate ?? p.createdAt);
    return list.map((ms, i) => {
      const s = stats.get(ms.id)!;
      const state = states.get(ms.id) ?? 'idle';
      const issues = this.store.issuesByMilestone().get(ms.id) ?? [];
      const target = ms.targetDate ? dayOf(ms.targetDate) : null;
      const view = buildBurnView({ issues, points, startDay, targetDay: target, today, endHint: target, pad: 0 });
      const badge = burnBadge(view.model, 'Shipped', 'Planned');
      const tone: BurnTone = state === 'done' ? 'ok' : state === 'overdue' ? 'late' : badge.tone;
      const label = state === 'done' ? 'Shipped' : state === 'overdue' ? 'Overdue' : badge.label;
      const date = target === null ? null : format(dateOfDay(target), 'MMM d');
      const when =
        state === 'done'
          ? date
            ? `Shipped ${date}`
            : 'Shipped'
          : target === null
            ? 'No target date'
            : view.model.health === 'idle' && state !== 'overdue'
              ? `${date} · planned`
              : `${date} · ${dueText(target - today)}`;
      const earlier = list.slice(0, i).find((m) => !stats.get(m.id)?.complete);
      const threads = issues.filter((x) => !!x.threadUrl).length;
      const note =
        state === 'done'
          ? `${threads} ${threads === 1 ? 'thread' : 'threads'} recorded`
          : view.etaDay !== null
            ? `Projected ${format(dateOfDay(view.etaDay), 'MMM d')}`
            : earlier && view.model.health === 'idle'
              ? `Starts after ${earlier.name.split(' · ')[0]}`
              : !s.issues
                ? 'No tasks'
                : '';
      return {
        id: ms.id,
        ms,
        name: ms.name,
        when,
        stats: !s.issues ? 'No tasks' : s.points ? `${fmtNum(s.completed)} / ${fmtNum(s.scope)} pts` : `${s.doneIssues} / ${s.issues} tasks`,
        note,
        badge: label,
        diamond: DIAMOND[tone],
        text: TEXT[tone],
        fill: FILL[tone],
        dot: DOT[tone],
      };
    });
  });

  protected readonly caption = computed(() => {
    const done = this.rows().filter((r) => r.badge === 'Shipped').length;
    return done ? `${this.rows().length} · ${done} shipped` : String(this.rows().length);
  });
}
