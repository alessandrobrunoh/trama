// One milestone in a project: diamond · name · "61% of ◬ 7" · target date · ⋯. Click expands the
// description, the milestone's own progress chart and its issues (assign / remove inline).
import { CdkDragHandle } from '@angular/cdk/drag-drop';
import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, input, signal, viewChild } from '@angular/core';
import {
  LucideCalendar,
  LucideChevronRight,
  LucideDynamicIcon,
  LucideEllipsis,
  LucideGripVertical,
  LucideMoveDown,
  LucideMoveUp,
  LucidePencil,
  LucidePlus,
  LucideText,
  LucideTrash2,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmContextMenuImports } from '@spartan-ng/helm/context-menu';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import { TramaStore, isOverdue, shortDate, type Milestone, type Project } from '../../core';
import { IssueBoard } from '../issues/issue-board';
import type { IssueProp } from '../issues/issue-model';
import { EditableMarkdown } from '../../shared/inline-edit';
import { Picker } from '../../shared/picker';
import { DATE_PRESETS, DatePicker } from '../../shared/date-picker';
import { issueOptions } from '../../shared/picker-options';
import { MilestoneActions } from './milestone-actions';
import { MilestoneIcon } from './milestone-icon';
import { fmtNum, progressLabel } from './milestone-model';
import { MilestoneInfo } from './milestone-stats';
import { ProgressChart } from './progress-chart';

