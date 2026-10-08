import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import {
  LucideBuilding2,
  LucideCalendar,
  LucideCircleUser,
  LucideDynamicIcon,
  LucideFolderGit2,
  LucideLayers,
  LucideScale,
  LucideLink2,
  LucideTag,
  LucideUsers,
  LucideX,
  type LucideIcon,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDatePickerImports } from '@spartan-ng/helm/date-picker';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { HlmSpinner } from '@spartan-ng/helm/spinner';
import { HlmSwitchImports } from '@spartan-ng/helm/switch';
import { HlmTextareaImports } from '@spartan-ng/helm/textarea';
import type {
  GitProvider,
  IssueKind,
  IssueStatus,
  Priority,
  ViewEntity,
  ViewFilter,
  ViewLayout,
  WorkstreamStatus,
} from '../../core/contracts/domain';
import {
  ISSUE_KIND_META,
  ISSUE_KINDS,
  ISSUE_STATUSES,
  ISSUE_STATUS_META,
  PRIORITIES,
  PRIORITY_META,
  WORKSTREAM_STATUS_FLOW,
  WORKSTREAM_STATUS_META,
} from '../../core/meta';
import { Notifier } from '../../core/notify/notifier';
import { NablaStore } from '../../core/stores/nabla.store';
import { UiStore, type CreateKind } from '../../core/stores/ui.store';
import { StatusIcon } from '../../shared/status';
import { issueEstimateOptions } from '../issues/issue-model';
import { Picker, type PickOption } from '../workstreams/picker';
import { AppSelect, FormRow, type Option } from './form-kit';
import { DraftSuggestions } from '../ai/draft-suggestions';
import type { AiIssueDraftSuggestion } from '../../core/ai/ai-api';

type ComposerKind = 'issue' | 'workstream' | 'decision';

interface KindDef {
  kind: ComposerKind;
  label: string;
  /** One-line explanation shown under the switcher (the issue ≠ workstream distinction). */
  blurb: string;
  example: string;
}

/** The composer kinds, most common first. Other kinds (team, view, …) open in single-form mode. */
const SWITCHER: KindDef[] = [
  {
    kind: 'issue',
    label: 'Issue',
    blurb: "A problem or request: what's wrong or needed.",
    example: 'BUG-142',
  },
  {
    kind: 'workstream',
    label: 'Workstream',
    blurb: "An outcome that resolves issues: what we're trying to accomplish.",
    example: 'AUTH-42',
  },
  {
    kind: 'decision',
    label: 'Decision',
    blurb: 'Durable knowledge: what was decided and why.',
    example: 'ADR-7',
  },
];
const EXTRA: Partial<Record<CreateKind, { label: string; icon: LucideIcon }>> = {
  team: { label: 'Team', icon: LucideUsers },
  repository: { label: 'Project', icon: LucideFolderGit2 },
  view: { label: 'View', icon: LucideLayers },
};

const VIEW_LAYOUTS: readonly ViewLayout[] = ['list', 'board', 'graph'];
const VIEW_ENTITIES: readonly ViewEntity[] = ['workstream', 'issue', 'decision'];

const asStr = (v: unknown): string => (typeof v === 'string' ? v : '');
const asArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const asTags = (v: unknown): string[] =>
  (Array.isArray(v) ? asArr(v) : asStr(v).split(',')).map((t) => t.trim()).filter(Boolean);
const oneOf = <T extends string>(list: readonly T[], v: unknown): T | undefined =>
  typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : undefined;

/**
 * Global create dialog (`ui.modal() === 'create'`): a Linear-style composer for issues,
 * workstreams and decisions (title · description · property chips), plus compact forms for
 * team / project / view.
 *
 * Context defaults (`ui.openCreate(kind, defaults)`):
 *   issue:      status, priority, teamId (or ownerTeamId), kind, assigneeId, workstreamIds[], title, body
 *               → workstreamIds are linked right after create (keeping the chosen status).
 *   workstream: status (sent as statusOverride unless 'planned' = derivable), title, description,
 *               ownerTeamId, repositoryIds[], issueIds[], priority, accountableUserId, deltaThreadUrl
 *               → issueIds are linked to the new workstream right after create.
 *   decision:   workstreamId (origin), title, statement, rationale, tags (string[] or "a, b")
 *   view:       name, entity, filters, sort, groupBy, layout, shared ("Save as view")
 *
 * After create we close and toast with an "Open" action instead of navigating away (Linear
 * behaviour: you stay where you were). With "Create more" on, the dialog stays open, keeps the
 * properties and clears title/description.
 */
