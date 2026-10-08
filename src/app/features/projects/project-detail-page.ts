import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { LucideBox, LucideDynamicIcon, LucideEllipsis, LucideHexagon, LucidePlus, LucideTrash2 } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import { NablaStore, UiStore, type DomainEvent, type Priority, type ProjectStatus } from '../../core';
import { TopBarActions, usePageCrumbs } from '../../layout/page-chrome';
import { EmptyState } from '../../shared/empty-state';
import { FullDatePipe, RelativeTimePipe } from '../../shared/pipes';
import { PropertyRow } from '../../shared/property-row';
import { WorkstreamRow } from '../workstreams/workstream-items';
import { buildSummary } from '../workstreams/ws-model';
import { ProviderIcon } from '../../shared/provider-icon';
import { ProjectMilestones } from '../milestones/project-milestones';
import { EventLine } from '../overview/event-line';
import { CommentThread } from '../workstreams/comments';
import { EditableMarkdown, InlineText } from '../workstreams/inline-edit';
import { Picker } from '../workstreams/picker';
import { priorityOptions, repoOptions, teamOptions, userOptions } from '../workstreams/ws-model';
import { WsDatePicker } from '../workstreams/ws-parts';
import { isoFromDate } from '../milestones/milestone-actions';
import { isOverdue, projectStatusOptions } from './project-model';

const ACTIVITY_CAP = 20;

