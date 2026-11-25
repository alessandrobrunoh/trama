// The property column of the task page (v3 "06 Task detail" / "07 Subtask detail"): the /trama command, the
// properties as hairline rows (label in mono 10 faint, value beside it), the estimate and the time against it,
// the thread, the one-thread-per-task rule. What the frames do not show (type, reporter, link, milestone, the
// time entries…) sits in two collapsed groups at the bottom, so nothing the page could edit is lost.
import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { differenceInCalendarDays, format, parseISO } from 'date-fns';
import {
  LucideCircleUserRound,
  LucideCopy,
  LucideDynamicIcon,
  LucideExternalLink,
  LucideFolder,
  LucideListChecks,
  LucidePencil,
  LucidePlay,
  LucideShapes,
  LucideSquare,
  LucideTag,
  LucideX,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import {
  Clipboard,
  TimeEntriesStore,
  TramaStore,
  estimateOptions,
  formatEstimate,
  formatSpan,
} from '../../core';
import { AgoPipe } from '../../shared/ago';
import { EntityChip } from '../../shared/entity-chip';
import { InlineText } from '../../shared/inline-edit';
import { IssueKindLabel } from '../../shared/issue';
import { LabelPicker } from '../../shared/label-picker';
import { Picker } from '../../shared/picker';
import { projectOptions } from '../../shared/picker-options';
import { PropertyRow } from '../../shared/property-row';
import { sourceRef } from '../../shared/v3';
import { IssueMilestoneProp } from '../milestones/milestone-chips';
import { REF_MIN, trackedByIssue } from '../stats/flow-stats';
import { IssueActions } from './issue-actions';
import { IssueExternalRef } from './issue-external-ref';
import { SOURCE_LABEL, issueEstimateOptions, issueKindOptions } from './issue-model';
import { IssueProp } from './issue-prop';
import { IssueSection } from './issue-section';
import { IssueThreadLink } from './issue-thread-link';
import { issueCost } from './issue-cost';
import { TaskChildren } from './task-children';
import { TaskStatusWizard } from './task-status-wizard';
import { TaskTime } from './task-time';
import { trackedOn } from './task-time-model';

/** One hairline row of the column: a 84px mono label and the value beside it. */
@Component({
  selector: 'app-task-prop',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'border-border flex min-w-0 items-center gap-2.5 border-b px-[18px] py-2.5' },
  template: `
    <span class="text-faint w-[84px] shrink-0 font-mono text-[10px] leading-[12px]">{{ label() }}</span>
    <div class="flex min-w-0 flex-1 items-center gap-1.5"><ng-content /></div>
  `,
})
export class TaskProp {
  readonly label = input('');
}