@Component({
  selector: 'app-create-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    HlmDialogImports,
    HlmButtonImports,
    HlmInputImports,
    HlmTextareaImports,
    HlmDatePickerImports,
    HlmSwitchImports,
    HlmSpinner,
    LucideDynamicIcon,
    StatusIcon,
    Picker,
    AppSelect,
    FormRow,
    DraftSuggestions,
  ],
  template: `
    <hlm-dialog [state]="open() ? 'open' : 'closed'" (closed)="onClosed()">
      <hlm-dialog-content
        *hlmDialogPortal="let ctx"
        class="max-h-[92svh] gap-0 overflow-y-auto p-0 sm:max-w-[46rem]"
        [showCloseButton]="false"
        (keydown.meta.enter)="submit($event)"
        (keydown.control.enter)="submit($event)"
      >
        <hlm-dialog-header class="gap-0 px-4 pt-3 pb-0">
          <h2 hlmDialogTitle class="sr-only">New {{ kindLabel() }}</h2>
          <p hlmDialogDescription class="sr-only">
            Create a new {{ kindLabel().toLowerCase() }} in this workspace.
          </p>
          <div class="flex items-center gap-2">
            @if (composer(); as c) {
              <div class="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                @if (kind() !== 'decision') {
                  <app-picker
                    variant="pill"
                    label="Team"
                    [icon]="teamIcon"
                    [options]="teamOptions()"
                    [value]="opt(headerTeamId())"
                    [clearable]="kind() === 'issue'"
                    clearLabel="No team"
                    (valueChange)="setHeaderTeam($event[0] ?? '')"
                  />
                }
                <div
                  role="tablist"
                  aria-label="What to create"
                  class="bg-muted inline-flex rounded-md p-0.5"
                >
                  @for (k of switcher; track k.kind) {
                    <button
                      type="button"
                      role="tab"
                      [attr.aria-selected]="kind() === k.kind"
                      [title]="k.blurb"
                      class="text-muted-foreground hover:text-foreground flex h-7 items-center gap-1.5 rounded-[5px] px-2.5 text-[13px] font-medium transition-colors"
                      [class.bg-background]="kind() === k.kind"
                      [class.text-foreground]="kind() === k.kind"
                      [class.shadow-panel]="kind() === k.kind"
                      (click)="onSwitch(k.kind)"
                    >
                      @switch (k.kind) {
                        @case ('issue') {
                          <app-status-icon entity="issue" status="todo" [size]="13" />
                        }
                        @case ('workstream') {
                          <app-status-icon
                            entity="workstream"
                            status="planned"
                            [size]="13"
                            class="text-entity-workstream"
                          />
                        }
                        @default {
                          <svg [lucideIcon]="scale" [size]="13" class="text-entity-decision"></svg>
                        }
                      }
                      {{ k.label }}
                    </button>
                  }
                </div>
              </div>
            } @else {
              <div class="flex flex-1 items-center gap-2 py-1 text-sm font-medium">
                <svg [lucideIcon]="extraIcon()" [size]="15" class="text-muted-foreground"></svg>
                New {{ kindLabel().toLowerCase() }}
              </div>
            }
            @if (composer()) {
              <button
                hlmBtn
                type="button"
                variant="outline"
                size="sm"
                class="h-7 px-2.5 text-xs"
                [disabled]="busy()"
                (click)="saveDraft($event)"
              >
                Save as draft
              </button>
            }
            <button
              hlmBtn
              type="button"
              variant="ghost"
              size="icon-sm"
              hlmDialogClose
              aria-label="Close"
            >
              <svg [lucideIcon]="closeIcon" [size]="16"></svg>
            </button>
          </div>
        </hlm-dialog-header>

        <form (submit)="submit($event)" novalidate class="flex flex-col">
          @if (composer()) {
            <!-- title + description -->
            <div class="flex flex-col gap-1 px-5 pt-3">
              <input
                #titleEl
                id="cr-title"
                class="placeholder:text-muted-foreground/60 w-full bg-transparent py-1 text-xl font-semibold tracking-tight outline-none"
                [placeholder]="titlePlaceholder()"
                [(ngModel)]="title"
                name="title"
                autocomplete="off"
                autofocus
                aria-label="Title"
                [attr.aria-invalid]="!!err('title')"
              />
              @if (err('title'); as e) {
                <p class="text-destructive text-xs" role="alert">{{ e }}</p>
              }
              <textarea
                class="placeholder:text-muted-foreground/60 field-sizing-content max-h-72 min-h-24 w-full resize-none bg-transparent py-1 text-sm leading-relaxed outline-none"
                rows="3"
                [placeholder]="bodyPlaceholder()"
                [(ngModel)]="text"
                name="body"
                aria-label="Description"
              ></textarea>
              @if (err('statement'); as e) {
                <p class="text-destructive text-xs" role="alert">{{ e }}</p>
              }
              @if (kind() === 'decision') {
                <textarea
                  class="placeholder:text-muted-foreground/60 field-sizing-content max-h-48 min-h-12 w-full resize-none border-t bg-transparent py-2 text-sm leading-relaxed outline-none"
                  rows="2"
                  placeholder="Rationale: why this, and not the alternative? (optional)"
                  [(ngModel)]="text2"
                  name="rationale"
                  aria-label="Rationale"
                ></textarea>
              }
              @if (kind() === 'workstream' && deltaEnabled()) {
                <div
                  class="focus-within:border-ring/60 mt-1 flex h-8 items-center gap-2 rounded-md border px-2"
                  [class.border-destructive]="!!err('delta')"
                >
                  <svg
                    [lucideIcon]="linkIcon"
                    [size]="13"
                    class="text-muted-foreground shrink-0"
                  ></svg>
                  <input
                    class="placeholder:text-muted-foreground/70 min-w-0 flex-1 bg-transparent font-mono text-xs outline-none"
                    placeholder="Delta thread · https://delta.dev/t/…"
                    [(ngModel)]="deltaUrl"
                    name="delta"
                    autocomplete="off"
                    aria-label="Delta thread URL"
                  />
                </div>
                @if (err('delta'); as e) {
                  <p class="text-destructive text-xs" role="alert">{{ e }}</p>
                }
              }
            </div>

            <!-- quick suggestions -->
            <div class="px-5 pt-3">
              <app-draft-suggestions
                [kind]="composer()!.kind"
                [title]="title()"
                [description]="text()"
                [disabled]="busy()"
                [current]="suggestionCurrent()"
                (titleAccepted)="title.set($event)"
                (descriptionAccepted)="text.set($event)"
                (questionPicked)="addQuestion($event)"
                (triageAccepted)="applyIssueSuggestion($event)"
                (settingsRequested)="ui.closeModal()"
              />
            </div>

            <!-- property chips -->
            <div class="flex flex-wrap items-center gap-1.5 px-5 pt-3 pb-4">
              @switch (kind()) {
                @case ('issue') {
                  <app-picker
                    variant="pill"
                    label="Status"
                    [searchable]="false"
                    [options]="issueStatusOptions"
                    [value]="[issueStatus()]"
                    (valueChange)="setOne(issueStatus, $event)"
                  />
                  <app-picker
                    variant="pill"
                    label="Priority"
                    [searchable]="false"
                    [options]="priorityOptions"
                    [value]="[priority()]"
                    (valueChange)="setOne(priority, $event)"
                  />
                  <app-picker
                    variant="pill"
                    label="Type"
                    [searchable]="false"
                    [options]="issueKindOptions"
                    [value]="[issueKind()]"
                    (valueChange)="setOne(issueKind, $event)"
                  />
                  @if (showEstimate()) {
                    <app-picker
                      variant="pill"
                      label="Estimate"
                      [searchable]="false"
                      [options]="issueEstimateChoices()"
                      [value]="opt(issueEstimate())"
                      [clearable]="true"
                      clearLabel="No estimate"
                      (valueChange)="issueEstimate.set($event[0] ?? '')"
                    />
                  }
                  <app-picker
                    variant="pill"
                    label="Assignee"
                    [icon]="userIcon"
                    [options]="userOptions()"
                    [value]="opt(assigneeId())"
                    [clearable]="true"
                    clearLabel="Unassigned"
                    (valueChange)="assigneeId.set($event[0] ?? '')"
                  />
                  <app-picker
                    variant="pill"
                    label="Workstreams"
                    [multiple]="true"
                    [options]="workstreamOptions()"
                    [value]="workstreamIds()"
                    (valueChange)="workstreamIds.set($event)"
                    searchPlaceholder="Link to workstreams…"
                  />
                }
                @case ('workstream') {
                  <app-picker
                    variant="pill"
                    label="Status"
                    [searchable]="false"
                    [options]="wsStatusOptions"
                    [value]="opt(wsStatus())"
                    [clearable]="true"
                    clearLabel="Derived (automatic)"
                    (valueChange)="wsStatus.set($event[0] ?? '')"
                  />
                  <app-picker
                    variant="pill"
                    label="Priority"
                    [searchable]="false"
                    [options]="priorityOptions"
                    [value]="[priority()]"
                    (valueChange)="setOne(priority, $event)"
                  />
                  <app-picker
                    variant="pill"
                    label="Accountable"
                    [icon]="userIcon"
                    [options]="userOptions()"
                    [value]="opt(accountableId())"
                    [clearable]="true"
                    clearLabel="Nobody yet"
                    (valueChange)="accountableId.set($event[0] ?? '')"
                  />
                  @if (repoOptions().length) {
                    <app-picker
                      variant="pill"
                      label="Projects"
                      [multiple]="true"
                      [options]="repoOptions()"
                      [value]="repositoryIds()"
                      (valueChange)="repositoryIds.set($event)"
                    />
                  }
                  <app-picker
                    variant="pill"
                    label="Issues"
                    [multiple]="true"
                    [options]="issueOptions()"
                    [value]="issueIds()"
                    (valueChange)="issueIds.set($event)"
                    searchPlaceholder="Issues this resolves…"
                  />
                  <hlm-date-picker
                    [date]="targetDate()"
                    (dateChange)="targetDate.set($event ?? undefined)"
                    align="start"
                  >
                    <hlm-date-picker-trigger
                      variant="outline"
                      [showTrigger]="false"
                      class="h-7 gap-1.5 px-2 text-xs font-normal"
                      [class.border-dashed]="!targetDate()"
                      [class.bg-accent]="!!targetDate()"
                      >Target date</hlm-date-picker-trigger
                    >
                  </hlm-date-picker>
                }
                @case ('decision') {
                  <app-picker
                    variant="pill"
                    label="Status"
                    [searchable]="false"
                    [options]="decisionStatusOptions"
                    [value]="[decisionStatus()]"
                    (valueChange)="setOne(decisionStatus, $event)"
                  />
                  <app-picker
                    variant="pill"
                    label="Origin"
                    [options]="workstreamOptions()"
                    [value]="opt(workstreamId())"
                    [clearable]="true"
                    clearLabel="No origin"
                    (valueChange)="workstreamId.set($event[0] ?? '')"
                  />
                  <label
                    class="border-border-strong focus-within:border-ring/60 flex h-7 items-center gap-1.5 rounded-md border border-dashed px-2 text-xs"
                  >
                    <svg
                      [lucideIcon]="tagIcon"
                      [size]="13"
                      class="text-muted-foreground shrink-0"
                    ></svg>
                    <input
                      class="placeholder:text-muted-foreground w-36 bg-transparent outline-none"
                      placeholder="Tags, comma separated"
                      [(ngModel)]="tags"
                      name="tags"
                      autocomplete="off"
                      aria-label="Tags"
                    />
                  </label>
                }
              }
            </div>
            @if (err('team'); as e) {
              <p class="text-destructive -mt-2 px-5 pb-3 text-xs" role="alert">{{ e }}</p>
            }
          } @else {
            <div class="flex flex-col gap-3 px-4 pt-2 pb-4">
              @switch (kind()) {
                @case ('team') {
                  <div class="grid gap-3 sm:grid-cols-[1fr_8rem]">
                    <app-form-row label="Name" [error]="err('title')">
                      <input
                        hlmInput
                        placeholder="Platform"
                        [ngModel]="title()"
                        (ngModelChange)="onTeamName($event)"
                        name="name"
                        autocomplete="off"
                        autofocus
                        aria-label="Team name"
                      />
                    </app-form-row>
                    <app-form-row label="Key" [error]="err('key')">
                      <input
                        hlmInput
                        class="font-mono uppercase"
                        placeholder="PLAT"
                        [ngModel]="teamKey()"
                        (ngModelChange)="onTeamKey($event)"
                        name="key"
                        maxlength="8"
                        autocomplete="off"
                        aria-label="Team key"
                      />
                    </app-form-row>
                  </div>
                  <app-form-row label="Description" [optional]="true">
                    <textarea
                      hlmTextarea
                      rows="2"
                      [(ngModel)]="text"
                      name="description"
                      placeholder="What does this team own?"
                    ></textarea>
                  </app-form-row>
                  <p class="text-muted-foreground text-xs">
                    The key prefixes workstream ids (PLAT-12) and cannot be changed later.
                  </p>
                }
                @case ('repository') {
                  <div class="grid gap-3 sm:grid-cols-[9rem_1fr]">
                    <app-form-row label="Provider">
                      <app-select
                        [options]="gitProviderOptions"
                        [(value)]="gitProvider"
                        label="Provider"
                      />
                    </app-form-row>
                    <app-form-row label="Project" [error]="err('title')">
                      <input
                        hlmInput
                        class="font-mono"
                        placeholder="acme/api"
                        [(ngModel)]="title"
                        name="fullName"
                        autocomplete="off"
                        autofocus
                        aria-label="Project name"
                      />
                    </app-form-row>
                  </div>
                  <app-form-row label="Default branch" [optional]="true">
                    <input
                      hlmInput
                      class="font-mono"
                      placeholder="main"
                      [(ngModel)]="text"
                      name="branch"
                      autocomplete="off"
                      aria-label="Default branch"
                    />
                  </app-form-row>
                }
                @case ('view') {
                  <app-form-row label="Name" [error]="err('title')">
                    <input
                      hlmInput
                      placeholder="e.g. Blocked this week"
                      [(ngModel)]="title"
                      name="name"
                      autocomplete="off"
                      autofocus
                      aria-label="View name"
                    />
                  </app-form-row>
                  <div class="grid gap-3 sm:grid-cols-2">
                    <app-form-row label="Shows">
                      <app-select
                        [options]="viewEntityOptions"
                        [(value)]="viewEntity"
                        label="Entity"
                        [disabled]="viewPreset()"
                      />
                    </app-form-row>
                    <app-form-row label="Visibility">
                      <label class="flex h-8 items-center gap-2 text-sm">
                        <hlm-switch
                          [(checked)]="shared"
                          [disabled]="!canShare()"
                          aria-label="Share with the workspace"
                        />
                        {{ shared() ? 'Shared with the workspace' : 'Private to me' }}
                      </label>
                    </app-form-row>
                  </div>
                  @if (viewSummary(); as s) {
                    <p class="text-muted-foreground text-xs">Saves the current setup: {{ s }}.</p>
                  }
                }
              }
            </div>
          }

          <hlm-dialog-footer
            class="mx-0 mb-0 flex-row items-center justify-end gap-3 rounded-b-xl px-4 py-3"
          >
            @if (composer()) {
              <label class="text-muted-foreground flex cursor-pointer items-center gap-2 text-xs">
                <hlm-switch size="sm" [(checked)]="createMore" aria-label="Create more" />
                Create more
              </label>
            }
            @if (!composer()) {
              <button hlmBtn type="button" variant="ghost" size="sm" hlmDialogClose>Cancel</button>
            }
            <button hlmBtn type="submit" size="sm" class="" [disabled]="busy()">
              @if (busy()) {
                <hlm-spinner />
              }
              Create {{ kindLabel().toLowerCase() }}
            </button>
          </hlm-dialog-footer>
        </form>
      </hlm-dialog-content>
    </hlm-dialog>
  `,
})
export class CreateDialog {
  protected readonly ui = inject(UiStore);
  private readonly store = inject(NablaStore);
  protected readonly deltaEnabled = computed(() => this.store.deltaThreads());
  /** Workspace default team (Settings → General), if it still exists. */
  private defaultTeam(): string {
    const id = this.store.settings().defaultTeamId;
    return id && this.store.teamById().has(id) ? id : '';
  }
  protected readonly canShare = computed(() => this.store.allowed('manageSharedViews'));
  private readonly router = inject(Router);
  private readonly notifier = inject(Notifier);

