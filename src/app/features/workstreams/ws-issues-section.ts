// "Issues this workstream resolves" — the demand side of a workstream (VISION §20-21, §29).
// Issue rows use CIRCLE glyphs (their own tracker status, independent of the workstream's).
// Link an existing issue (picker / `i`), create one inline and link it, change an issue's status
// in place, unlink with Undo.
import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { RouterLink } from '@angular/router';
import { LucideCircleDot, LucideDynamicIcon, LucideLink, LucidePlus, LucideX } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import {
  ISSUE_KINDS,
  ISSUE_KIND_META,
  ISSUE_STATUSES,
  NablaStore,
  Notifier,
  PRIORITY_META,
  shortDate,
  type Issue,
  type IssueKind,
  type IssueStatus,
  type Milestone,
  type Workstream,
} from '../../core';
import { ActorAvatar } from '../../shared/actor-avatar';
import { IssueKindLabel } from '../../shared/issue';
import { KeyChip } from '../../shared/key-chip';
import { Kbd } from '../../shared/kbd';
import { PriorityIcon } from '../../shared/priority-icon';
import { StatusIcon } from '../../shared/status';
import { AiActions } from '../ai-actions/ai-actions.service';
import { AiButton } from '../ai-actions/ai-button';
import { MilestoneActions } from '../milestones/milestone-actions';
import { MilestoneIcon } from '../milestones/milestone-icon';
import { MilestoneInfo } from '../milestones/milestone-stats';
import { Picker, type PickOption } from './picker';
import { WsActions } from './ws-actions';
import { ISSUE_STATUS_COLOR, issueBreakdown, issueCounts, issueOptions, issueStatusOptions } from './ws-model';

