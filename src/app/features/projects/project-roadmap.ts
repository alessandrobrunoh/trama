// The roadmap strip of the project page (v3 "08 · Project"): the months as hairline ticks, the elapsed
// part of the line, TODAY, and one square per milestone with its name, date and progress beneath it.
import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { format } from 'date-fns';
import { TramaStore, type Project } from '../../core';
import { V3SectionTitle } from '../../shared/v3';
import { dateOfDay, dayOf, todayDay, type MilestoneState } from '../milestones/milestone-model';
import { MilestoneInfo } from '../milestones/milestone-stats';
import { tasksQuery } from './project-tasks-link';

export interface RoadmapRange {
  /** First day of the first month. */
  from: number;
  /** First day after the last month (exclusive). */
  to: number;
  /** First day of every month in the range. */
  months: number[];
}

/** The whole months that contain `days` (at least one). */
export function roadmapRange(days: readonly number[]): RoadmapRange {
  const lo = dateOfDay(Math.min(...days));
  const hi = dateOfDay(Math.max(...days));
  const first = new Date(lo.getFullYear(), lo.getMonth(), 1);
  const after = new Date(hi.getFullYear(), hi.getMonth() + 1, 1);
  const months: number[] = [];
  for (let d = new Date(first); d < after; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) months.push(dayOf(d));
  return { from: dayOf(first), to: dayOf(after), months };
}

const MARKER: Record<MilestoneState, string> = {
  done: 'bg-status-done',
  active: 'bg-status-in-progress',
  overdue: 'bg-red',
  idle: 'bg-faint',
  empty: 'bg-faint',
};

@Component({
  selector: 'app-project-roadmap',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet, RouterLink, V3SectionTitle],
  host: { class: 'flex flex-col gap-2.5' },
  template: `
    @if (strip(); as s) {
      <v3-section-title title="Roadmap" [caption]="s.caption" />
      <div class="relative h-[104px] w-full" role="img" [attr.aria-label]="s.label">
        @for (m of s.months; track m.day) {
          <span class="bg-border absolute top-[18px] h-[70px] w-px" [style.left.%]="m.at"></span>
          <span class="text-faint absolute top-[18px] ml-1.5 font-mono text-[10px] leading-3" [style.left.%]="m.at">{{ m.label }}</span>
        }
        <span class="bg-secondary absolute top-[52px] left-0 h-0.5 w-full"></span>
        @if (s.today !== null) {
          <span class="bg-muted-foreground absolute top-[52px] left-0 h-0.5" [style.width.%]="s.today"></span>
          <span class="bg-red absolute top-[36px] h-[34px] w-px" [style.left.%]="s.today"></span>
          <span class="text-red absolute top-[36px] ml-[5px] font-mono text-[9.5px] leading-3" [style.left.%]="s.today">TODAY</span>
        }
        @for (m of s.marks; track m.id) {
          <span class="outline-background absolute top-[47px] size-3 outline-2 -outline-offset-1" [class]="m.cls" [style.left.%]="m.at"></span>
          <ng-template #label>
            <span class="text-foreground text-[12.5px] leading-4 whitespace-nowrap">{{ m.name }}</span>
            <span class="text-faint font-mono text-[10px] leading-3 whitespace-nowrap">{{ m.note }}</span>
          </ng-template>
          @if (m.tasks) {
            <a
              class="absolute top-[68px] flex flex-col gap-0.5 outline-none hover:[&>span:last-child]:text-foreground focus-visible:underline"
              [class]="m.flip ? 'items-end text-right' : ''"
              [style.left.%]="m.at"
              [style.transform]="m.flip ? 'translateX(calc(-100% + 12px))' : null"
              [routerLink]="link()"
              [queryParams]="m.query"
            >
              <ng-container *ngTemplateOutlet="label" />
            </a>
          } @else {
            <span
              class="absolute top-[68px] flex flex-col gap-0.5"
              [class]="m.flip ? 'items-end text-right' : ''"
              [style.left.%]="m.at"
              [style.transform]="m.flip ? 'translateX(calc(-100% + 12px))' : null"
            >
              <ng-container *ngTemplateOutlet="label" />
            </span>
          }
        }
      </div>
    }
  `,
})
export class ProjectRoadmap {
  private readonly store = inject(TramaStore);
  private readonly info = inject(MilestoneInfo);

  readonly project = input.required<Project>();

  protected readonly link = computed(() => ['/', this.store.slug() ?? '', 'projects', this.project().id]);

  protected readonly strip = computed(() => {
    const p = this.project();
    const dated = (this.store.milestonesByProject().get(p.id) ?? []).filter((m) => m.targetDate);
    if (!dated.length && !p.targetDate) return null;
    const today = todayDay();
    const days = [today, ...dated.map((m) => dayOf(m.targetDate!))];
    if (p.startDate) days.push(dayOf(p.startDate));
    if (p.targetDate) days.push(dayOf(p.targetDate));
    const r = roadmapRange(days);
    const span = Math.max(1, r.to - r.from);
    const at = (day: number): number => ((day - r.from) / span) * 100;
    const stats = this.info.stats();
    const states = this.info.states();
    const marks = dated.map((m) => {
      const s = stats.get(m.id);
      const state = states.get(m.id) ?? 'idle';
      const when = format(dateOfDay(dayOf(m.targetDate!)), 'MMM d');
      const note =
        state === 'done' ? `${when} · shipped` : s && s.issues > 0 ? `${when} · ${s.doneIssues}/${s.issues}` : `${when} · no tasks`;
      const pos = at(dayOf(m.targetDate!));
      const tasks = !!s && s.issues > 0;
      return {
        id: m.id,
        name: m.name,
        note,
        at: pos,
        cls: MARKER[state],
        flip: pos > 86,
        tasks,
        query: tasksQuery({ milestone: m.id }),
      };
    });
    const first = format(dateOfDay(r.from), 'MMM');
    const last = format(dateOfDay(r.to - 1), 'MMM');
    return {
      caption: first === last ? first : `${first} → ${last}`,
      label: `Roadmap from ${first} to ${last}: ${marks.map((m) => `${m.name} ${m.note}`).join(', ')}`,
      months: r.months.map((day) => ({ day, at: at(day), label: format(dateOfDay(day), 'MMM').toUpperCase() })),
      today: today >= r.from && today < r.to ? at(today) : null,
      marks,
    };
  });
}