  private readonly titleEl = viewChild<ElementRef<HTMLInputElement>>('titleEl');

  protected readonly switcher = SWITCHER;
  protected readonly scale = LucideScale;
  protected readonly linkIcon = LucideLink2;
  protected readonly tagIcon = LucideTag;
  protected readonly userIcon = LucideCircleUser;
  protected readonly teamIcon = LucideUsers;
  protected readonly calendarIcon = LucideCalendar;
  protected readonly closeIcon = LucideX;

  protected readonly open = computed(() => this.ui.modal() === 'create');
  protected readonly kind = signal<CreateKind>('issue');
  protected readonly composer = computed(() => SWITCHER.find((k) => k.kind === this.kind()));
  protected readonly kindLabel = computed(
    () => this.composer()?.label ?? EXTRA[this.kind()]?.label ?? this.kind().replace('-', ' '),
  );
  protected readonly extraIcon = computed(() => EXTRA[this.kind()]?.icon ?? LucideBuilding2);

  // ── form state (shared across kinds; reset on open, carried over on switch) ──
  protected readonly title = signal('');
  protected readonly text = signal('');
  protected readonly text2 = signal('');
  protected readonly deltaUrl = signal('');
  protected readonly tags = signal('');
  protected readonly priority = signal<string>('none');
  // issue
  protected readonly issueStatus = signal<string>('backlog');
  protected readonly issueKind = signal<string>('bug');
  /** Story points as a string ('' = none). */
  protected readonly issueEstimate = signal('');
  /** The workspace turned estimates off: do not offer the chip. */
  protected readonly showEstimate = computed(() => this.store.estimateScale() !== 'none');
  protected readonly issueEstimateChoices = computed<PickOption[]>(() =>
    issueEstimateOptions(undefined, this.store.estimateScale()),
  );
  protected readonly assigneeId = signal('');
  protected readonly teamId = signal('');
  protected readonly workstreamIds = signal<string[]>([]);
  // workstream
  protected readonly wsStatus = signal(''); // '' = derived
  protected readonly ownerTeamId = signal('');
  protected readonly accountableId = signal('');
  protected readonly targetDate = signal<Date | undefined>(undefined);
  protected readonly repositoryIds = signal<string[]>([]);
  protected readonly issueIds = signal<string[]>([]);
  // decision
  protected readonly workstreamId = signal('');
  protected readonly decisionStatus = signal<string>('proposed');
  // team / repository / view
  protected readonly teamKey = signal('');
  private teamKeyTouched = false;
  protected readonly gitProvider = signal<string>('github');
  protected readonly viewEntity = signal<string>('workstream');
  protected readonly shared = signal(true);
  private viewExtras: {
    filters?: ViewFilter[];
    sort?: { field: string; direction: 'asc' | 'desc' };
    groupBy?: string;
    layout?: ViewLayout;
  } = {};
  protected readonly viewPreset = signal(false);
  protected readonly viewSummary = signal('');

