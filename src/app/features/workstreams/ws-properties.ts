// Properties sidebar of a workstream: every row is an inline popover editor.
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import { NablaStore, WORKSTREAM_STATUS_META, isOverdue, type Priority, type Workstream, type WorkstreamStatus } from '../../core';
import { ActorLabel } from '../../shared/actor-avatar';
import { FullDatePipe } from '../../shared/pipes';
import { PropertyRow } from '../../shared/property-row';
import { isoFromDate } from '../milestones/milestone-actions';
import { MilestoneInfo } from '../milestones/milestone-stats';
import { Picker } from './picker';
import { WsActions } from './ws-actions';
import { contributors, issueCounts, labelOptions, priorityOptions, projectOptions, repoOptionsIn, statusOptions, teamOptions, userOptions } from './ws-model';
import { IssueProgress, WsDatePicker } from './ws-parts';

@Component({
  selector: 'app-ws-properties',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PropertyRow, Picker, HlmTooltip, ActorLabel, FullDatePipe, IssueProgress, WsDatePicker],
  host: { class: 'block' },
  template: `
    @let w = ws();
    <div class="flex flex-col gap-0.5">
      <app-property-row label="Status">
        <app-picker
          variant="field"
          label="Status"
          [searchable]="false"
          [clearable]="!!w.statusOverride"
          clearLabel="Automatic (derived)"
          [disabled]="!canEdit()"
          [options]="statuses"
          [value]="[w.status]"
          (valueChange)="setStatus($event[0])"
        />
        <span class="text-muted-foreground shrink-0 text-[11px]" [hlmTooltip]="w.statusOverride ? 'Set manually. Derived: ' + derivedLabel() : 'Derived from the work'">{{ w.statusOverride ? 'manual' : 'auto' }}</span>
      </app-property-row>
      <app-property-row label="Owner team">
        <app-picker variant="field" label="Owner team" [disabled]="!canEdit()" [options]="teams()" [value]="[w.ownerTeamId]" (valueChange)="setOwner($event[0])" />
      </app-property-row>
      <app-property-row label="Participating">
        <app-picker variant="field" label="Participating teams" placeholder="None" [multiple]="true" [disabled]="!canEdit()" [options]="participantOptions()" [value]="w.participatingTeamIds" (valueChange)="update({ participatingTeamIds: $event })" />
      </app-property-row>
      <app-property-row label="Accountable">
        <app-picker variant="field" label="Accountable" placeholder="Unassigned" [clearable]="true" clearLabel="Unassign" [disabled]="!canEdit()" [options]="users()" [value]="w.accountableUserId ? [w.accountableUserId] : []" (valueChange)="update({ accountableUserId: $event[0] ?? null })" />
      </app-property-row>
      <app-property-row label="Priority">
        <app-picker variant="field" label="Priority" [searchable]="false" [disabled]="!canEdit()" [options]="priorities" [value]="[w.priority]" (valueChange)="setPriority($event[0])" />
      </app-property-row>
      <app-property-row label="Start date">
        <app-ws-date-picker class="min-w-0 flex-1" label="Start date" triggerClass="h-auto min-h-8 w-full justify-start px-1.5 py-1 text-sm" [disabled]="!canEdit()" [value]="w.startDate" (dateChange)="setStart($event)">
          @if (w.startDate) {
            <span>{{ w.startDate | fullDate }}</span>
          } @else {
            <span class="text-muted-foreground">Not set · {{ w.createdAt | fullDate }}</span>
          }
        </app-ws-date-picker>
      </app-property-row>
      <app-property-row label="Target date">
        <app-ws-date-picker class="min-w-0 flex-1" triggerClass="h-auto min-h-8 w-full justify-start px-1.5 py-1 text-sm" [disabled]="!canEdit()" [value]="w.targetDate" (dateChange)="setDate($event)">
          @if (w.targetDate) {
            <span [class.text-status-blocked]="overdue()">{{ w.targetDate | fullDate }}</span>
            @if (overdue()) {
              <span class="text-status-blocked ml-1.5 text-xs">overdue</span>
            }
          } @else {
            <span class="text-muted-foreground">No date</span>
          }
        </app-ws-date-picker>
      </app-property-row>
      <app-property-row label="Milestones">
        <span class="flex min-w-0 items-center gap-1.5 px-1.5 text-sm">
          @if (milestones().length) {
            <span class="tabular-nums">{{ milestones().length }}</span>
            @if (next(); as n) {
              <span class="text-muted-foreground truncate text-xs" [hlmTooltip]="n.ms.name">next · M{{ n.n }}{{ n.ms.targetDate ? ' · ' + (n.ms.targetDate | fullDate) : '' }}</span>
            } @else {
              <span class="text-muted-foreground text-xs">all complete</span>
            }
          } @else {
            <span class="text-muted-foreground">None</span>
          }
        </span>
      </app-property-row>
      <app-property-row label="Project">
        <app-picker variant="field" label="Project" placeholder="No project" [clearable]="true" clearLabel="Remove from project" [disabled]="!canEdit()" [options]="projects()" [value]="w.projectId ? [w.projectId] : []" (valueChange)="setProject($event[0])" />
      </app-property-row>
      <app-property-row label="Repositories">
        <app-picker variant="field" label="Repositories" placeholder="None" [multiple]="true" [disabled]="!canEdit()" [options]="repos()" [value]="w.repositoryIds" (valueChange)="update({ repositoryIds: $event })" />
      </app-property-row>
      <app-property-row label="Issues">
        <span class="px-1.5"><app-issue-progress [done]="counts().issuesDone" [active]="counts().issuesActive" [total]="counts().issuesTotal" /></span>
      </app-property-row>
      <app-property-row label="Dependencies">
        <span class="text-muted-foreground px-1.5 text-xs">
          @if (deps().waits || deps().blocks) {
            waits on <span class="text-foreground tabular-nums">{{ deps().waits }}</span> · blocks <span class="text-foreground tabular-nums">{{ deps().blocks }}</span>
          } @else {
            None
          }
        </span>
      </app-property-row>
      <app-property-row label="Labels">
        <app-picker variant="field" label="Labels" placeholder="None" [multiple]="true" [disabled]="!canEdit()" [options]="labelChoices()" [value]="w.labels" (valueChange)="update({ labels: $event })" />
      </app-property-row>
    </div>

    <!-- quick-stat cards (progress, milestones, activity) sit right under the property rows -->
    <div class="mt-4 empty:hidden"><ng-content /></div>

    <div class="mt-4 border-t pt-3">
      <div class="text-muted-foreground mb-1.5 flex items-center gap-1.5 text-xs font-medium">
        Contributors <span class="tabular-nums">{{ people().length }}</span>
      </div>
      @if (people().length) {
        <ul class="flex flex-col gap-1">
          @for (p of people().slice(0, showAll() ? 50 : 6); track p.type + p.id) {
            <li class="flex min-h-6 items-center gap-2 text-[13px]">
              <app-actor [actor]="p" [size]="18" />
              @if (p.type === 'user' && p.id === w.accountableUserId) {
                <span class="text-muted-foreground ml-auto text-[11px]">accountable</span>
              } @else if (p.type === 'agent') {
                <span class="text-muted-foreground ml-auto text-[11px]">agent</span>
              }
            </li>
          }
        </ul>
        @if (people().length > 6) {
          <button type="button" class="text-muted-foreground hover:text-foreground mt-1 text-xs" (click)="showAll.update((v) => !v)">
            {{ showAll() ? 'Show fewer' : 'Show all ' + people().length }}
          </button>
        }
      } @else {
        <p class="text-muted-foreground text-xs">Nobody yet. People appear here when they author PRs, comment, answer questions or own linked issues.</p>
      }
    </div>
  `,
})
export class WsProperties {
  private readonly store = inject(NablaStore);
  private readonly actions = inject(WsActions);
  private readonly msInfo = inject(MilestoneInfo);
  readonly ws = input.required<Workstream>();

