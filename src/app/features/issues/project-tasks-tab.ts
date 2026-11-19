// The Tasks tab of a project page: the very same list/board as the Tasks page (grouping, filters,
// keyboard navigation, row preview, bulk actions), opened with the project filter already applied.
// The project filter is a normal filter chip: removing it widens the list to every task.
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { TramaStore } from '../../core';
import { IssueBoard } from './issue-board';
import { IssueCommandDialog } from './issue-prop';

@Component({
  selector: 'app-project-tasks-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IssueBoard, IssueCommandDialog],
  host: { class: 'flex min-h-0 flex-1 flex-col' },
  template: `
    <app-issue-board
      [issues]="store.issues()"
      [project]="projectId()"
      [stateKey]="stateKey()"
      [createDefaults]="createDefaults()"
      dropPrefix="project-issue-col"
      emptyTitle="No tasks in this project yet"
      emptyDescription="Create a task here or move existing tasks into this project."
    />
    <app-issue-command-dialog />
  `,
})
export class ProjectTasksTab {
  protected readonly store = inject(TramaStore);

  /** The project whose tasks are shown. */
  readonly projectId = input.required<string>();

  /** Filters and search are remembered per project, apart from the Tasks page. */
  protected readonly stateKey = computed(() => `project-tasks.${this.projectId()}`);
  protected readonly createDefaults = computed(() => ({ projectId: this.projectId() }));
}