  protected readonly createMore = signal(false);
  protected readonly busy = signal(false);
  private readonly submitted = signal(false);
  private readonly draftAttempt = signal(false);

  // ── options ──
  protected readonly priorityOptions: PickOption[] = PRIORITIES.map((p) => ({
    value: p,
    label: PRIORITY_META[p].label,
    kind: 'priority',
  }));
  protected readonly issueStatusOptions: PickOption[] = ISSUE_STATUSES.map((s) => ({
    value: s,
    label: ISSUE_STATUS_META[s].label,
    kind: 'status',
    statusEntity: 'issue',
  }));
  protected readonly wsStatusOptions: PickOption[] = WORKSTREAM_STATUS_FLOW.map((s) => ({
    value: s,
    label: WORKSTREAM_STATUS_META[s].label,
    kind: 'status',
    statusEntity: 'workstream',
  }));
  protected readonly issueKindOptions: PickOption[] = ISSUE_KINDS.map((k) => ({
    value: k,
    label: ISSUE_KIND_META[k].label,
    hint: ISSUE_KIND_META[k].prefix,
  }));
  protected readonly decisionStatusOptions: PickOption[] = [
    { value: 'proposed', label: 'Proposed', kind: 'status' },
    { value: 'accepted', label: 'Accepted', kind: 'status' },
  ];
  protected readonly gitProviderOptions: Option[] = [
    { value: 'github', label: 'GitHub' },
    { value: 'gitlab', label: 'GitLab' },
  ];
  protected readonly viewEntityOptions: Option[] = [
    { value: 'workstream', label: 'Workstreams' },
    { value: 'issue', label: 'Issues' },
    { value: 'decision', label: 'Decisions' },
  ];