@Component({
  selector: 'app-ws-issues-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    NgTemplateOutlet,
    RouterLink,
    MilestoneIcon,
    HlmButtonImports,
    HlmInputImports,
    HlmTooltip,
    LucideDynamicIcon,
    ActorAvatar,
    IssueKindLabel,
    KeyChip,
    Kbd,
    PriorityIcon,
    StatusIcon,
    Picker,
    AiButton,
  ],
  host: { class: 'block' },
  template: `
    <section aria-labelledby="ws-issues-title">
      <header class="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
        <svg [lucideIcon]="issueIcon" [size]="15" class="text-muted-foreground"></svg>
        <h2 id="ws-issues-title" class="text-sm font-semibold">Issues</h2>
        <span class="text-muted-foreground text-xs">{{ counts().issuesTotal }} · the demand this workstream resolves</span>
        <span class="ml-auto flex items-center gap-0.5">
          @if (hasMilestones()) {
            <button
              hlmBtn
              variant="ghost"
              size="sm"
              class="text-muted-foreground hover:text-foreground h-7 gap-1.5 px-2 text-xs font-normal"
              [class.bg-accent]="groupByMilestone()"
              [attr.aria-pressed]="groupByMilestone()"
              hlmTooltip="Group issues by milestone"
              (click)="groupByMilestone.update((v) => !v)"
            >
              <app-milestone-icon [size]="13" state="idle" />Group by milestone
            </button>
          }
        @if (canEdit()) {
          <span class="flex items-center gap-0.5">
            <app-picker
              #linkPicker
              variant="bare"
              label="Link existing issue"
              searchPlaceholder="Search issues by key or title…"
              triggerClass="h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
              align="end"
              [options]="linkOptions()"
              [value]="[]"
              (valueChange)="link($event[0])"
            >
              <svg [lucideIcon]="linkIcon" [size]="13"></svg>Link issue<app-kbd keys="i" class="opacity-60" />
            </app-picker>
            <button hlmBtn variant="ghost" size="sm" class="text-muted-foreground hover:text-foreground h-7 gap-1.5 px-2 text-xs font-normal" (click)="startNew()">
              <svg [lucideIcon]="plusIcon" [size]="13"></svg>New issue
            </button>
            @if (fewIssues()) {
              <app-ai-button
                label="Break down"
                variant="ghost"
                size="sm"
                class="text-muted-foreground"
                tooltip="Propose issues from this workstream's objective"
                hideWhenUnavailable
                (pressed)="ai.request('breakdown', ws().id)"
              />
            }
          </span>
        }
        </span>
      </header>

      @if (issues().length) {
        <div class="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
          <span class="bg-muted flex h-1.5 w-40 overflow-hidden rounded-full" aria-hidden="true">
            @for (b of breakdown(); track b.status) {
              <span class="h-full" [style.width.%]="(b.count / issues().length) * 100" [style.background]="color[b.status]"></span>
            }
          </span>
          <span class="text-muted-foreground text-xs">
            @for (b of breakdown(); track b.status; let last = $last) {
              <span class="text-foreground tabular-nums">{{ b.count }}</span> {{ b.label.toLowerCase() }}{{ last ? '' : ' · ' }}
            }
          </span>
        </div>
      }

      <ul class="bg-card overflow-hidden rounded-lg border border-border-strong">
        @if (grouped()) {
          @for (g of groups(); track g.key) {
            <li class="bg-muted/40 flex min-h-8 items-center gap-2 border-b px-3 text-xs font-medium">
              @if (g.ms; as m) {
                <app-milestone-icon [fraction]="msInfo.stats().get(m.id)?.fraction ?? 0" [state]="msInfo.states().get(m.id) ?? 'idle'" [size]="13" />
                {{ m.name }}
                <span class="text-muted-foreground font-normal tabular-nums">{{ msInfo.stats().get(m.id)?.percent ?? 0 }}%</span>
                @if (m.targetDate) {
                  <span class="text-muted-foreground ml-auto font-normal tabular-nums">{{ shortDay(m.targetDate) }}</span>
                }
              } @else {
                <span class="text-muted-foreground">No milestone</span>
              }
              <span class="text-muted-foreground font-normal tabular-nums" [class.ml-auto]="!g.ms?.targetDate">{{ g.issues.length }}</span>
            </li>
            @for (i of g.issues; track i.id) {
              <ng-container *ngTemplateOutlet="row; context: { $implicit: i }" />
            }
          }
        } @else {
          @for (i of issues(); track i.id) {
            <ng-container *ngTemplateOutlet="row; context: { $implicit: i }" />
          }
        }
        @if (creating()) {
          <li class="flex min-h-10 items-center gap-2 border-t px-2 first:border-t-0">
            <app-picker variant="bare" label="Issue type" triggerClass="h-7 gap-1.5 px-1.5 text-xs" [searchable]="false" [options]="kindOptions" [value]="[newKind()]" (valueChange)="newKind.set($any($event[0] ?? 'bug'))">
              <app-issue-kind [kind]="newKind()" showLabel />
            </app-picker>
            <input
              #newTitle
              hlmInput
              class="h-7 flex-1 border-transparent bg-transparent text-[13px] shadow-none focus-visible:border-input"
              placeholder="Issue title, Enter to create and link"
              aria-label="New issue title"
              [value]="newDraft()"
              (input)="newDraft.set($any($event.target).value)"
              (keydown.enter)="createIssue()"
              (keydown.escape)="cancelNew($event)"
            />
            <button hlmBtn size="xs" [disabled]="!newDraft().trim() || busy()" (click)="createIssue()">Create</button>
            <button hlmBtn variant="ghost" size="xs" (click)="creating.set(false)">Cancel</button>
          </li>
        } @else if (!issues().length) {
          <li class="text-muted-foreground px-3 py-3 text-sm">
            No issues linked yet. Issues are the demand — bugs, requests, incidents — that this outcome resolves.
            @if (canEdit()) {
              <span>Link existing ones or create a new one.</span>
            }
          </li>
        }
      </ul>
    </section>

    <ng-template #row let-i>
      <li class="group/issue hover:bg-hover flex min-h-9 items-center gap-2 border-b px-2 text-[13px] last:border-b-0">
        <app-picker
          variant="bare"
          label="Issue status"
          triggerClass="size-6 justify-center"
          [searchable]="false"
          [disabled]="!canEdit()"
          [options]="issueStatuses"
          [value]="[i.status]"
          (valueChange)="setIssueStatus(i, $event[0])"
        >
          <app-status-icon entity="issue" [status]="i.status" />
        </app-picker>
        <app-issue-kind [kind]="i.kind" class="max-sm:hidden" />
        <a [routerLink]="['/', slug(), 'issues', i.key]" class="flex min-w-0 flex-1 items-center gap-2 outline-none focus-visible:underline">
          <app-key-chip [value]="i.key" class="w-[4.25rem]" />
          <span class="truncate" [class.text-muted-foreground]="i.status === 'done' || i.status === 'canceled'">{{ i.title }}</span>
        </a>
        @if (hasMilestones()) {
          <app-picker
            variant="bare"
            label="Milestone"
            searchPlaceholder="Search milestones…"
            triggerClass="text-muted-foreground hover:text-foreground h-6 max-w-[9rem] gap-1 px-1.5 text-[11px] max-md:hidden"
            align="end"
            [clearable]="true"
            clearLabel="No milestone"
            [disabled]="!canEdit()"
            [options]="milestoneOpts()"
            [value]="milestoneValue(i)"
            (valueChange)="setMilestone(i, $event[0])"
          >
            @if (milestoneOf(i); as m) {
              <app-milestone-icon [fraction]="msInfo.stats().get(m.id)?.fraction ?? 0" [state]="msInfo.states().get(m.id) ?? 'idle'" [size]="12" />
              <span class="truncate">{{ m.name }}</span>
            } @else if (canEdit()) {
              <app-milestone-icon state="empty" [size]="12" class="opacity-0 group-hover/issue:opacity-60" />
            }
          </app-picker>
        }
        @if (i.workstreamIds.length > 1) {
          <span class="text-muted-foreground border-border-strong hidden h-5 items-center rounded-full border px-1.5 text-[11px] sm:inline-flex" [hlmTooltip]="'Also linked to ' + (i.workstreamIds.length - 1) + ' other workstream(s)'">
            +{{ i.workstreamIds.length - 1 }} ws
          </span>
        }
        @if (i.priority !== 'none') {
          <app-priority-icon [priority]="i.priority" [hlmTooltip]="priorityLabel(i)" />
        }
        <span class="flex w-5 justify-center">
          @if (i.assigneeId) {
            <app-actor-avatar [actor]="{ type: 'user', id: i.assigneeId }" [size]="18" [hlmTooltip]="'Assignee: ' + (store.getUser(i.assigneeId)?.name ?? '')" />
          }
        </span>
        @if (canEdit()) {
          <button
            hlmBtn
            variant="ghost"
            size="icon-xs"
            class="text-muted-foreground opacity-0 group-hover/issue:opacity-100 focus-visible:opacity-100 max-md:opacity-100"
            [attr.aria-label]="'Unlink ' + i.key"
            hlmTooltip="Unlink from this workstream"
            (click)="unlink(i)"
          >
            <svg [lucideIcon]="xIcon" [size]="13"></svg>
          </button>
        }
      </li>
    </ng-template>
  `,
})
export class WsIssuesSection {
  protected readonly store = inject(NablaStore);
  private readonly notify = inject(Notifier);
  private readonly actions = inject(WsActions);
  protected readonly ai = inject(AiActions);
  protected readonly msInfo = inject(MilestoneInfo);
  private readonly msActions = inject(MilestoneActions);
  readonly ws = input.required<Workstream>();

