// The milestone property of the issue page.
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { LucideDiamond } from '@lucide/angular';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import { TramaStore, shortDate, type Issue, type Project } from '../../core';
import { Notifier } from '../../core/notify/notifier';
import { MilestoneActions } from './milestone-actions';
import { PropertyRow } from '../../shared/property-row';
import { Picker, type PickOption } from '../../shared/picker';

/**
 * Issue property: milestones are scoped to the issue's project; picking a second one of the same
 * project replaces the first.
 */
@Component({
  selector: 'app-issue-milestone-prop',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PropertyRow, Picker, HlmTooltip],
  host: { class: 'contents' },
  template: `
    <app-property-row label="Milestone" [icon]="diamond">
      @if (!hasProject()) {
        <span
          class="text-muted-foreground px-1.5 text-[13px]"
          hlmTooltip="Milestones belong to a project. Set the issue's project to pick a milestone."
          >Set a project first</span
        >
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
  private readonly store = inject(TramaStore);
  private readonly actions = inject(MilestoneActions);
  private readonly notify = inject(Notifier);
  readonly issue = input.required<Issue>();
  protected readonly diamond = LucideDiamond;

  protected readonly canEdit = computed(
    () => this.store.canEditTeamWork(this.issue().teamId) && !this.issue().duplicateOfId,
  );
  /** The issue's project is the source of truth for its milestones. */
  private readonly linkedProjects = computed(() => {
    const seen = new Set<string>();
    const out: Project[] = [];
    const add = (project: Project | undefined) => {
      if (project && !seen.has(project.id)) (seen.add(project.id), out.push(project));
    };
    add(this.store.getProject(this.issue().projectId));
    return out;
  });
  protected readonly options = computed<PickOption[]>(() => {
    const out: PickOption[] = [];
    for (const project of this.linkedProjects()) {
      (this.store.milestonesByProject().get(project.id) ?? []).forEach((m, i) =>
        out.push({
          value: m.id,
          label: `${project.name} › M${i + 1} — ${m.name}`,
          hint: m.targetDate ? shortDate(m.targetDate) : undefined,
          search: `${project.name} M${i + 1} ${m.name}`,
        }),
      );
    }
    return out;
  });
  protected readonly hasProject = computed(() => this.linkedProjects().length > 0);
  protected readonly selected = computed(() => {
    const ids = new Set(this.issue().milestoneIds ?? []);
    return this.options()
      .filter((o) => ids.has(o.value))
      .map((o) => o.value);
  });

  /** Creates "Milestone N" in the first linked project that has no milestone for this issue yet, and puts the issue in it. */
  protected async createMilestone(): Promise<void> {
    const issue = this.issue();
    const have = new Set(
      (issue.milestoneIds ?? []).map((id) => this.store.getMilestone(id)?.projectId),
    );
    const projects = this.linkedProjects();
    const project = projects.find((p) => !have.has(p.id)) ?? projects[0];
    if (!project) return;
    const n = (this.store.milestonesByProject().get(project.id) ?? []).length + 1;
    const ms = await this.actions.create(project.id, `Milestone ${n}`);
    if (!ms) return;
    this.actions.assign(this.issue(), project.id, ms.id);
    this.notify.success(`Created “${ms.name}” in ${project.name}`, {
      description: 'Rename it from the project page.',
    });
  }

  protected change(next: string[]): void {
    const issue = this.issue();
    const before = new Set(this.selected());
    const added = next.filter((id) => !before.has(id));
    // keep one per project: a newly picked milestone replaces that project's previous one
    const byProject = new Map<string, string>();
    for (const id of next) {
      const projectId = this.store.getMilestone(id)?.projectId;
      if (projectId && (!byProject.has(projectId) || added.includes(id)))
        byProject.set(projectId, id);
    }
    const kept = (issue.milestoneIds ?? []).filter(
      (id) => !this.options().some((o) => o.value === id),
    );
    const milestoneIds = [...kept, ...byProject.values()];
    const cur = issue.milestoneIds ?? [];
    if (milestoneIds.length === cur.length && milestoneIds.every((id) => cur.includes(id))) return;
    void this.store.updateIssue(issue.id, { milestoneIds });
  }
}