  protected readonly teamOptions = computed<PickOption[]>(() =>
    this.store.teams().map((t) => ({ value: t.id, label: t.name, kind: 'team', hint: t.key })),
  );
  protected readonly userOptions = computed<PickOption[]>(() =>
    this.store
      .users()
      .map((u) => ({ value: u.id, label: u.name, kind: 'user', search: `${u.name} ${u.email}` })),
  );
  protected readonly repoOptions = computed<PickOption[]>(() =>
    this.store
      .repositories()
      .map((r) => ({ value: r.id, label: r.fullName, kind: 'repo', provider: r.provider })),
  );
  /** Open workstreams first (hexagon glyphs). */
  protected readonly workstreamOptions = computed<PickOption[]>(() => {
    const done = (s: WorkstreamStatus) => s === 'shipped' || s === 'canceled';
    return [...this.store.workstreams()]
      .sort(
        (a, b) =>
          Number(done(a.status)) - Number(done(b.status)) ||
          a.key.localeCompare(b.key, undefined, { numeric: true }),
      )
      .map((w) => ({
        value: w.id,
        label: w.title,
        hint: w.key,
        search: `${w.key} ${w.title}`,
        kind: 'status' as const,
        status: w.status,
        statusEntity: 'workstream' as const,
      }));
  });
  /** Open issues (circle glyphs); closed ones only when already selected. */
  protected readonly issueOptions = computed<PickOption[]>(() => {
    const picked = new Set(this.issueIds());
    return this.store
      .issues()
      .filter((i) => picked.has(i.id) || (i.status !== 'done' && i.status !== 'canceled'))
      .map((i) => ({
        value: i.id,
        label: i.title,
        hint: i.key,
        search: `${i.key} ${i.title}`,
        kind: 'status' as const,
        status: i.status,
        statusEntity: 'issue' as const,
      }));
  });