@Component({
  selector: 'app-project-detail-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    HlmButtonImports,
    HlmDropdownMenuImports,
    LucideDynamicIcon,
    TopBarActions,
    EmptyState,
    PropertyRow,
    ProviderIcon,
    FullDatePipe,
    RelativeTimePipe,
    CommentThread,
    EditableMarkdown,
    InlineText,
    Picker,
    WsDatePicker,
    EventLine,
    WorkstreamRow,
    ProjectMilestones,
  ],
  host: { class: 'flex min-h-full min-w-0 flex-col' },
  template: `
    @if (project(); as p) {
      @if (canManage()) {
        <ng-template appTopBarActions>
          <button hlmBtn variant="ghost" size="icon-sm" class="text-muted-foreground" [hlmDropdownMenuTrigger]="more" aria-label="Project actions">
            <svg [lucideIcon]="moreIcon" [size]="16"></svg>
          </button>
          <ng-template #more>
            <hlm-dropdown-menu class="w-48">
              <button hlmDropdownMenuItem variant="destructive" (triggered)="remove()">
                <svg [lucideIcon]="trash" [size]="14"></svg> Delete project
              </button>
            </hlm-dropdown-menu>
          </ng-template>
        </ng-template>
      }

      <header class="border-b px-4 pt-5 pb-4 sm:px-6">
        <div class="flex min-w-0 items-center gap-2.5">
          <span class="size-4 shrink-0 rounded-sm" [style.background]="p.color"></span>
          <app-inline-text
            class="min-w-0 flex-1"
            label="project name"
            textClass="text-xl font-semibold tracking-tight"
            [value]="p.name"
            [canEdit]="canManage()"
            (save)="update({ name: $event })"
          />
        </div>
        <app-inline-text
          class="mt-1"
          label="summary"
          placeholder="Add a short summary…"
          textClass="text-muted-foreground text-sm"
          [value]="p.summary ?? ''"
          [canEdit]="canManage()"
          [allowEmpty]="true"
          (save)="update({ summary: $event.trim() || null })"
        />
      </header>

      <div class="grid min-w-0 grid-cols-1 gap-x-10 gap-y-6 px-4 py-5 sm:px-6 lg:grid-cols-[minmax(0,1fr)_17rem]">
        <div class="flex min-w-0 flex-col gap-8">
          <section aria-label="Description">
            <app-editable-markdown
              label="description"
              placeholder="Describe the outcome, scope and why it matters…"
              [value]="p.description ?? ''"
              [canEdit]="canManage()"
              (save)="update({ description: $event.trim() || null })"
            />
          </section>

          <app-project-milestones [project]="p" />

          <section class="min-w-0">
            <h2 class="mb-1 flex items-center gap-2 text-[13px] font-semibold">
              Workstreams <span class="text-muted-foreground font-normal tabular-nums">{{ workstreams().length }}</span>
              @if (canCreateWorkstream()) {
                <button hlmBtn variant="ghost" size="xs" class="text-muted-foreground ml-auto h-6 gap-1 px-2 text-xs font-normal" (click)="newWorkstream()">
                  <svg [lucideIcon]="plus" [size]="12"></svg>New workstream
                </button>
              }
            </h2>
            @if (workstreams().length) {
              <div class="-mx-4 border-t sm:-mx-6">
                @for (s of workstreams(); track s.ws.id) {
                  <app-workstream-row [summary]="s" />
                }
              </div>
            } @else {
              <div class="text-muted-foreground flex items-center gap-2 rounded-md border border-dashed px-3 py-4 text-[13px]">
                <svg [lucideIcon]="hexagon" [size]="15" [strokeWidth]="1.5"></svg>
                No workstream carries out this project yet.
              </div>
            }
          </section>

          <section>
            <h2 class="mb-1 flex items-center gap-2 text-[13px] font-semibold">
              Repositories <span class="text-muted-foreground font-normal tabular-nums">{{ repos().length }}</span>
            </h2>
            @if (repos().length) {
              <div class="border-t">
                @for (r of repos(); track r.id) {
                  <a class="hover:bg-muted/60 flex min-w-0 items-center gap-2.5 border-b px-1 py-2 text-sm" [routerLink]="['/', slug(), 'repositories', r.id]">
                    <app-provider-icon [provider]="r.provider" [size]="16" />
                    <span class="min-w-0 flex-1 truncate font-mono text-[13px]">{{ r.fullName }}</span>
                    <span class="text-muted-foreground shrink-0 font-mono text-xs max-sm:hidden">{{ r.defaultBranch }}</span>
                  </a>
                }
              </div>
            } @else {
              <p class="text-muted-foreground text-[13px]">No repository yet. Link the ones this project's workstreams land in.</p>
            }
          </section>

          <section>
            <h2 class="mb-1 text-[13px] font-semibold">Activity</h2>
            @if (activity().length) {
              <div class="flex flex-col">
                @for (e of shownActivity(); track e.id) {
                  <app-event-line [event]="e" [slug]="slug()" />
                }
              </div>
              @if (activity().length > activityCap && !allActivity()) {
                <button hlmBtn variant="ghost" size="sm" class="text-muted-foreground mt-1" (click)="allActivity.set(true)">
                  Show all {{ activity().length }}
                </button>
              }
            } @else {
              <p class="text-muted-foreground text-[13px]">Nothing has happened here in the recent history.</p>
            }
          </section>

          <section>
            <h2 class="mb-2 text-[13px] font-semibold">Comments</h2>
            <app-comment-thread [subject]="{ type: 'project', id: p.id }" />
          </section>
        </div>

        <aside class="flex min-w-0 flex-col gap-0.5" aria-label="Properties">
          <app-property-row label="Status">
            <app-picker variant="field" label="Status" [searchable]="false" [disabled]="!canManage()" [options]="statuses" [value]="[p.status]" (valueChange)="setStatus($event[0])" />
          </app-property-row>
          <app-property-row label="Priority">
            <app-picker variant="field" label="Priority" [searchable]="false" [disabled]="!canManage()" [options]="priorities" [value]="[p.priority]" (valueChange)="setPriority($event[0])" />
          </app-property-row>
          <app-property-row label="Lead">
            <app-picker variant="field" label="Lead" placeholder="No lead" [clearable]="true" clearLabel="Remove lead" [disabled]="!canManage()" [options]="users()" [value]="p.leadId ? [p.leadId] : []" (valueChange)="update({ leadId: $event[0] ?? null })" />
          </app-property-row>
          <app-property-row label="Teams">
            <app-picker variant="field" label="Teams" placeholder="None" [multiple]="true" [disabled]="!canManage()" [options]="teams()" [value]="p.teamIds" (valueChange)="update({ teamIds: $event })" />
          </app-property-row>
          <app-property-row label="Repositories">
            <app-picker variant="field" label="Repositories" placeholder="None" [multiple]="true" [disabled]="!canManage()" [options]="repoChoices()" [value]="p.repositoryIds" (valueChange)="update({ repositoryIds: $event })" />
          </app-property-row>
          <app-property-row label="Start date">
            <app-ws-date-picker class="min-w-0 flex-1" label="Start date" triggerClass="h-auto min-h-8 w-full justify-start px-1.5 py-1 text-sm" [disabled]="!canManage()" [value]="p.startDate" (dateChange)="update({ startDate: $event ? iso($event) : null })">
              @if (p.startDate) {
                <span>{{ p.startDate | fullDate }}</span>
              } @else {
                <span class="text-muted-foreground">Not set</span>
              }
            </app-ws-date-picker>
          </app-property-row>
          <app-property-row label="Target date">
            <app-ws-date-picker class="min-w-0 flex-1" label="Target date" triggerClass="h-auto min-h-8 w-full justify-start px-1.5 py-1 text-sm" [disabled]="!canManage()" [value]="p.targetDate" (dateChange)="update({ targetDate: $event ? iso($event) : null })">
              @if (p.targetDate) {
                <span [class.text-status-blocked]="overdue()">{{ p.targetDate | fullDate }}</span>
                @if (overdue()) {
                  <span class="text-status-blocked ml-1.5 text-xs">overdue</span>
                }
              } @else {
                <span class="text-muted-foreground">No date</span>
              }
            </app-ws-date-picker>
          </app-property-row>
          <app-property-row label="Created">
            <span class="text-muted-foreground px-1.5 text-xs">{{ p.createdAt | relativeTime }}</span>
          </app-property-row>
        </aside>
      </div>
    } @else {
      <app-empty-state [icon]="box" title="Project not found" description="It may have been deleted.">
        <a hlmBtn size="sm" variant="outline" [routerLink]="['/', slug(), 'projects']">Back to projects</a>
      </app-empty-state>
    }
  `,
})
export class ProjectDetailPage {
  /** From the parent `:workspaceSlug` route segment. */
  readonly workspaceSlug = input<string>();
  readonly id = input<string>();