@Component({
  selector: 'app-task-inspector',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    HlmButtonImports,
    HlmTooltip,
    NgTemplateOutlet,
    RouterLink,
    LucideDynamicIcon,
    LabelPicker,
    Picker,
    InlineText,
    EntityChip,
    IssueKindLabel,
    PropertyRow,
    AgoPipe,
    IssueMilestoneProp,
    IssueExternalRef,
    IssueProp,
    IssueSection,
    IssueThreadLink,
    TaskProp,
    TaskStatusWizard,
    TaskTime,
  ],
  host: { class: 'block min-w-0' },
  template: `
    @if (issue(); as i) {
      <div class="flex flex-col">
        <!-- How to start it in Delta (a subtask that already has its own thread does not need it). -->
        @if (!parent() || !i.threadUrl) {
          <div class="border-border flex flex-col gap-2 border-b px-[18px] py-3.5">
            <span class="text-foreground font-mono text-[10px] leading-[12px]">WORK ON IT IN DELTA</span>
            <button
              type="button"
              class="bg-background border-border hover:border-border-strong focus-visible:ring-ring flex w-full items-center gap-2 border px-2.5 py-2 text-left outline-none focus-visible:ring-2"
              aria-label="Copy the /trama command"
              hlmTooltip="Copy command · ⇧C"
              (click)="copyCommand()"
            >
              <span class="text-foreground font-mono text-[12px] leading-[15px]">/trama {{ i.key }}</span>
              <span class="flex-1"></span>
              <svg [lucideIcon]="copyIcon" [size]="14" class="text-muted-foreground shrink-0" aria-hidden="true"></svg>
            </button>
          </div>
        }

        <app-task-prop label="STATUS">
          <app-issue-prop [issue]="i" field="status" chip />
          @if (canEdit()) {
            <app-task-status-wizard class="ml-auto" variant="link" [issue]="i" />
          }
        </app-task-prop>

        @if (!parent()) {
          <app-task-prop label="PRIORITY">
            <app-issue-prop [issue]="i" field="priority" chip />
          </app-task-prop>
        }

        <app-task-prop label="ASSIGNEE">
          <app-issue-prop [issue]="i" field="assignee" showLabel chip [avatarSize]="22" />
          @if (canEdit() && store.me(); as me) {
            @if (i.assigneeId !== me.id) {
              <button
                type="button"
                class="text-faint hover:text-foreground ml-auto shrink-0 font-mono text-[10.5px]"
                hlmTooltip="Assign to me · I"
                (click)="actions.setAssignee([i.id], me.id)"
              >
                Me
              </button>
            }
          }
        </app-task-prop>

        @if (!parent()) {
          <app-task-prop label="PROJECT">
            <app-picker
              variant="bare"
              label="Project"
              placeholder="No project"
              [clearable]="true"
              clearLabel="Remove from project"
              [disabled]="!canEdit()"
              [options]="projects()"
              [value]="i.projectId ? [i.projectId] : []"
              triggerClass="h-7 gap-1.5 text-[12.5px]"
              (valueChange)="store.updateIssue(i.id, { projectId: $event[0] ?? null })"
            >
              @if (project(); as p) {
                <span class="size-2 shrink-0" [style.background]="p.color || 'var(--muted-foreground)'" aria-hidden="true"></span>
                <span class="text-foreground truncate">{{ p.name }}</span>
              } @else {
                <span class="text-faint">No project</span>
              }
            </app-picker>
          </app-task-prop>
        }

        <app-task-prop label="DUE">
          @if (due(); as d) {
            <span class="text-[12.5px] leading-4" [class]="d.late ? 'text-red' : 'text-foreground'">{{ d.text }}</span>
          } @else {
            <span class="text-faint text-[12.5px] leading-4">—</span>
          }
        </app-task-prop>

        <!-- Estimate: the number, what such a task usually takes, and the time tracked against it. -->
        @if (!parent() && showEstimate()) {
          <div class="border-border flex flex-col gap-2.5 border-b px-[18px] py-3.5">
            <div class="flex items-center gap-2.5">
              <span class="text-faint w-[84px] shrink-0 font-mono text-[10px] leading-[12px]">ESTIMATE</span>
              <app-picker
                #estimatePicker
                variant="bare"
                label="Estimate"
                placeholder="No estimate"
                [clearable]="true"
                [clearAlways]="true"
                clearLabel="No estimate"
                [searchable]="false"
                [disabled]="!canEdit()"
                [options]="estimateOpts()"
                [value]="i.estimate !== undefined && i.estimate !== null ? ['' + i.estimate] : []"
                triggerClass="h-8 px-0"
                (valueChange)="setEstimate(i.id, $event[0])"
              >
                <span class="font-title text-foreground text-[26px] leading-[30px]">{{ estimateText() }}</span>
              </app-picker>
              <span class="border-border text-muted-foreground border px-1.5 py-px font-mono text-[10px] leading-[13px]">{{ scale() }}</span>
              <span class="flex-1"></span>
              @if (canEdit()) {
                <button
                  type="button"
                  class="text-faint hover:text-foreground focus-visible:ring-ring inline-flex size-6 items-center justify-center outline-none focus-visible:ring-2"
                  aria-label="Change the estimate"
                  hlmTooltip="Change estimate"
                  (click)="estimatePicker.open()"
                >
                  <svg [lucideIcon]="pencilIcon" [size]="13" aria-hidden="true"></svg>
                </button>
              }
            </div>
            @if (hint(); as h) {
              <p class="text-muted-foreground font-mono text-[10.5px] leading-[14px]">{{ h }}</p>
            }
            <div class="flex flex-col gap-[5px]">
              <div class="flex items-center gap-1.5">
                <span class="text-faint font-mono text-[10px] leading-[12px]">TRACKED</span>
                <span class="text-foreground text-[12.5px] leading-4">{{ trackedText() }}</span>
                @if (typical()) {
                  <span class="text-faint font-mono text-[10.5px] leading-[13px]">of ~{{ span(typical()!) }}</span>
                }
                <span class="flex-1"></span>
                <ng-container [ngTemplateOutlet]="timerButton" />
              </div>
              <div class="bg-secondary relative h-1.5 w-full" role="img" [attr.aria-label]="trackedLabel()">
                <span class="bg-foreground absolute inset-y-px left-0" [style.width.%]="trackedPct()"></span>
              </div>
            </div>
            @if (rollup(); as r) {
              <button
                type="button"
                class="bg-yellow/[0.07] border-yellow/25 text-yellow flex w-full items-center gap-2 border px-[9px] py-[7px] text-left font-mono text-[10.5px] leading-[13px] disabled:cursor-default"
                [disabled]="!canEdit() || r.next === null"
                (click)="r.next !== null && setEstimate(i.id, '' + r.next)"
              >
                <svg [lucideIcon]="subtasksIcon" [size]="12" class="shrink-0" aria-hidden="true"></svg>
                <span>subtasks add up to {{ r.sum }}{{ r.next !== null ? ' · raise to ' + r.next + '?' : '' }}</span>
              </button>
            }
          </div>
        } @else if (parent()) {
          <!-- A subtask: its estimate is the label, the time tracked against it is the value. -->
          <div class="border-border flex flex-col gap-2 border-b px-[18px] py-2.5">
            <div class="flex items-center gap-2.5">
              <app-picker
                #estimatePicker
                variant="bare"
                label="Estimate"
                placeholder="No estimate"
                [clearable]="true"
                [clearAlways]="true"
                clearLabel="No estimate"
                [searchable]="false"
                [disabled]="!canEdit() || !showEstimate()"
                [options]="estimateOpts()"
                [value]="i.estimate !== undefined && i.estimate !== null ? ['' + i.estimate] : []"
                triggerClass="h-5 w-[84px] justify-start px-0"
                (valueChange)="setEstimate(i.id, $event[0])"
              >
                <span class="text-faint hover:text-muted-foreground font-mono text-[10px] leading-[12px]">EST {{ estimateText() }}</span>
              </app-picker>
              <span class="text-foreground text-[12.5px] leading-4">{{ trackedText() }}</span>
              @if (typical()) {
                <span class="text-faint font-mono text-[10.5px] leading-[13px]">of ~{{ span(typical()!) }}</span>
              }
              <span class="flex-1"></span>
              <ng-container [ngTemplateOutlet]="timerButton" />
            </div>
            <div class="bg-secondary h-[3px] w-full" role="img" [attr.aria-label]="trackedLabel()">
              <span class="bg-foreground block h-full" [style.width.%]="trackedPct()"></span>
            </div>
          </div>
        }

        @if (!parent()) {
          <app-task-prop label="LABELS">
            <app-label-picker
              scope="issue"
              triggerClass="min-h-6 py-0"
              [disabled]="!canEdit()"
              [value]="i.labels"
              (valueChange)="store.updateIssue(i.id, { labels: $event })"
            />
          </app-task-prop>
        } @else if (parentIssue(); as p) {
          <app-task-prop label="PARENT">
            <a
              [routerLink]="['/', slug(), 'tasks', p.key]"
              class="text-foreground hover:underline font-mono text-[11px] leading-[14px]"
              [attr.title]="p.title"
              >{{ p.key }}</a
            >
          </app-task-prop>
        }

        <app-task-prop label="SOURCE">
          @let src = source();
          @if (parent() && src.kind === 'trama') {
            <span class="text-muted-foreground font-mono text-[11px] leading-[14px]">Trama only · not synced</span>
          } @else {
            @if (src.kind === 'github') {
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-muted-foreground shrink-0" aria-hidden="true">
                <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" />
                <path d="M9 18c-4.51 2-5-2-7-2" />
              </svg>
            }
            @if (src.url) {
              <a
                [href]="src.url"
                target="_blank"
                rel="noopener noreferrer"
                class="text-foreground font-mono text-[11px] leading-[14px] hover:underline"
                >{{ src.label }} ↗</a
              >
            } @else {
              <span class="text-foreground font-mono text-[11px] leading-[14px]">{{ src.label }}</span>
            }
          }
        </app-task-prop>

        <app-task-prop label="THREAD">
          <app-issue-thread-link class="min-w-0 flex-1" variant="row" [issue]="i" [canEdit]="canEdit()" />
        </app-task-prop>

        <div class="flex flex-col gap-1.5 px-[18px] py-3.5">
          @if (parent()) {
            <span class="text-foreground font-mono text-[10px] leading-[12px]">SUBTASKS = MORE THREADS</span>
            <p class="text-muted-foreground text-xs leading-[19px]">
              The parent keeps its own thread. This subtask was started with /trama {{ i.key }} and records a
              separate piece of work.
            </p>
          } @else {
            <span class="text-foreground font-mono text-[10px] leading-[12px]">ONE THREAD PER TASK</span>
            <p class="text-muted-foreground text-xs leading-[19px]">
              @if (i.threadUrl) {
                To relink, run /trama {{ i.key }} in a new Delta thread — the agent will offer to create a subtask
                instead. Need parallel work? Use subtasks.
              } @else {
                Run /trama {{ i.key }} in a Delta thread to link it. One thread per task; need parallel work? Use
                subtasks.
              }
            </p>
          }
        </div>

        <div class="flex flex-col gap-1 px-[18px] pt-1.5 pb-3.5">
          <span class="text-faint font-mono text-[10.5px] leading-[13px]">Created {{ createdText() }}</span>
          <span class="text-faint font-mono text-[10.5px] leading-[13px]">Updated {{ i.updatedAt | ago }} ago</span>
        </div>

        <!-- Everything the frames leave out, out of the way. -->
        <app-issue-section class="border-border border-t" label="MORE">
          <div class="flex flex-col px-1.5">
            <app-property-row label="Type" [icon]="typeIcon" compact>
              <app-picker
                variant="bare"
                label="Type"
                [searchable]="false"
                [disabled]="!canEdit()"
                [options]="kindOpts"
                [value]="[i.kind]"
                triggerClass="h-7 px-1.5 text-[13px]"
                (valueChange)="actions.changeKind(i, $any($event[0]))"
              >
                <app-issue-kind [kind]="i.kind" showLabel />
              </app-picker>
            </app-property-row>
            @if (parent()) {
              <app-property-row label="Priority" compact>
                <app-issue-prop [issue]="i" field="priority" showLabel />
              </app-property-row>
              <app-property-row label="Project" [icon]="projectIcon" compact>
                <app-picker
                  variant="field"
                  triggerClass="min-h-7 py-0.5"
                  label="Project"
                  placeholder="No project"
                  [clearable]="true"
                  clearLabel="Remove from project"
                  [disabled]="!canEdit()"
                  [options]="projects()"
                  [value]="i.projectId ? [i.projectId] : []"
                  (valueChange)="store.updateIssue(i.id, { projectId: $event[0] ?? null })"
                />
              </app-property-row>
              <app-property-row label="Labels" [icon]="labelIcon" compact>
                <app-label-picker
                  scope="issue"
                  triggerClass="min-h-7 py-0.5"
                  [disabled]="!canEdit()"
                  [value]="i.labels"
                  (valueChange)="store.updateIssue(i.id, { labels: $event })"
                />
              </app-property-row>
            }
            <app-issue-milestone-prop [issue]="i" />
            <app-property-row label="Source" compact>
              <span class="px-1.5 text-[13px]">{{ sourceLabel() }}</span>
            </app-property-row>
            <app-property-row label="Reporter" [icon]="reporterIcon" compact>
              <app-inline-text
                class="min-w-0 flex-1"
                label="reporter"
                placeholder="Who reported it?"
                textClass="text-[13px]"
                [allowEmpty]="true"
                [value]="reporter()"
                [canEdit]="canEdit() && !i.reporterId"
                (save)="store.updateIssue(i.id, { reporterName: $event || null })"
              />
            </app-property-row>
            <app-property-row label="Link" compact>
              <app-inline-text
                class="min-w-0 flex-1"
                label="external link"
                placeholder="Paste a URL"
                textClass="text-[13px]"
                [allowEmpty]="true"
                [value]="i.externalUrl ?? ''"
                [canEdit]="canEdit()"
                (save)="saveUrl(i.id, $event)"
              />
              @if (i.externalUrl) {
                <a
                  [href]="i.externalUrl"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="text-muted-foreground hover:text-foreground shrink-0"
                  aria-label="Open external link"
                  hlmTooltip="Open link"
                >
                  <svg [lucideIcon]="openIcon" [size]="13"></svg>
                </a>
              }
            </app-property-row>
            <app-issue-external-ref [issue]="i" [canEdit]="canEdit()" />
            <app-property-row label="Duplicate" compact>
              @if (duplicate(); as dup) {
                <app-entity-chip type="issue" [ref]="dup.id" compact />
                @if (canEdit()) {
                  <button
                    type="button"
                    class="text-muted-foreground hover:text-foreground ml-auto"
                    aria-label="Clear duplicate"
                    hlmTooltip="Not a duplicate"
                    (click)="actions.clearDuplicate(i.id)"
                  >
                    <svg [lucideIcon]="xIcon" [size]="13"></svg>
                  </button>
                }
              } @else if (canEdit()) {
                <button
                  type="button"
                  class="text-muted-foreground hover:bg-hover hover:text-foreground h-7 min-w-0 truncate px-1.5 text-left text-[13px] whitespace-nowrap"
                  (click)="actions.openPrompt('duplicate', [i.id])"
                >
                  Mark as duplicate…
                </button>
              } @else {
                <span class="text-muted-foreground px-1.5 text-[13px]">—</span>
              }
            </app-property-row>
            @if (duplicates().length) {
              <app-property-row label="Duplicates" compact>
                <span class="flex flex-wrap gap-1">
                  @for (d of duplicates(); track d.id) {
                    <app-entity-chip type="issue" [ref]="d.id" compact />
                  }
                </span>
              </app-property-row>
            }
          </div>
        </app-issue-section>

        <app-issue-section class="border-border border-t" label="TIME ENTRIES" [summary]="trackedText()">
          <div class="px-3 pt-2">
            <app-task-time [issue]="i" />
          </div>
        </app-issue-section>
      </div>

      <ng-template #timerButton>
        @if (canEdit()) {
          <button
            type="button"
            class="border-border hover:bg-hover focus-visible:ring-ring text-foreground flex size-[22px] shrink-0 items-center justify-center border outline-none focus-visible:ring-2 disabled:opacity-50"
            [attr.aria-label]="runningHere() ? 'Stop the timer' : 'Start the timer'"
            [hlmTooltip]="runningHere() ? 'Stop timer' : 'Start timer'"
            [disabled]="time.busy()"
            (click)="toggleTimer(i.id, i.projectId)"
          >
            <svg [lucideIcon]="runningHere() ? stopIcon : playIcon" [size]="11" aria-hidden="true"></svg>
          </button>
        }
      </ng-template>
    }
  `,
})
export class TaskInspector {
  protected readonly store = inject(TramaStore);
  protected readonly actions = inject(IssueActions);
  protected readonly time = inject(TimeEntriesStore);
  private readonly children = inject(TaskChildren);
  private readonly clipboard = inject(Clipboard);