  protected readonly titlePlaceholder = computed(() => {
    switch (this.kind()) {
      case 'workstream':
        return 'Outcome, e.g. Stabilize authentication before v2';
      case 'decision':
        return 'Decision, e.g. Use opaque session tokens';
      default:
        return 'Issue title';
    }
  });
  protected readonly bodyPlaceholder = computed(() => {
    switch (this.kind()) {
      case 'workstream':
        return 'What does done look like? Markdown supported.';
      case 'decision':
        return 'What was decided?';
      default:
        return 'Add a description, steps to reproduce, links… Markdown supported.';
    }
  });

  constructor() {
    // Reset the form from the context defaults each time the dialog opens.
    effect(() => {
      if (!this.open()) return;
      const kind = this.ui.createKind();
      const defaults = this.ui.createDefaults();
      untracked(() => this.reset(kind, defaults));
    });
  }

  private reset(kind: CreateKind, d: Record<string, unknown>): void {
    this.kind.set(kind);
    this.title.set(asStr(d['title']) || asStr(d['name']));
    this.text.set(asStr(d['body']) || asStr(d['description']) || asStr(d['statement']));
    this.text2.set(asStr(d['rationale']));
    this.deltaUrl.set(asStr(d['deltaThreadUrl']));
    this.tags.set(asTags(d['tags']).join(', '));
    this.priority.set(oneOf(PRIORITIES, d['priority']) ?? 'none');

    this.issueStatus.set(oneOf(ISSUE_STATUSES, d['status']) ?? 'backlog');
    this.issueKind.set(oneOf(ISSUE_KINDS, d['kind']) ?? 'bug');
    this.issueEstimate.set(
      typeof d['estimate'] === 'number' && d['estimate'] >= 0 ? String(d['estimate']) : '',
    );
    this.assigneeId.set(
      this.store.userById().has(asStr(d['assigneeId'])) ? asStr(d['assigneeId']) : '',
    );
    this.teamId.set(asStr(d['teamId']) || asStr(d['ownerTeamId']) || this.defaultTeam());
    this.workstreamIds.set(
      asArr(d['workstreamIds']).flatMap((r) => this.store.getWorkstream(r)?.id ?? []),
    );

    const ws = oneOf(WORKSTREAM_STATUS_FLOW, d['status']);
    this.wsStatus.set(ws && ws !== 'planned' ? ws : '');
    const myTeam =
      this.defaultTeam() || (this.store.myTeams()[0]?.id ?? this.store.teams()[0]?.id ?? '');
    this.ownerTeamId.set(asStr(d['ownerTeamId']) || asStr(d['teamId']) || myTeam);
    this.accountableId.set(
      this.store.userById().has(asStr(d['accountableUserId'])) ? asStr(d['accountableUserId']) : '',
    );
    this.targetDate.set(undefined);
    this.repositoryIds.set(
      asArr(d['repositoryIds']).filter((id) => this.store.repositoryById().has(id)),
    );
    this.issueIds.set(asArr(d['issueIds']).flatMap((r) => this.store.getIssue(r)?.id ?? []));

    this.workstreamId.set(this.store.getWorkstream(asStr(d['workstreamId']))?.id ?? '');
    this.decisionStatus.set(
      d['status'] === 'accepted' && kind === 'decision' ? 'accepted' : 'proposed',
    );

    this.teamKey.set('');
    this.teamKeyTouched = false;
    this.gitProvider.set('github');
    const entity = oneOf(VIEW_ENTITIES, d['entity']);
    this.viewEntity.set(entity ?? 'workstream');
    this.shared.set(this.canShare() && (typeof d['shared'] === 'boolean' ? d['shared'] : true));
    this.viewExtras = {
      filters: Array.isArray(d['filters']) ? (d['filters'] as ViewFilter[]) : undefined,
      sort:
        d['sort'] &&
        typeof d['sort'] === 'object' &&
        typeof (d['sort'] as { field?: unknown }).field === 'string'
          ? (d['sort'] as { field: string; direction: 'asc' | 'desc' })
          : undefined,
      groupBy: asStr(d['groupBy']) || undefined,
      layout: oneOf(VIEW_LAYOUTS, d['layout']),
    };
    this.viewPreset.set(
      !!entity &&
        (!!this.viewExtras.filters || !!this.viewExtras.sort || !!this.viewExtras.groupBy),
    );
    this.viewSummary.set(this.describeViewExtras());

    this.submitted.set(false);
    this.draftAttempt.set(false);
    this.busy.set(false);
  }

