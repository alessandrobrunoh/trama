// The rail of the project page (v3 "08 · Project"): ABOUT (lead, members, repo, task counts), THREAD COVERAGE
// (how much of the work in progress has a Delta thread), RECENT RECORDS (the latest tasks with a thread) and,
// below them, the project's editable properties.
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { TramaStore, statusTypeOf, type Priority, type ProjectStatus } from '../../core';
import { ActorAvatar } from '../../shared/actor-avatar';
import { AgoPipe } from '../../shared/ago';
import { DatePicker } from '../../shared/date-picker';
import { LabelPicker } from '../../shared/label-picker';
import { Picker } from '../../shared/picker';
import { priorityOptions, userOptions } from '../../shared/picker-options';
import { FullDatePipe, RelativeTimePipe } from '../../shared/pipes';
import { PropertyRow } from '../../shared/property-row';
import { isClosedIssue } from '../issues/issue-model';
import { isoFromDate } from '../milestones/milestone-actions';
import { isOverdue, projectStatusOptions } from './project-model';
import { tasksQuery } from './project-tasks-link';

const MEMBERS_SHOWN = 6;
const RECORDS_SHOWN = 3;

/** An `https://…` repository is a link; `owner/name` is only text (no host is assumed). */
const repoHref = (repo: string): string | null => (/^https?:\/\//i.test(repo) ? repo : null);
const repoLabel = (repo: string): string => repo.replace(/^https?:\/\/(www\.)?/i, '').replace(/\.git$/, '');

@Component({
  selector: 'app-project-properties',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    HlmInputImports,
    ActorAvatar,
    AgoPipe,
    DatePicker,
    FullDatePipe,
    LabelPicker,
    Picker,
    PropertyRow,
    RelativeTimePipe,
  ],
  host: { class: 'block min-w-0 text-[13px]' },
  template: `
    @if (project(); as p) {
      <section aria-label="About" class="border-border flex flex-col gap-2.5 border-b px-5 py-4">
        <h3 class="text-foreground font-mono text-[10px] leading-3 uppercase">About</h3>
        <div class="flex items-center gap-2.5">
          <span class="text-faint w-20 shrink-0 font-mono text-[10.5px] leading-[13px]">Lead</span>
          <app-picker
            class="min-w-0 flex-1"
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
        </div>
        @if (members().length) {
          <div class="flex items-center gap-2.5">
            <span class="text-faint w-20 shrink-0 font-mono text-[10.5px] leading-[13px]">Members</span>
            <div class="flex min-w-0 flex-wrap items-center gap-2.5">
              @for (id of members().slice(0, membersShown); track id) {
                <app-actor-avatar [actor]="{ type: 'user', id }" [size]="20" />
              }
              @if (members().length > membersShown) {
                <span class="text-faint font-mono text-[10.5px]">+{{ members().length - membersShown }}</span>
              }
            </div>
          </div>
        }
        @if (p.repository) {
          <div class="flex items-center gap-2.5">
            <span class="text-faint w-20 shrink-0 font-mono text-[10.5px] leading-[13px]">Repo</span>
            @if (href(p.repository); as h) {
              <a class="text-foreground min-w-0 truncate font-mono text-[11px] leading-[14px] hover:underline" [href]="h" target="_blank" rel="noopener noreferrer">{{ label(p.repository) }} ↗</a>
            } @else {
              <span class="text-foreground min-w-0 truncate font-mono text-[11px] leading-[14px]">{{ p.repository }}</span>
            }
          </div>
        }
        <div class="flex items-center gap-2.5">
          <span class="text-faint w-20 shrink-0 font-mono text-[10.5px] leading-[13px]">Tasks</span>
          <span class="text-foreground font-mono text-[11px] leading-[14px]">
            <a class="underline-offset-2 hover:underline" [routerLink]="link()" [queryParams]="openTasks">{{ counts().open }} open</a>
            ·
            <a class="underline-offset-2 hover:underline" [routerLink]="link()" [queryParams]="doneTasks">{{ counts().done }} done</a>
          </span>
        </div>
      </section>

      <section aria-label="Thread coverage" class="border-border flex flex-col gap-2.5 border-b px-5 py-4">
        <h3 class="text-foreground font-mono text-[10px] leading-3 uppercase">Thread coverage</h3>
        @if (coverage(); as c) {
          <div class="flex items-end gap-2">
            <span class="font-title text-foreground text-[28px] leading-8">{{ c.percent }}%</span>
            <a class="text-faint hover:text-foreground pb-1 font-mono text-[10.5px] leading-[13px] underline-offset-2 hover:underline" [routerLink]="link()" [queryParams]="inProgressTasks">of in-progress work</a>
          </div>
          <div class="bg-line h-1 w-full" role="img" [attr.aria-label]="c.percent + '% of in-progress tasks have a Delta thread'">
            <div class="bg-delta-line h-1" [style.width.%]="c.percent"></div>
          </div>
          <p class="text-muted-foreground text-xs leading-4">
            @if (c.missing) {
              <a class="hover:text-foreground underline-offset-2 hover:underline" [routerLink]="link()" [queryParams]="inProgressTasks">{{ c.missing }} {{ c.missing === 1 ? 'task' : 'tasks' }} in progress</a>
              {{ c.missing === 1 ? 'has' : 'have' }} no Delta thread yet.
            } @else {
              Every task in progress has a Delta thread.
            }
          </p>
        } @else {
          <p class="text-muted-foreground text-xs leading-4">No tasks in progress.</p>
        }
      </section>

      <section aria-label="Recent records" class="border-border flex flex-col gap-2.5 border-b px-5 py-4">
        <h3 class="text-foreground font-mono text-[10px] leading-3 uppercase">Recent records</h3>
        @for (r of records(); track r.id) {
          <a
            class="group/rec flex min-w-0 items-center gap-2 outline-none"
            [routerLink]="['/', slug(), 'tasks', r.key]"
          >
            <span class="bg-delta-line size-1.5 shrink-0" aria-hidden="true"></span>
            <span class="text-foreground min-w-0 flex-1 truncate text-[12.5px] leading-4 group-hover/rec:underline group-focus-visible/rec:underline">{{ r.title }}</span>
            <span class="text-faint shrink-0 font-mono text-[10px] leading-3">{{ r.updatedAt | ago }}</span>
          </a>
        } @empty {
          <p class="text-muted-foreground text-xs leading-4">No tasks have a Delta thread yet.</p>
        }
      </section>

      <section id="project-properties" aria-label="Properties" class="flex flex-col gap-0.5 px-3 py-4 pb-6">
        <h3 class="text-foreground px-2 pb-1.5 font-mono text-[10px] leading-3 uppercase">Properties</h3>
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
    } @else {
      <p class="text-muted-foreground px-4 py-4">This project is no longer available.</p>
    }
  `,
})
export class ProjectProperties {
  /** Project id. */
  readonly id = input.required<string>();