  /** A task id or its key (`CORA-142`). */
  readonly idOrKey = input.required<string>();

  protected readonly openIcon = LucideExternalLink;
  protected readonly xIcon = LucideX;
  protected readonly copyIcon = LucideCopy;
  protected readonly pencilIcon = LucidePencil;
  protected readonly playIcon = LucidePlay;
  protected readonly stopIcon = LucideSquare;
  protected readonly subtasksIcon = LucideListChecks;
  protected readonly projectIcon = LucideFolder;
  protected readonly labelIcon = LucideTag;
  protected readonly typeIcon = LucideShapes;
  protected readonly reporterIcon = LucideCircleUserRound;
  protected readonly kindOpts = issueKindOptions();

  private readonly now = signal(Date.now());

  protected readonly slug = computed(() => this.store.slug() ?? '');
  protected readonly issue = computed(() => this.store.getIssue(this.idOrKey()));
  protected readonly canEdit = computed(() => this.store.can('member'));
  protected readonly parent = computed(() => !!this.issue()?.parentId);
  protected readonly parentIssue = computed(() => {
    const id = this.issue()?.parentId;
    return id ? this.store.issueById().get(id) : undefined;
  });
  protected readonly project = computed(() => this.store.getProject(this.issue()?.projectId));
  protected readonly source = computed(() => {
    const i = this.issue();
    return i ? sourceRef(i) : { kind: 'trama' as const, label: 'Trama', url: undefined };
  });