  protected readonly statuses = statusOptions();
  protected readonly showAll = signal(false);
  protected readonly derivedLabel = computed(() => WORKSTREAM_STATUS_META[this.ws().derivedStatus].label);
  protected readonly counts = computed(() => issueCounts(this.store.issuesByWorkstream().get(this.ws().id) ?? []));
  protected readonly deps = computed(() => ({
    waits: (this.store.incomingDependencies().get(this.ws().id) ?? []).filter((d) => d.fromType === 'workstream').length,
    blocks: (this.store.outgoingDependencies().get(this.ws().id) ?? []).filter((d) => d.toType === 'workstream').length,
  }));
  protected readonly people = computed(() => contributors(this.store, this.ws()));
  protected readonly milestones = computed(() => this.store.milestonesByWorkstream().get(this.ws().id) ?? []);
  protected readonly next = computed(() => this.msInfo.nextByWorkstream().get(this.ws().id));

  protected readonly canEdit = computed(() => this.store.can('member'));
  protected readonly teams = computed(() => teamOptions(this.store));
  protected readonly users = computed(() => userOptions(this.store));
  protected readonly repos = computed(() => repoOptionsIn(this.store, this.ws().projectId));
  protected readonly projects = computed(() => projectOptions(this.store, this.ws().projectId));
  protected readonly priorities = priorityOptions();
  protected readonly labelChoices = computed(() => labelOptions(this.store));
  protected readonly participantOptions = computed(() => this.teams().filter((t) => t.value !== this.ws().ownerTeamId));

  protected readonly overdue = computed(
    () => isOverdue(this.ws().targetDate) && this.ws().status !== 'shipped' && this.ws().status !== 'canceled',
  );
  protected update(patch: Parameters<NablaStore['updateWorkstream']>[1]): void {
    void this.store.updateWorkstream(this.ws().id, patch);
  }

  protected setOwner(id: string | undefined): void {
    if (!id || id === this.ws().ownerTeamId) return;
    this.update({ ownerTeamId: id, participatingTeamIds: this.ws().participatingTeamIds.filter((t) => t !== id) });
  }

  protected setPriority(p: string | undefined): void {
    if (p) this.update({ priority: p as Priority });
  }

  /** Joining a project keeps the repositories it also has, or adopts the project's when none were set. */
  protected setProject(id: string | undefined): void {
    const project = this.store.getProject(id);
    if (!project) return this.update({ projectId: null });
    const own = this.ws().repositoryIds.filter((r) => project.repositoryIds.includes(r));
    this.update({ projectId: project.id, repositoryIds: own.length ? own : [...project.repositoryIds] });
  }

  protected setDate(d: Date | null): void {
    this.actions.setTargetDate([this.ws()], d);
  }

  protected setStart(d: Date | null): void {
    this.update({ startDate: d ? isoFromDate(d) : null });
  }

  protected setStatus(v: string | undefined): void {
    this.actions.setStatus([this.ws()], (v as WorkstreamStatus | undefined) ?? null);
  }
}
