// A project's properties (editable) and its progress: the property column of the project page.
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { TramaStore, type Priority, type ProjectStatus } from '../../core';
import { DatePicker } from '../../shared/date-picker';
import { LabelPicker } from '../../shared/label-picker';
import { Picker } from '../../shared/picker';
import { priorityOptions, userOptions } from '../../shared/picker-options';
import { FullDatePipe, RelativeTimePipe } from '../../shared/pipes';
import { PropertyRow } from '../../shared/property-row';
import { isoFromDate } from '../milestones/milestone-actions';
import { milestoneStats, usesPoints } from '../milestones/milestone-model';
import { isOverdue, projectStatusOptions } from './project-model';

@Component({
  selector: 'app-project-properties',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmInputImports, Picker, LabelPicker, DatePicker, PropertyRow, FullDatePipe, RelativeTimePipe],
  host: { class: 'block min-w-0 text-[13px]' },
  template: `
    @if (project(); as p) {
      <div class="flex flex-col gap-5 px-2 py-3 pb-6">
        <section aria-label="Properties" class="flex flex-col gap-0.5">
          <h3 class="text-muted-foreground px-2 pb-1 text-xs">Properties</h3>
          <app-property-row label="Status">
            <app-picker
              variant="field"
              label="Status"
              [searchable]="false"
              [disabled]="!canManage()"
              [options]="statuses()"
              [value]="[p.status]"
              (valueChange)="setStatus($event[0])"
            />
          </app-property-row>
          <app-property-row label="Priority">
            <app-picker
              variant="field"
              label="Priority"
              [searchable]="false"
              [disabled]="!canManage()"
              [options]="priorities"
              [value]="[p.priority]"
              (valueChange)="setPriority($event[0])"
            />
          </app-property-row>
          <app-property-row label="Lead">
            <app-picker
              variant="field"
              label="Lead"
              placeholder="No lead"
              [clearable]="true"
              clearLabel="Remove lead"
              [disabled]="!canManage()"
              [options]="users()"
              [value]="p.leadId ? [p.leadId] : []"
              (valueChange)="update({ leadId: $event[0] ?? null })"
            />
          </app-property-row>
          <app-property-row label="Labels">
            <app-label-picker
              scope="project"
              [disabled]="!canManage()"
              [value]="p.labels"
              (valueChange)="update({ labels: $event })"
            />
          </app-property-row>
          <app-property-row label="Repository">
            <input
              hlmInput
              class="hover:bg-accent focus-visible:border-input h-8 w-full border-transparent bg-transparent px-1.5 font-mono text-xs shadow-none"
              [value]="p.repository ?? ''"
              [disabled]="!canManage()"
              placeholder="owner/name or URL"
              aria-label="Repository"
              (change)="update({ repository: $any($event.target).value.trim() || null })"
            />
          </app-property-row>
          <app-property-row label="Start date">
            <app-date-picker
              class="min-w-0 flex-1"
              label="Start date"
              triggerClass="h-auto min-h-8 w-full justify-start px-1.5 py-1 text-sm"
              [disabled]="!canManage()"
              [value]="p.startDate"
              (dateChange)="update({ startDate: $event ? iso($event) : null })"
            >
              @if (p.startDate) {
                <span>{{ p.startDate | fullDate }}</span>
              } @else {
                <span class="text-muted-foreground">Not set</span>
              }
            </app-date-picker>
          </app-property-row>
          <app-property-row label="Target date">
            <app-date-picker
              class="min-w-0 flex-1"
              label="Target date"
              triggerClass="h-auto min-h-8 w-full justify-start px-1.5 py-1 text-sm"
              [disabled]="!canManage()"
              [value]="p.targetDate"
              (dateChange)="update({ targetDate: $event ? iso($event) : null })"
            >
              @if (p.targetDate) {
                <span [class.text-status-blocked]="overdue()">{{ p.targetDate | fullDate }}</span>
                @if (overdue()) {
                  <span class="text-status-blocked ml-1.5 text-xs">overdue</span>
                }
              } @else {
                <span class="text-muted-foreground">No date</span>
              }
            </app-date-picker>
          </app-property-row>
          <app-property-row label="Created">
            <span class="text-muted-foreground px-1.5 text-xs">{{ p.createdAt | relativeTime }}</span>
          </app-property-row>
        </section>

        <section aria-label="Progress" class="px-2">
          <h3 class="text-muted-foreground pb-1.5 text-xs">Progress</h3>
          <div class="flex items-center gap-2.5">
            <span class="bg-foreground/10 h-1.5 min-w-0 flex-1 overflow-hidden rounded-full" aria-hidden="true">
              <span
                class="bg-status-done block h-full rounded-full"
                [style.width.%]="progress().percent"
              ></span>
            </span>
            <span class="text-muted-foreground shrink-0 tabular-nums">
              {{ progress().percent }}% · {{ progress().doneIssues }}/{{ progress().issues }} tasks
            </span>
          </div>
        </section>
      </div>
    } @else {
      <p class="text-muted-foreground px-4 py-4">This project is no longer available.</p>
    }
  `,
})
export class ProjectProperties {
  /** Project id. */
  readonly id = input.required<string>();

  private readonly store = inject(TramaStore);

  protected readonly priorities = priorityOptions();
  protected readonly iso = isoFromDate;

  protected readonly project = computed(() => this.store.getProject(this.id()));
  private readonly entries = computed(() => this.store.settings().statuses);
  protected readonly statuses = computed(() => projectStatusOptions(this.entries().project));
  protected readonly users = computed(() => userOptions(this.store));
  protected readonly canManage = computed(() => this.store.allowed('manageProjects'));
  protected readonly overdue = computed(() => {
    const p = this.project();
    return !!p && isOverdue(p);
  });
  private readonly tasks = computed(() => this.store.issuesByProject().get(this.id()) ?? []);
  protected readonly progress = computed(() =>
    milestoneStats(this.tasks(), usesPoints(this.tasks(), this.store.estimateScale())),
  );

  protected update(patch: Parameters<TramaStore['updateProject']>[1]): void {
    const p = this.project();
    if (p) void this.store.updateProject(p.id, patch);
  }

  protected setStatus(v: string | undefined): void {
    if (v) this.update({ status: v as ProjectStatus });
  }

  protected setPriority(v: string | undefined): void {
    if (v) this.update({ priority: v as Priority });
  }
}