  protected readonly tracked = computed(() => {
    const id = this.issue()?.id;
    return id ? trackedOn(this.time.entries(), id, this.now()) : { todayMs: 0, totalMs: 0, runningMs: 0 };
  });
  protected readonly runningHere = computed(() => {
    const id = this.issue()?.id;
    return !!id && this.time.running()?.issueId === id;
  });
  private readonly cost = computed(() => {
    const i = this.issue();
    return i ? issueCost(i, this.store.issues(), trackedByIssue(this.time.entries())) : undefined;
  });
  /** What a task of this estimate usually takes (median of finished ones with tracked time). */
  protected readonly typical = computed(() => this.cost()?.compare?.typicalMs);

  protected readonly trackedText = computed(() => {
    const t = this.tracked().totalMs;
    return t ? formatSpan(t) : '0m';
  });
  protected readonly trackedPct = computed(() => {
    const typical = this.typical();
    const t = this.tracked().totalMs;
    if (!t) return 0;
    return typical ? Math.min(100, (t / typical) * 100) : 100;
  });
  protected readonly trackedLabel = computed(() => {
    const typical = this.typical();
    return typical
      ? `${this.trackedText()} tracked of about ${formatSpan(typical)}`
      : `${this.trackedText()} tracked`;
  });
  protected readonly hint = computed(() => {
    const c = this.cost()?.compare;
    if (!c) return '';
    const label = formatEstimate(c.estimate, this.store.estimateScale());
    return c.typicalMs
      ? `a ${label} usually takes ~${formatSpan(c.typicalMs)} · ${c.n} ${c.n === 1 ? 'task' : 'tasks'}`
      : `${c.n} of ${REF_MIN} finished tasks at ${label} with tracked time to compare`;
  });

