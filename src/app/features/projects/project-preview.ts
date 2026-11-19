// The project in the right pane. Two modes:
//  - `page` (the project page is open): the project's properties, editable, and its progress. The page
//    body keeps the content (overview, milestones, tasks).
//  - preview (a row selected on a list): name and summary on top, the same properties, then progress,
//    milestones and open tasks, with an "Open" action.
// Rendered by the shell for `RightPaneContent = { kind: 'project'; id }`.
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { Router } from '@angular/router';
import { LucideDynamicIcon, LucideExternalLink } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { TramaStore, type Priority, type ProjectStatus } from '../../core';
import { RightPaneStore } from '../../core/stores/right-pane.store';
import { DatePicker } from '../../shared/date-picker';
import { LabelPicker } from '../../shared/label-picker';
import { Picker } from '../../shared/picker';
import { priorityOptions, userOptions } from '../../shared/picker-options';
import { FullDatePipe, RelativeTimePipe } from '../../shared/pipes';
import { PropertyRow } from '../../shared/property-row';
import { StatusIcon } from '../../shared/status';
import { isoFromDate } from '../milestones/milestone-actions';
import { MilestoneIcon } from '../milestones/milestone-icon';
import { MilestoneInfo } from '../milestones/milestone-stats';
import { milestoneStats, usesPoints } from '../milestones/milestone-model';
import { isClosedIssue } from '../issues/issue-model';
import { ProjectGlyph } from './project-glyph';
import { isOverdue, projectStatusOptions } from './project-model';

const MAX_TASKS = 8;

@Component({
  selector: 'app-project-preview',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    HlmButtonImports,
    HlmInputImports,
    LucideDynamicIcon,
    StatusIcon,
    MilestoneIcon,
    ProjectGlyph,
    Picker,
    LabelPicker,
    DatePicker,
    PropertyRow,
    FullDatePipe,
    RelativeTimePipe,
  ],
  host: { class: 'block min-w-0 text-[13px]' },
  template: `
    @if (project(); as p) {
      <div class="flex flex-col gap-5 px-2 py-3 pb-6">
        @if (!page()) {
          <header class="flex min-w-0 items-start gap-2.5 px-2 pt-1">
            <app-project-glyph [project]="p" [size]="18" class="mt-0.5" />
            <div class="min-w-0 flex-1">
              <h2 class="text-base leading-snug break-words">{{ p.name }}</h2>
              @if (p.summary) {
                <p class="text-muted-foreground mt-0.5 line-clamp-3">{{ p.summary }}</p>
              }
            </div>
            <button hlmBtn variant="ghost" size="sm" class="-mr-1 shrink-0 gap-1.5" (click)="open()">
              <svg [lucideIcon]="openIcon" [size]="13"></svg>Open
            </button>
          </header>
        }

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

        @if (!page()) {
          @if (milestones().length) {
            <section aria-label="Milestones" class="px-2">
              <h3 class="text-muted-foreground pb-1 text-xs">Milestones</h3>
              <ul class="flex flex-col">
                @for (m of milestones(); track m.ms.id) {
                  <li class="flex min-h-8 items-center gap-2">
                    <app-milestone-icon [size]="14" [state]="m.state" [fraction]="m.stats.fraction" />
                    <span class="min-w-0 flex-1 truncate">{{ m.ms.name }}</span>
                    <span class="text-muted-foreground text-xs tabular-nums">{{ m.stats.percent }}%</span>
                  </li>
                }
              </ul>
            </section>
          }

          <section aria-label="Open tasks">
            <h3 class="text-muted-foreground px-2 pb-1 text-xs">
              Open tasks <span class="tabular-nums">{{ openTasks().length }}</span>
            </h3>
            @if (openTasks().length) {
              <ul class="flex flex-col">
                @for (i of shownTasks(); track i.id) {
                  <li>
                    <button
                      type="button"
                      class="hover:bg-hover flex min-h-8 w-full items-center gap-2 rounded-md px-2 text-left"
                      (click)="showTask(i.key)"
                    >
                      <app-status-icon entity="issue" [status]="i.status" />
                      <span class="text-muted-foreground shrink-0 font-mono text-xs">{{ i.key }}</span>
                      <span class="min-w-0 flex-1 truncate">{{ i.title }}</span>
                    </button>
                  </li>
                }
              </ul>
              @if (openTasks().length > shownTasks().length) {
                <button hlmBtn variant="ghost" size="sm" class="text-muted-foreground mt-1" (click)="open()">
                  {{ openTasks().length - shownTasks().length }} more in the project
                </button>
              }
            } @else {
              <p class="text-muted-foreground px-2">Nothing open.</p>
            }
          </section>
        }
      </div>
    } @else {
      <p class="text-muted-foreground px-4 py-4">This project is no longer available.</p>
    }
  `,
})
export class ProjectPreview {
  /** Project id. */
  readonly id = input.required<string>();
  /** The project page is open: properties and progress only, the page shows the rest. */
  readonly page = input(false);

  private readonly store = inject(TramaStore);
  private readonly router = inject(Router);
  private readonly pane = inject(RightPaneStore);
  private readonly info = inject(MilestoneInfo);

  protected readonly openIcon = LucideExternalLink;
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
  protected readonly milestones = computed(() => {
    const stats = this.info.stats();
    const states = this.info.states();
    return (this.store.milestonesByProject().get(this.id()) ?? []).flatMap((ms) => {
      const s = stats.get(ms.id);
      const state = states.get(ms.id);
      return s && state ? [{ ms, stats: s, state }] : [];
    });
  });
  protected readonly openTasks = computed(() =>
    this.tasks().filter((i) => !isClosedIssue(i, this.entries().issue)),
  );
  protected readonly shownTasks = computed(() => this.openTasks().slice(0, MAX_TASKS));

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

  protected open(): void {
    const slug = this.store.slug();
    if (slug) void this.router.navigate(['/', slug, 'projects', this.id()]);
  }

  protected showTask(idOrKey: string): void {
    this.pane.show({ kind: 'task', idOrKey });
  }
}