  protected readonly issueIcon = LucideCircleDot;
  protected readonly linkIcon = LucideLink;
  protected readonly plusIcon = LucidePlus;
  protected readonly xIcon = LucideX;
  protected readonly color = ISSUE_STATUS_COLOR;
  protected readonly issueStatuses = issueStatusOptions();
  protected readonly kindOptions: PickOption[] = ISSUE_KINDS.map((k) => ({ value: k, label: ISSUE_KIND_META[k].label }));

  protected readonly slug = computed(() => this.store.slug() ?? '');
  protected readonly canEdit = computed(() => this.store.can('member'));
  protected readonly issues = computed(() => {
    const order = (s: IssueStatus) => ISSUE_STATUSES.indexOf(s);
    // open work first (in review → in progress → todo → backlog), then done / canceled
    const rank = (i: Issue) => (i.status === 'done' || i.status === 'canceled' ? 10 + order(i.status) : -order(i.status));
    return [...(this.store.issuesByWorkstream().get(this.ws().id) ?? [])].sort((a, b) => rank(a) - rank(b) || a.number - b.number);
  });
  protected readonly milestones = computed(() => this.store.milestonesByWorkstream().get(this.ws().id) ?? []);
  protected readonly hasMilestones = computed(() => this.milestones().length > 0);
  protected readonly milestoneOpts = computed(() => (this.ws().projectId ? this.msActions.options(this.ws().projectId!) : []));
  protected readonly groupByMilestone = signal(false);
  protected readonly grouped = computed(() => this.groupByMilestone() && this.hasMilestones());
  protected readonly groups = computed<{ key: string; ms: Milestone | null; issues: Issue[] }[]>(() => {
    const list = this.issues();
    const out = this.milestones().map((m) => ({ key: m.id, ms: m as Milestone | null, issues: list.filter((i) => i.milestoneIds?.includes(m.id)) }));
    const rest = list.filter((i) => !this.milestoneOf(i));
    if (rest.length) out.push({ key: 'none', ms: null, issues: rest });
    return out;
  });
  protected readonly counts = computed(() => issueCounts(this.issues()));
  /** A new or thin workstream: offer to break the objective down into issues. */
  protected readonly fewIssues = computed(() => this.issues().length < 3);
  protected readonly breakdown = computed(() => issueBreakdown(this.issues()));
  protected readonly linkOptions = computed(() =>
    issueOptions(this.store.issues().filter((i) => !i.workstreamIds.includes(this.ws().id) && !i.duplicateOfId)),
  );