  private readonly store = inject(NablaStore);
  private readonly ui = inject(UiStore);
  private readonly router = inject(Router);

  protected readonly box = LucideBox;
  protected readonly moreIcon = LucideEllipsis;
  protected readonly trash = LucideTrash2;
  protected readonly plus = LucidePlus;
  protected readonly hexagon = LucideHexagon;
  protected readonly statuses = projectStatusOptions();
  protected readonly priorities = priorityOptions();
  protected readonly activityCap = ACTIVITY_CAP;
  protected readonly allActivity = signal(false);
  protected readonly iso = isoFromDate;

  protected readonly slug = computed(() => this.store.slug() ?? this.workspaceSlug() ?? '');
  protected readonly canManage = computed(() => this.store.allowed('manageProjects'));
  protected readonly project = computed(() => this.store.getProject(this.id()));
  protected readonly teams = computed(() => teamOptions(this.store));
  protected readonly users = computed(() => userOptions(this.store));
  protected readonly repoChoices = computed(() => repoOptions(this.store));
  protected readonly overdue = computed(() => {
    const p = this.project();
    return !!p && isOverdue(p);
  });
  protected readonly repos = computed(() =>
    (this.project()?.repositoryIds ?? []).map((id) => this.store.getRepository(id)).filter((r) => !!r),
  );
  protected readonly canCreateWorkstream = computed(() => this.store.allowed('createWorkstreams'));
  protected readonly workstreams = computed(() => {
    const id = this.project()?.id;
    return id ? (this.store.workstreamsByProject().get(id) ?? []).map((ws) => buildSummary(this.store, ws)) : [];
  });
  protected readonly activity = computed(() => {
    const id = this.project()?.id;
    if (!id) return [] as DomainEvent[];
    const own = this.store.eventsBySubject().get(`project:${id}`) ?? [];
    // milestone events carry the project in their data
    const milestones = this.store.events().filter((e) => e.subject.type === 'milestone' && e.data?.['projectId'] === id);
    return [...own, ...milestones].sort((a, b) => (a.at < b.at ? 1 : -1));
  });
  protected readonly shownActivity = computed(() =>
    this.allActivity() ? this.activity() : this.activity().slice(0, ACTIVITY_CAP),
  );

  private readonly _crumbs = usePageCrumbs(() => [
    { label: 'Projects', link: ['/', this.slug(), 'projects'] },
    { label: this.project()?.name ?? this.id() ?? '' },
  ]);

  protected update(patch: Parameters<NablaStore['updateProject']>[1]): void {
    const p = this.project();
    if (p) void this.store.updateProject(p.id, patch);
  }

  protected newWorkstream(): void {
    const id = this.project()?.id;
    if (id) this.ui.openCreate('workstream', { projectId: id });
  }

  protected setStatus(v: string | undefined): void {
    if (v) this.update({ status: v as ProjectStatus });
  }

  protected setPriority(v: string | undefined): void {
    if (v) this.update({ priority: v as Priority });
  }

  protected remove(): void {
    const p = this.project();
    if (!p) return;
    this.ui.setConfirmDelete({
      title: `Delete ${p.name}?`,
      description: 'The project is removed. Repositories are not affected.',
      onConfirm: async () => {
        const ok = await this.store.deleteProject(p.id);
        if (ok) await this.router.navigate(['/', this.slug(), 'projects']);
      },
    });
  }
}