@Component({
  selector: 'app-milestone-row',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CdkDragHandle,
    HlmButtonImports,
    HlmContextMenuImports,
    HlmDropdownMenuImports,
    HlmInputImports,
    HlmTooltip,
    LucideDynamicIcon,
    IssueBoard,
    EditableMarkdown,
    Picker,
    DatePicker,
    MilestoneIcon,
    ProgressChart,
  ],
  host: { class: 'block' },
  template: `
    @let m = ms();
    @let s = stats();
    <div
      class="group/ms hover:bg-secondary flex min-h-[42px] items-center gap-1.5 px-1.5 text-[13px]"
      [hlmContextMenuTrigger]="canEdit() ? menu : null"
    >
      <span
        cdkDragHandle
        class="text-muted-foreground flex size-5 shrink-0 cursor-grab items-center justify-center rounded opacity-0 group-hover/ms:opacity-70 max-md:hidden"
        [class.pointer-events-none]="!canEdit()"
        aria-hidden="true"
      >
        <svg [lucideIcon]="grip" [size]="13"></svg>
      </span>
      <button
        type="button"
        class="text-muted-foreground hover:bg-accent flex size-5 shrink-0 items-center justify-center rounded transition-transform"
        [class.rotate-90]="open()"
        [attr.aria-expanded]="open()"
        [attr.aria-label]="(open() ? 'Collapse ' : 'Expand ') + m.name"
        (click)="toggle()"
      >
        <svg [lucideIcon]="chevron" [size]="13"></svg>
      </button>
      <app-milestone-icon [fraction]="s.fraction" [state]="state()" [size]="15" />

      @if (renaming()) {
        <input
          #nameInput
          hlmInput
          class="h-7 min-w-0 flex-1 text-[13px]"
          aria-label="Milestone name"
          [value]="draft()"
          (input)="draft.set($any($event.target).value)"
          (keydown.enter)="commitRename()"
          (keydown.escape)="cancelRename($event)"
          (blur)="commitRename()"
        />
      } @else {
        <button type="button" class="min-w-0 flex-1 truncate text-left outline-none focus-visible:underline" (click)="toggle()">{{ m.name }}</button>
      }
      <span class="text-faint shrink-0 font-mono text-[10.5px] tabular-nums max-sm:hidden" [hlmTooltip]="tip()" position="bottom">{{ label() }}</span>

      <app-date-picker
        class="shrink-0"
        label="Milestone target date"
        align="end"
        triggerClass="h-6 gap-1 px-1.5 font-mono text-[10.5px] tabular-nums"
        [disabled]="!canEdit()"
        [value]="m.targetDate"
        (dateChange)="actions.setDate(m, $event)"
      >
        @if (m.targetDate) {
          <span [class.text-status-blocked]="late()" [class.text-muted-foreground]="!late()">{{ date() }}</span>
        } @else if (canEdit()) {
          <svg [lucideIcon]="cal" [size]="13" class="text-muted-foreground opacity-0 group-hover/ms:opacity-70"></svg>
        }
      </app-date-picker>
      @if (canEdit()) {
        <button hlmBtn variant="ghost" size="icon-xs" class="text-muted-foreground opacity-0 group-hover/ms:opacity-100 focus-visible:opacity-100 max-md:opacity-100" [attr.aria-label]="'Actions for ' + m.name" [hlmDropdownMenuTrigger]="menu">
          <svg [lucideIcon]="more" [size]="14"></svg>
        </button>
      } @else {
        <span class="size-6"></span>
      }
    </div>

    @if (open()) {
      <div class="bg-secondary flex flex-col gap-3 px-4 py-3 pl-10">
        <app-editable-markdown
          class="text-[13px]"
          label="milestone description"
          placeholder="Add a description for this milestone…"
          [value]="m.description ?? ''"
          [canEdit]="canEdit()"
          (save)="actions.setDescription(m, $event)"
        />
        @if (s.issues > 0) {
          <app-progress-chart [project]="project()" [milestone]="m" [height]="160" [compact]="true" />
        }
        <div>
          <div class="mb-1 flex items-center gap-2">
            <h3 class="text-faint font-mono text-[10.5px] tracking-[0.04em] uppercase">Tasks <span class="tabular-nums">{{ issues().length }}</span></h3>
            @if (canEdit() && addable().length) {
              <app-picker
                class="ml-auto"
                variant="bare"
                label="Add tasks to milestone"
                searchPlaceholder="Search project tasks…"
                triggerClass="text-muted-foreground hover:text-foreground h-6 gap-1 px-1.5 text-xs"
                align="end"
                [options]="addOptions()"
                [value]="[]"
                (valueChange)="addIssue($event[0])"
              >
                <svg [lucideIcon]="plus" [size]="12"></svg>Add task
              </app-picker>
            }
          </div>
          @if (issues().length) {
            <!-- the one task table of the app, scoped to this milestone -->
            <div class="bg-background border-border flex max-h-[26rem] flex-col overflow-hidden border">
              <app-issue-board
                [issues]="allIssues()"
                [baseFilters]="milestoneFilter()"
                [toolbar]="false"
                [statusBar]="false"
                [showCreate]="false"
                [hideProps]="hiddenProps"
                forceLayout="list"
                forceGroup="none"
                [stateKey]="'milestone.' + m.id"
                [dropPrefix]="'milestone-issue-col-' + m.id"
              />
            </div>
          } @else {
            <p class="text-muted-foreground text-xs">No tasks in this milestone. Add some, or set a milestone on a task row.</p>
          }
        </div>
      </div>
    }

    <ng-template #menu>
      <hlm-dropdown-menu class="w-56">
        <hlm-dropdown-menu-group>
          <button hlmDropdownMenuItem (triggered)="startRename()">
            <svg [lucideIcon]="pencil" [size]="14" class="text-muted-foreground"></svg>Rename
          </button>
          <button hlmDropdownMenuItem (triggered)="editDescription()">
            <svg [lucideIcon]="textIcon" [size]="14" class="text-muted-foreground"></svg>Edit description
          </button>
          <button hlmDropdownMenuItem [hlmDropdownMenuSubTrigger]="dateSub">
            <svg [lucideIcon]="cal" [size]="14" class="text-muted-foreground"></svg>Target date
            <hlm-dropdown-menu-item-sub-indicator />
          </button>
        </hlm-dropdown-menu-group>
        <hlm-dropdown-menu-separator />
        <hlm-dropdown-menu-group>
          <button hlmDropdownMenuItem [disabled]="index() === 0" (triggered)="actions.move(m, -1)">
            <svg [lucideIcon]="up" [size]="14" class="text-muted-foreground"></svg>Move up
          </button>
          <button hlmDropdownMenuItem [disabled]="index() === count() - 1" (triggered)="actions.move(m, 1)">
            <svg [lucideIcon]="down" [size]="14" class="text-muted-foreground"></svg>Move down
          </button>
        </hlm-dropdown-menu-group>
        <hlm-dropdown-menu-separator />
        <button hlmDropdownMenuItem variant="destructive" (triggered)="actions.remove(m)">
          <svg [lucideIcon]="trash" [size]="14"></svg>Delete milestone
        </button>
      </hlm-dropdown-menu>
    </ng-template>
    <ng-template #dateSub>
      <hlm-dropdown-menu-sub class="w-48">
        @for (d of presets; track d.label) {
          <button hlmDropdownMenuItem (triggered)="actions.setDate(m, d.at())">{{ d.label }}</button>
        }
        @if (m.targetDate) {
          <hlm-dropdown-menu-separator />
          <button hlmDropdownMenuItem (triggered)="actions.setDate(m, null)"><span class="text-muted-foreground">Clear date</span></button>
        }
      </hlm-dropdown-menu-sub>
    </ng-template>
  `,
})
export class MilestoneRow {
  private readonly store = inject(TramaStore);
  private readonly info = inject(MilestoneInfo);
  protected readonly actions = inject(MilestoneActions);