  protected readonly creating = signal(false);
  protected readonly newDraft = signal('');
  protected readonly newKind = signal<IssueKind>('bug');
  protected readonly busy = signal(false);
  private readonly linkPicker = viewChild<Picker>('linkPicker');
  private readonly newTitle = viewChild<ElementRef<HTMLInputElement>>('newTitle');

  constructor() {
    effect(() => {
      const i = this.actions.intent();
      if (!i) return;
      untracked(() => {
        const id = this.ws().id;
        if (i.kind === 'link-issue' && this.linkPicker() && this.actions.consume('link-issue', id)) this.linkPicker()!.open();
        if (i.kind === 'new-issue' && this.actions.consume('new-issue', id)) this.startNew();
      });
    });
    effect(() => {
      const el = this.newTitle()?.nativeElement;
      if (el) el.focus();
    });
  }

  protected milestoneOf(i: Issue): Milestone | undefined {
    const projectId = this.ws().projectId;
    return projectId ? this.msActions.milestoneOf(i, projectId) : undefined;
  }

  protected milestoneValue(i: Issue): string[] {
    const m = this.milestoneOf(i);
    return m ? [m.id] : [];
  }

  protected setMilestone(i: Issue, id: string | undefined): void {
    const projectId = this.ws().projectId;
    if (projectId) this.msActions.assign(i, projectId, id ?? null);
  }

  protected shortDay(iso: string): string {
    return shortDate(iso);
  }

  protected priorityLabel(i: Issue): string {
    return `Priority: ${PRIORITY_META[i.priority].label}`;
  }

  protected startNew(): void {
    this.newDraft.set('');
    this.creating.set(true);
    this.newTitle()?.nativeElement.focus();
  }

  protected cancelNew(e: Event): void {
    e.stopPropagation();
    this.creating.set(false);
  }

  protected async link(issueId: string | undefined): Promise<void> {
    const issue = issueId ? this.store.issueById().get(issueId) : undefined;
    if (!issue) return;
    const before = { status: issue.status, workstreamIds: [...issue.workstreamIds] };
    const res = await this.store.linkIssue(issue.id, { workstreamIds: [this.ws().id] });
    if (!res) return;
    const moved = res.status !== before.status;
    this.notify.success(`Linked ${issue.key}`, {
      description: moved ? `Issue moved to ${this.statusLabel(res.status)}.` : undefined,
      action: { label: 'Undo', run: () => void this.store.updateIssue(issue.id, before) },
    });
  }

  protected unlink(issue: Issue): void {
    const before = [...issue.workstreamIds];
    void this.store.updateIssue(issue.id, { workstreamIds: before.filter((id) => id !== this.ws().id) });
    this.notify.success(`Unlinked ${issue.key}`, {
      action: { label: 'Undo', run: () => void this.store.updateIssue(issue.id, { workstreamIds: before }) },
    });
  }

  protected setIssueStatus(issue: Issue, status: string | undefined): void {
    if (status && status !== issue.status) void this.store.updateIssue(issue.id, { status: status as IssueStatus });
  }

  protected async createIssue(): Promise<void> {
    const title = this.newDraft().trim();
    if (!title || this.busy()) return;
    this.busy.set(true);
    const w = this.ws();
    const created = await this.store.createIssue({ kind: this.newKind(), title, teamId: w.ownerTeamId, status: 'todo' });
    if (created) {
      await this.store.linkIssue(created.id, { workstreamIds: [w.id], status: created.status });
      this.newDraft.set('');
      this.notify.success(`${created.key} created and linked`);
    }
    this.busy.set(false);
    this.newTitle()?.nativeElement.focus();
  }

  private statusLabel(s: IssueStatus): string {
    return this.issueStatuses.find((o) => o.value === s)?.label ?? s;
  }
}