  /** Direct subtasks that add up to more than the estimate: offer the next step of the scale. */
  protected readonly rollup = computed(() => {
    const i = this.issue();
    if (!i || i.estimate === undefined || i.estimate === null) return null;
    const sum = this.children.of(i.id).reduce((n, c) => n + (c.estimate ?? 0), 0);
    if (sum <= i.estimate) return null;
    const next = estimateOptions(this.store.estimateScale()).find((o) => o.value >= sum)?.value ?? null;
    return { sum: Math.round(sum * 100) / 100, next };
  });

  protected readonly due = computed(() => {
    const i = this.issue();
    if (!i?.dueDate) return null;
    const date = parseISO(i.dueDate);
    const days = differenceInCalendarDays(date, new Date());
    const day = format(date, 'MMM d');
    if (i.parentId) return { text: day, late: days < 0 };
    const rel =
      days === 0 ? 'today' : days === 1 ? 'tomorrow' : days > 0 ? `in ${days} days` : `${-days} ${days === -1 ? 'day' : 'days'} ago`;
    return { text: `${day} · ${rel}`, late: days < 0 };
  });

  protected readonly createdText = computed(() => {
    const i = this.issue();
    if (!i) return '';
    const by =
      i.source === 'manual' ? (this.reporter() || 'Trama') : `${SOURCE_LABEL[i.source] ?? i.source} sync`;
    return `${format(parseISO(i.createdAt), 'MMM d')} by ${by}`;
  });