  readonly ms = input.required<Milestone>();
  readonly project = input.required<Project>();
  /** Show without any editing. */
  readonly readonly = input(false);
  /** Position among the project's milestones (for move up / down). */
  readonly index = input(0);
  readonly count = input(1);

  protected readonly open = signal(false);
  protected readonly renaming = signal(false);
  protected readonly draft = signal('');
  private readonly nameInput = viewChild<ElementRef<HTMLInputElement>>('nameInput');

  protected readonly presets = DATE_PRESETS;
  protected readonly grip = LucideGripVertical;
  protected readonly chevron = LucideChevronRight;
  protected readonly cal = LucideCalendar;
  protected readonly more = LucideEllipsis;
  protected readonly pencil = LucidePencil;
  protected readonly textIcon = LucideText;
  protected readonly up = LucideMoveUp;
  protected readonly down = LucideMoveDown;
  protected readonly trash = LucideTrash2;
  protected readonly plus = LucidePlus;
  protected readonly fmtNum = fmtNum;

  protected readonly allIssues = computed(() => this.store.issues());
  /** The shared task table lists this milestone's tasks only. */
  protected readonly milestoneFilter = computed(() => [
    { field: 'milestoneIds', op: 'in' as const, value: [this.ms().id] },
  ]);
  /** Rows inside a milestone do not repeat the project. */
  protected readonly hiddenProps: readonly IssueProp[] = ['project'];
  protected readonly canEdit = computed(() => !this.readonly() && this.store.allowed('manageProjects'));
  protected readonly stats = computed(() => this.info.stats().get(this.ms().id)!);
  protected readonly state = computed(() => this.info.states().get(this.ms().id) ?? 'idle');
  protected readonly label = computed(() => progressLabel(this.stats()));
  protected readonly date = computed(() => shortDate(this.ms().targetDate));
  protected readonly late = computed(() => this.state() === 'overdue' || (!this.stats().complete && isOverdue(this.ms().targetDate)));
  protected readonly issues = computed(() => this.store.issuesByMilestone().get(this.ms().id) ?? []);
  protected readonly tip = computed(() => {
    const s = this.stats();
    return s.issues
      ? `${s.doneIssues} of ${s.issues} tasks done${s.points ? ` · ◬ ${fmtNum(s.completed)} of ${fmtNum(s.scope)} points` : ''}`
      : 'No tasks in this milestone';
  });
  protected readonly addable = computed(() => (this.store.issuesByProject().get(this.project().id) ?? []).filter((i) => i.status !== 'canceled' && !i.milestoneIds?.includes(this.ms().id)));
  protected readonly addOptions = computed(() => issueOptions(this.addable()));

  constructor() {
    effect(() => {
      const el = this.nameInput()?.nativeElement;
      if (el) {
        el.focus();
        el.select();
      }
    });
  }

  protected toggle(): void {
    this.open.update((v) => !v);
  }

  protected editDescription(): void {
    this.open.set(true);
  }

  protected startRename(): void {
    this.draft.set(this.ms().name);
    this.renaming.set(true);
  }

  protected commitRename(): void {
    if (!this.renaming()) return;
    this.renaming.set(false);
    this.actions.rename(this.ms(), this.draft());
  }

  protected cancelRename(e: Event): void {
    e.stopPropagation();
    this.renaming.set(false);
  }

  protected addIssue(id: string | undefined): void {
    const issue = id ? this.store.getIssue(id) : undefined;
    if (issue) this.actions.assign(issue, this.project().id, this.ms().id);
  }

}
