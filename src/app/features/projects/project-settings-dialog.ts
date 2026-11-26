// "Project settings" (⇧P): the project's properties in a dialog, so the page itself keeps Pen's rail
// (about, thread coverage, recent records). Mount `<app-project-settings-dialog [project]="p" [(open)]="open" />`.
import { ChangeDetectionStrategy, Component, computed, inject, input, model } from '@angular/core';
import { LucideDynamicIcon, LucideTrash2 } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { TramaStore, type Priority, type Project, type ProjectStatus } from '../../core';
import { DatePicker } from '../../shared/date-picker';
import { LabelPicker } from '../../shared/label-picker';
import { Picker } from '../../shared/picker';
import { priorityOptions } from '../../shared/picker-options';
import { FullDatePipe } from '../../shared/pipes';
import { PropertyRow } from '../../shared/property-row';
import { V3DialogFoot, V3DialogHead } from '../../shared/v3';
import { MilestoneActions, isoFromDate } from '../milestones/milestone-actions';
import { isOverdue, projectStatusOptions } from './project-model';

@Component({
  selector: 'app-project-settings-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    HlmDialogImports,
    HlmButtonImports,
    HlmInputImports,
    DatePicker,
    FullDatePipe,
    LabelPicker,
    LucideDynamicIcon,
    Picker,
    PropertyRow,
    V3DialogHead,
    V3DialogFoot,
  ],
  template: `
    <hlm-dialog [state]="open() ? 'open' : 'closed'" (closed)="open.set(false)">
      <hlm-dialog-content
        *hlmDialogPortal="let ctx"
        class="max-h-[92svh] gap-0 overflow-y-auto p-0 sm:max-w-[520px]"
        [showCloseButton]="false"
      >
        <v3-dialog-head kicker="PROJECT" (dismiss)="open.set(false)">
          <h2 hlmDialogTitle>Project settings</h2>
        </v3-dialog-head>
        <p hlmDialogDescription class="sr-only">Status, priority, labels, repository, dates and milestones of the project.</p>

        <div id="project-properties" class="flex flex-col gap-0.5 px-3 py-4 text-[13px]">
          <app-property-row label="Status">
            <app-picker
              variant="field"
              label="Status"
              [searchable]="false"
              [disabled]="!canManage()"
              [options]="statuses()"
              [value]="[project().status]"
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
              [value]="[project().priority]"
              (valueChange)="setPriority($event[0])"
            />
          </app-property-row>
          <app-property-row label="Labels">
            <app-label-picker
              scope="project"
              [disabled]="!canManage()"
              [value]="project().labels"
              (valueChange)="update({ labels: $event })"
            />
          </app-property-row>
          <app-property-row label="Repository">
            <input
              hlmInput
              class="hover:bg-accent focus-visible:border-input h-8 w-full border-transparent bg-transparent px-1.5 font-mono text-xs shadow-none"
              [value]="project().repository ?? ''"
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
              [value]="project().startDate"
              (dateChange)="update({ startDate: $event ? iso($event) : null })"
            >
              @if (project().startDate) {
                <span>{{ project().startDate | fullDate }}</span>
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
              [value]="project().targetDate"
              (dateChange)="update({ targetDate: $event ? iso($event) : null })"
            >
              @if (project().targetDate) {
                <span [class.text-status-blocked]="overdue()">{{ project().targetDate | fullDate }}</span>
                @if (overdue()) {
                  <span class="text-status-blocked ml-1.5 text-xs">overdue</span>
                }
              } @else {
                <span class="text-muted-foreground">No date</span>
              }
            </app-date-picker>
          </app-property-row>
        </div>

        <section aria-label="Milestones" class="border-border flex flex-col gap-1 border-t px-3 py-4 text-[13px]">
          <h3 class="text-foreground px-1.5 pb-1 font-mono text-[10px] leading-3 uppercase">Milestones</h3>
          @for (m of milestones(); track m.id; let i = $index) {
            <div class="flex min-w-0 items-center gap-2">
              <span class="text-faint w-7 shrink-0 px-1.5 font-mono text-[10.5px]">M{{ i + 1 }}</span>
              <input
                hlmInput
                class="hover:bg-accent focus-visible:border-input h-8 min-w-0 flex-1 border-transparent bg-transparent px-1.5 text-sm shadow-none"
                [value]="m.name"
                [disabled]="!canManage()"
                [attr.aria-label]="'Name of milestone ' + (i + 1)"
                (change)="milestoneActions.rename(m, $any($event.target).value)"
              />
              <app-date-picker
                class="shrink-0"
                [label]="'Target date of ' + m.name"
                triggerClass="h-8 justify-start px-1.5 text-xs"
                [disabled]="!canManage()"
                [value]="m.targetDate"
                (dateChange)="milestoneActions.setDate(m, $event)"
              >
                @if (m.targetDate) {
                  <span>{{ m.targetDate | fullDate }}</span>
                } @else {
                  <span class="text-muted-foreground">No date</span>
                }
              </app-date-picker>
              @if (canManage()) {
                <button
                  hlmBtn
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  class="text-faint hover:text-foreground shrink-0"
                  [attr.aria-label]="'Delete milestone ' + m.name"
                  (click)="milestoneActions.remove(m)"
                >
                  <svg [lucideIcon]="trashIcon" [size]="14"></svg>
                </button>
              }
            </div>
          } @empty {
            <p class="text-muted-foreground px-1.5 text-xs leading-4">No milestones yet.</p>
          }
          @if (canManage()) {
            <form class="flex items-center gap-2 pt-1" (submit)="$event.preventDefault(); addMilestone(newName)">
              <input
                #newName
                hlmInput
                class="h-8 min-w-0 flex-1 px-1.5 text-sm"
                placeholder="New milestone"
                aria-label="New milestone name"
              />
              <button hlmBtn type="submit" variant="outline" size="sm">Add</button>
            </form>
          }
        </section>

        <v3-dialog-foot>
          <button hlmBtn type="button" variant="outline" (click)="open.set(false)">Close</button>
        </v3-dialog-foot>
      </hlm-dialog-content>
    </hlm-dialog>
  `,
})
export class ProjectSettingsDialog {
  private readonly store = inject(TramaStore);
  protected readonly milestoneActions = inject(MilestoneActions);
  protected readonly trashIcon = LucideTrash2;

  readonly project = input.required<Project>();
  readonly open = model(false);

  protected readonly priorities = priorityOptions();
  protected readonly iso = isoFromDate;
  protected readonly statuses = computed(() => projectStatusOptions(this.store.settings().statuses.project));
  protected readonly canManage = computed(() => this.store.allowed('manageProjects'));
  protected readonly overdue = computed(() => isOverdue(this.project()));

  protected update(patch: Parameters<TramaStore['updateProject']>[1]): void {
    void this.store.updateProject(this.project().id, patch);
  }

  protected readonly milestones = computed(
    () => this.store.milestonesByProject().get(this.project().id) ?? [],
  );

  protected async addMilestone(field: HTMLInputElement): Promise<void> {
    const created = await this.milestoneActions.create(this.project().id, field.value);
    if (created) field.value = '';
  }

  protected setStatus(v: string | undefined): void {
    if (v) this.update({ status: v as ProjectStatus });
  }

  protected setPriority(v: string | undefined): void {
    if (v) this.update({ priority: v as Priority });
  }
}