  private readonly store = inject(TramaStore);

  protected readonly membersShown = MEMBERS_SHOWN;
  protected readonly priorities = priorityOptions();
  protected readonly iso = isoFromDate;
  protected readonly href = repoHref;
  protected readonly label = repoLabel;

  protected readonly project = computed(() => this.store.getProject(this.id()));
  private readonly entries = computed(() => this.store.settings().statuses);
  protected readonly statuses = computed(() => projectStatusOptions(this.entries().project));
  protected readonly users = computed(() => userOptions(this.store));
  protected readonly slug = computed(() => this.store.slug() ?? '');
  protected readonly link = computed(() => ['/', this.slug(), 'projects', this.id()]);
  protected readonly openTasks = tasksQuery({ status: ['open'] });
  protected readonly doneTasks = tasksQuery({ status: ['done'] });
  protected readonly inProgressTasks = tasksQuery({ status: ['in_progress'] });
  protected readonly canManage = computed(() => this.store.allowed('manageProjects'));
  protected readonly overdue = computed(() => {
    const p = this.project();
    return !!p && isOverdue(p);
  });
  private readonly tasks = computed(() => this.store.issuesByProject().get(this.id()) ?? []);

  /** Tasks not canceled: open and done. */
  protected readonly counts = computed(() => {
    const entries = this.entries().issue;
    let open = 0;
    let done = 0;
    for (const i of this.tasks()) {
      const type = statusTypeOf(entries, i.status);
      if (type === 'canceled') continue;
      if (isClosedIssue(i, entries)) done++;
      else open++;
    }
    return { open, done };
  });

  /** The lead first, then whoever the project's tasks are assigned to. */
  protected readonly members = computed<string[]>(() => {
    const ids = new Set<string>();
    const lead = this.project()?.leadId;
    if (lead) ids.add(lead);
    for (const i of this.tasks()) if (i.assigneeId) ids.add(i.assigneeId);
    return [...ids];
  });

  /** Share of the tasks in progress that are linked to a Delta thread. */
  protected readonly coverage = computed(() => {
    const entries = this.entries().issue;
    const active = this.tasks().filter((i) => statusTypeOf(entries, i.status) === 'in_progress');
    if (!active.length) return null;
    const linked = active.filter((i) => !!i.threadUrl).length;
    return { percent: Math.round((linked / active.length) * 100), missing: active.length - linked };
  });

  protected readonly records = computed(() =>
    this.tasks()
      .filter((i) => !!i.threadUrl)
      .slice()
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .slice(0, RECORDS_SHOWN),
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
