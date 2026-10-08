// Small milestone pieces used outside the milestones feature: the "next milestone" chip of a
// workstream row / header, and the milestone property of the issue page.
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { LucideDiamond } from '@lucide/angular';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import { NablaStore, shortDate, type Issue } from '../../core';
import { Notifier } from '../../core/notify/notifier';
import { MilestoneActions } from './milestone-actions';
import { PropertyRow } from '../../shared/property-row';
import { Picker, type PickOption } from '../workstreams/picker';
import { MilestoneIcon } from './milestone-icon';
import { progressLabel } from './milestone-model';
import { MilestoneInfo } from './milestone-stats';

/** "◇ M2 · Sep 11": the first unfinished milestone of a workstream (nothing when it has none). */
@Component({
  selector: 'app-next-milestone',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmTooltip, MilestoneIcon],
  host: { class: 'inline-flex min-w-0' },
  template: `
    @if (next(); as n) {
      <span
        class="text-muted-foreground inline-flex h-5 shrink-0 items-center gap-1 rounded-full border border-border-strong px-1.5 text-[11px] whitespace-nowrap tabular-nums"
        [class.text-status-blocked]="n.state === 'overdue'"
        [hlmTooltip]="tip()"
        position="bottom"
      >
        <app-milestone-icon [fraction]="n.stats.fraction" [state]="n.state" [size]="11" />
        M{{ n.n }}@if (n.ms.targetDate) {
          <span> · {{ date() }}</span>
        }
      </span>
    }
  `,
})
export class NextMilestoneChip {
  private readonly info = inject(MilestoneInfo);
  readonly workstreamId = input.required<string>();
  protected readonly next = computed(() => this.info.nextByWorkstream().get(this.workstreamId()));
  protected readonly date = computed(() => shortDate(this.next()?.ms.targetDate));
  protected readonly tip = computed(() => {
    const n = this.next();
    return n ? `Next milestone: ${n.ms.name} · ${progressLabel(n.stats)}${n.ms.targetDate ? ' · ' + date(n.ms.targetDate) : ''}` : '';
  });
}

const date = (iso: string): string => shortDate(iso);

/**
 * Issue property: one milestone per linked workstream. Options are the milestones of every
 * workstream the issue is in, labelled "AUTH-42 › M2 — Identity Ready"; picking a second one of the
 * same workstream replaces the first.
 */
@Component({
  selector: 'app-issue-milestone-prop',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PropertyRow, Picker, HlmTooltip],
  host: { class: 'contents' },
  template: `
    <app-property-row label="Milestone" [icon]="diamond">
      @if (!hasWorkstream()) {
        <span class="text-muted-foreground px-1.5 text-[13px]" hlmTooltip="Milestones belong to a workstream. Add this issue to one (W) to pick a milestone.">Add to a workstream first</span>
      } @else {
        <app-picker
          variant="field"
          label="Milestone"
          placeholder="No milestone"
          [multiple]="true"
          [searchable]="options().length > 6"
          [disabled]="!canEdit()"
          [options]="options()"
          [value]="selected()"
          [create]="canEdit() ? 'New milestone' : undefined"
          (createClicked)="createMilestone()"
          (valueChange)="change($event)"
        />
      }
    </app-property-row>
  `,
})
export class IssueMilestoneProp {
  private readonly store = inject(NablaStore);
  private readonly actions = inject(MilestoneActions);
  private readonly notify = inject(Notifier);
  readonly issue = input.required<Issue>();
  protected readonly diamond = LucideDiamond;

  protected readonly canEdit = computed(() => this.store.canEditTeamWork(this.issue().teamId) && !this.issue().duplicateOfId);
  protected readonly options = computed<PickOption[]>(() => {
    const out: PickOption[] = [];
    for (const wsId of this.issue().workstreamIds) {
      const ws = this.store.getWorkstream(wsId);
      if (!ws) continue;
      (this.store.milestonesByWorkstream().get(wsId) ?? []).forEach((m, i) =>
        out.push({
          value: m.id,
          label: `${ws.key} › M${i + 1} — ${m.name}`,
          hint: m.targetDate ? shortDate(m.targetDate) : undefined,
          search: `${ws.key} M${i + 1} ${m.name}`,
        }),
      );
    }
    return out;
  });
  protected readonly hasWorkstream = computed(() => this.issue().workstreamIds.length > 0);
  protected readonly selected = computed(() => {
    const ids = new Set(this.issue().milestoneIds ?? []);
    return this.options().filter((o) => ids.has(o.value)).map((o) => o.value);
  });

  /** Creates "Milestone N" in the first linked workstream that has no milestone for this issue yet, and puts the issue in it. */
  protected async createMilestone(): Promise<void> {
    const issue = this.issue();
    const have = new Set((issue.milestoneIds ?? []).map((id) => this.store.getMilestone(id)?.workstreamId));
    const wsId = issue.workstreamIds.find((id) => !have.has(id)) ?? issue.workstreamIds[0];
    const ws = this.store.getWorkstream(wsId);
    if (!ws) return;
    const n = (this.store.milestonesByWorkstream().get(ws.id) ?? []).length + 1;
    const ms = await this.actions.create(ws.id, `Milestone ${n}`);
    if (!ms) return;
    this.actions.assign(this.issue(), ws.id, ms.id);
    this.notify.success(`Created “${ms.name}” in ${ws.key}`, { description: 'Rename it from the workstream page.' });
  }

  protected change(next: string[]): void {
    const issue = this.issue();
    const before = new Set(this.selected());
    const added = next.filter((id) => !before.has(id));
    // keep one per workstream: a newly picked milestone replaces that workstream's previous one
    const byWs = new Map<string, string>();
    for (const id of next) {
      const wsId = this.store.getMilestone(id)?.workstreamId;
      if (wsId && (!byWs.has(wsId) || added.includes(id))) byWs.set(wsId, id);
    }
    const kept = (issue.milestoneIds ?? []).filter((id) => !this.options().some((o) => o.value === id));
    const milestoneIds = [...kept, ...byWs.values()];
    const cur = issue.milestoneIds ?? [];
    if (milestoneIds.length === cur.length && milestoneIds.every((id) => cur.includes(id))) return;
    void this.store.updateIssue(issue.id, { milestoneIds });
  }
}