  private describeViewExtras(): string {
    const x = this.viewExtras;
    const bits: string[] = [];
    if (x.filters?.length)
      bits.push(`${x.filters.length} filter${x.filters.length === 1 ? '' : 's'}`);
    if (x.sort) bits.push(`sorted by ${x.sort.field} ${x.sort.direction}`);
    if (x.groupBy) bits.push(`grouped by ${x.groupBy}`);
    if (x.layout) bits.push(`${x.layout} layout`);
    return bits.join(' · ');
  }

  /** The breadcrumb team: the issue's team, or the workstream's owner team. */
  protected readonly headerTeamId = computed(() =>
    this.kind() === 'workstream' ? this.ownerTeamId() : this.teamId(),
  );

  /** What the draft already has, so quick suggestions skip no-ops. */
  protected readonly suggestionCurrent = computed(() => ({
    priority: this.priority(),
    kind: this.issueKind(),
    estimate: this.issueEstimate() === '' ? undefined : Number(this.issueEstimate()),
    teamId: this.teamId(),
    assigneeId: this.assigneeId(),
    workstreamId: this.workstreamIds(),
  }));

  protected addQuestion(question: string): void {
    this.text.update((t) => `${t.trimEnd()}${t.trim() ? '\n\n' : ''}${question}\n`);
  }

  protected setHeaderTeam(id: string): void {
    // Keep both in step so switching kind carries the team over.
    if (id || this.kind() === 'issue') this.teamId.set(id);
    if (id) this.ownerTeamId.set(id);
  }

  protected opt(v: string): string[] {
    return v ? [v] : [];
  }

  protected setOne(sig: { set: (v: string) => void }, values: string[]): void {
    if (values[0]) sig.set(values[0]);
  }

  protected onSwitch(next: ComposerKind): void {
    if (next === this.kind()) return;
    // Title / description / priority carry over; kind-specific properties keep their own state.
    this.kind.set(next);
    this.submitted.set(false);
    this.ui.createKind.set(next);
    this.focusTitle();
  }

  protected onClosed(): void {
    if (this.ui.modal() === 'create') this.ui.closeModal();
  }

  protected onTeamName(v: string): void {
    this.title.set(v);
    if (!this.teamKeyTouched) {
      const words = v.trim().split(/\s+/);
      const initials = words.map((w) => w[0] ?? '').join('');
      this.teamKey.set(
        (words.length > 1 ? initials : v.trim().slice(0, 4))
          .toUpperCase()
          .replace(/[^A-Z0-9]/g, '')
          .slice(0, 8),
      );
    }
  }

  protected onTeamKey(v: string): void {
    this.teamKeyTouched = true;
    this.teamKey.set(v);
  }

  protected err(field: 'title' | 'team' | 'statement' | 'key' | 'delta'): string | null {
    if (!this.submitted()) return null;
    if (this.draftAttempt() && (field === 'delta' || field === 'statement')) return null;
    const k = this.kind();
    switch (field) {
      case 'title':
        return this.title().trim()
          ? null
          : k === 'issue' || k === 'workstream' || k === 'decision'
            ? 'Give it a title.'
            : 'Required.';
      case 'delta':
        if (k !== 'workstream' || !this.deltaEnabled()) return null;
        return /^https:\/\/([a-z0-9-]+\.)*delta\.dev(\/|$)/i.test(this.deltaUrl().trim())
          ? null
          : 'Link the Delta thread: an https link on delta.dev.';
      case 'team':
        if (k !== 'workstream') return null;
        return this.ownerTeamId() ? null : 'Pick the owner team.';
      case 'statement':
        if (k !== 'decision') return null;
        return this.text().trim() ? null : 'Say what was decided.';
      case 'key':
        if (k !== 'team') return null;
        return /^[A-Z][A-Z0-9]{1,7}$/.test(this.teamKey().toUpperCase())
          ? null
          : '2 to 8 letters or digits, starting with a letter.';
    }
  }

  private valid(): boolean {
    return (['title', 'team', 'statement', 'key', 'delta'] as const).every((f) => !this.err(f));
  }

  private focusTitle(): void {
    setTimeout(() => this.titleEl()?.nativeElement.focus());
  }

  protected applyIssueSuggestion(suggestion: AiIssueDraftSuggestion): void {
    switch (suggestion.field) {
      case 'priority':
        this.priority.set(suggestion.value);
        break;
      case 'kind':
        this.issueKind.set(suggestion.value);
        break;
      case 'estimate':
        this.issueEstimate.set(String(suggestion.value));
        break;
      case 'teamId':
        this.teamId.set(suggestion.value);
        break;
      case 'assigneeId':
        this.assigneeId.set(suggestion.value);
        break;
      case 'workstreamId':
        this.workstreamIds.update((ids) =>
          ids.includes(suggestion.value) ? ids : [...ids, suggestion.value],
        );
        break;
    }
  }