  protected readonly scale = computed(() => this.store.estimateScale());
  protected readonly estimateText = computed(() => {
    const e = this.issue()?.estimate;
    return e === undefined || e === null ? '—' : formatEstimate(e, this.store.estimateScale());
  });

  protected readonly duplicate = computed(() => {
    const id = this.issue()?.duplicateOfId;
    return id ? this.store.issueById().get(id) : undefined;
  });
  /** Issues marked as duplicates of this one. */
  protected readonly duplicates = computed(() => {
    const id = this.issue()?.id;
    return id ? this.store.issues().filter((i) => i.duplicateOfId === id) : [];
  });
  protected readonly sourceLabel = computed(() => SOURCE_LABEL[this.issue()?.source ?? ''] ?? '');
  protected readonly reporter = computed(() => {
    const i = this.issue();
    if (!i) return '';
    return i.reporterId
      ? (this.store.getUser(i.reporterId)?.name ?? i.reporterName ?? '')
      : (i.reporterName ?? '');
  });
  protected readonly projects = computed(() => projectOptions(this.store, this.issue()?.projectId));
  /** Estimates are off in this workspace, but an issue that still has one keeps showing it. */
  protected readonly showEstimate = computed(
    () => this.store.estimateScale() !== 'none' || this.issue()?.estimate !== undefined,
  );
  protected readonly estimateOpts = computed(() =>
    issueEstimateOptions(this.issue()?.estimate, this.store.estimateScale()),
  );

  constructor() {
    void this.time.load();
    // Tick once a second, but only while a timer runs.
    effect((onCleanup) => {
      if (!this.time.running()) return;
      this.now.set(Date.now());
      const timer = setInterval(() => this.now.set(Date.now()), 1000);
      onCleanup(() => clearInterval(timer));
    });
  }

  protected span(ms: number): string {
    return formatSpan(ms);
  }

  protected copyCommand(): void {
    const key = this.issue()?.key;
    if (key) void this.clipboard.copy(`/trama ${key}`, 'Command copied');
  }

  protected toggleTimer(id: string, projectId: string | undefined): void {
    if (this.runningHere()) void this.time.stop();
    else void this.time.start({ issueId: id, projectId: projectId ?? null });
  }

  protected setEstimate(id: string, value: string | undefined): void {
    this.actions.setEstimate([id], value === undefined ? null : Number(value));
  }

  protected saveUrl(id: string, value: string): void {
    const v = value.trim();
    if (v && !/^https?:\/\//i.test(v)) {
      void this.store.updateIssue(id, { externalUrl: `https://${v}` });
      return;
    }
    void this.store.updateIssue(id, { externalUrl: v || null });
  }
}