  protected saveDraft(ev: Event): void {
    this.draftAttempt.set(true);
    void this.submit(ev, true);
  }

  protected async submit(ev: Event, asDraft = false): Promise<void> {
    ev.preventDefault();
    ev.stopPropagation();
    if (this.busy()) return;
    if (asDraft) {
      if (!this.title().trim() || (this.kind() === 'workstream' && !this.ownerTeamId())) {
        this.submitted.set(true);
        return;
      }
    } else {
      this.draftAttempt.set(false);
      this.submitted.set(true);
      if (!this.valid()) return;
    }
    this.busy.set(true);
    try {
      const slug = this.store.slug();
      if (!slug) return;
      const title = this.title().trim();
      let done: { label: string; path: string[] } | undefined;
      switch (this.kind()) {
        case 'issue': {
          const status = asDraft ? 'draft' : (this.issueStatus() as IssueStatus);
          const i = await this.store.createIssue({
            kind: this.issueKind() as IssueKind,
            title,
            body: this.text().trim() || undefined,
            priority: this.priority() as Priority,
            status,
            teamId: this.teamId() || undefined,
            assigneeId: this.assigneeId() || undefined,
            estimate: this.issueEstimate() === '' ? undefined : Number(this.issueEstimate()),
          });
          if (i) {
            const links = this.workstreamIds();
            // Keep the chosen status: linking would otherwise move backlog/todo to in_progress.
            if (links.length) await this.store.linkIssue(i.id, { workstreamIds: links, status });
            done = { label: `${i.key} created`, path: ['issues', i.key] };
          }
          break;
        }
        case 'workstream': {
          const w = await this.store.createWorkstream({
            title,
            description: this.text().trim() || undefined,
            deltaThreadUrl: this.deltaEnabled() ? this.deltaUrl().trim() : undefined,
            ownerTeamId: this.ownerTeamId(),
            priority: this.priority() as Priority,
            accountableUserId: this.accountableId() || undefined,
            repositoryIds: this.repositoryIds().length ? this.repositoryIds() : undefined,
            targetDate: this.targetDate()?.toISOString(),
            statusOverride: asDraft ? 'draft' : (this.wsStatus() as WorkstreamStatus) || undefined,
          });
          if (w) {
            await Promise.all(
              this.issueIds().map((id) => this.store.linkIssue(id, { workstreamIds: [w.id] })),
            );
            done = { label: `${w.key} created`, path: ['workstreams', w.key] };
          }
          break;
        }
        case 'decision': {
          const d = await this.store.proposeDecision({
            title,
            statement: this.text().trim(),
            rationale: this.text2().trim() || undefined,
            status: asDraft ? 'draft' : (this.decisionStatus() as 'proposed' | 'accepted'),
            originWorkstreamId: this.workstreamId() || undefined,
            tags: asTags(this.tags()),
          });
          if (d)
            done = {
              label: asDraft ? `${d.key} saved as draft` : `${d.key} recorded`,
              path: ['decisions', d.key],
            };
          break;
        }
        case 'team': {
          const t = await this.store.createTeam({
            name: title,
            key: this.teamKey().toUpperCase(),
            description: this.text().trim() || undefined,
          });
          if (t) done = { label: `Team ${t.name} created`, path: ['teams', t.key] };
          break;
        }
        case 'repository': {
          const r = await this.store.createRepository({
            provider: this.gitProvider() as GitProvider,
            fullName: title,
            defaultBranch: this.text().trim() || undefined,
          });
          if (r) done = { label: `${r.fullName} added`, path: ['projects', r.id] };
          break;
        }
        case 'view': {
          const v = await this.store.createView({
            name: title,
            entity: this.viewEntity() as ViewEntity,
            shared: this.shared() && this.canShare(),
            ...this.viewExtras,
          });
          if (v) done = { label: `View ${v.name} saved`, path: ['views', v.id] };
          break;
        }
        default:
          return;
      }
      if (!done) return; // the store already toasted the failure; keep the form open
      if (asDraft && this.kind() === 'issue') done.label = `${done.path[1]} saved as draft`;
      if (asDraft && this.kind() === 'workstream') done.label = `${done.path[1]} saved as draft`;
      const commands = ['/', slug, ...done.path];
      // Linear behaviour: stay where you are, offer "Open" in the toast.
      // Views and teams are destinations of their own, so those still navigate.
      const navigate =
        this.kind() === 'view' || this.kind() === 'team' || this.kind() === 'repository';
      this.notifier.success(done.label, {
        description: navigate ? undefined : title,
        action: navigate
          ? undefined
          : { label: 'Open', run: () => void this.router.navigate(commands) },
      });
      if (this.createMore() && this.composer()) {
        this.title.set('');
        this.text.set('');
        this.text2.set('');
        this.issueIds.set([]);
        this.submitted.set(false);
        this.draftAttempt.set(false);
        this.focusTitle();
        return;
      }
      this.ui.closeModal();
      if (navigate) await this.router.navigate(commands);
    } finally {
      this.busy.set(false);
    }
  }
}
