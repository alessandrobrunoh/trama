// `/:slug/workstreams/:key` — one outcome: hexagon status, key, editable title, quick property
// chips, the "why this status" popover and tabs (overview, issues, artifacts, decisions, graph,
// activity, agent context, statistics). Keyboard: s p a t (properties), i / ⇧I (link / new issue),
// d (dependency), q (question), e (title), ⌘. ⌘⇧C ⇧O ⌘⌫ (copy key / link, Delta, delete), 1-8 tabs.
import { ProviderIcon } from '../../shared/provider-icon';
import { ChangeDetectionStrategy, Component, computed, inject, input, signal, viewChild } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import {
  LucideArrowUpRight,
  LucideDynamicIcon,
  LucideEllipsis,
  LucideInfo,
  LucideLink,
  LucideRotateCcw,
  LucideUserRound,
  LucideWorkflow,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import { HlmPopoverImports } from '@spartan-ng/helm/popover';
import { HlmTabsImports } from '@spartan-ng/helm/tabs';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import {
  NablaStore,
  PRIORITY_META,
  WORKSTREAM_STATUS_META,
  isTypingTarget,
  usePageShortcuts,
  type Priority,
  type WorkstreamStatus,
} from '../../core';
import { TopBarActions, usePageCrumbs } from '../../layout/page-chrome';
import { ActorAvatar } from '../../shared/actor-avatar';
import { EmptyState } from '../../shared/empty-state';
import { Kbd } from '../../shared/kbd';
import { KeyChip } from '../../shared/key-chip';
import { PriorityIcon } from '../../shared/priority-icon';
import { StatusIcon } from '../../shared/status';
import { WsStatsTab } from '../stats/ws-stats-tab';
import { AiWsActions } from '../ai-actions/ai-ws-dialogs';
import { NextMilestoneChip } from '../milestones/milestone-chips';
import { InlineText } from './inline-edit';
import { Picker } from './picker';
import { WsActions, type WsIntentKind } from './ws-actions';
import { WsActivityTab } from './ws-activity-tab';
import { WsArtifactsTab } from './ws-artifacts-tab';
import { WsContextTab, WsGraphTab } from './ws-context-graph-tabs';
import { WsDecisionsTab } from './ws-decisions-tab';
import { WsIssuesSection } from './ws-issues-section';
import { WsMenu } from './ws-menu';
import { explainStatus, issueCounts, priorityOptions, statusOptions, userOptions } from './ws-model';
import { WsOverviewTab } from './ws-overview-tab';
import { CriteriaCount, IssueProgress, TargetDate, WsDatePicker } from './ws-parts';

const TABS = ['overview', 'issues', 'artifacts', 'decisions', 'graph', 'activity', 'context', 'stats'] as const;
type Tab = (typeof TABS)[number];
const TAB_LABEL: Record<Tab, string> = {
  overview: 'Overview',
  issues: 'Issues',
  artifacts: 'Artifacts',
  decisions: 'Decisions',
  graph: 'Graph',
  activity: 'Activity',
  context: 'Agent context',
  stats: 'Statistics',
};

@Component({
  selector: 'app-workstream-detail-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ProviderIcon,
    RouterLink,
    HlmButtonImports,
    HlmDropdownMenuImports,
    HlmPopoverImports,
    HlmTabsImports,
    HlmTooltip,
    LucideDynamicIcon,
    TopBarActions,
    ActorAvatar,
    EmptyState,
    Kbd,
    KeyChip,
    PriorityIcon,
    StatusIcon,
    InlineText,
    Picker,
    CriteriaCount,
    IssueProgress,
    TargetDate,
    WsDatePicker,
    NextMilestoneChip,
    WsMenu,
    AiWsActions,
    WsOverviewTab,
    WsIssuesSection,
    WsStatsTab,
    WsArtifactsTab,
    WsDecisionsTab,
    WsGraphTab,
    WsActivityTab,
    WsContextTab,
  ],
  host: { class: 'flex min-h-full flex-col' },
  template: `
    @if (ws(); as w) {
      <app-ws-menu #menu [ws]="w" [afterDelete]="backToList" aiHost />
      <app-ai-ws-actions [ws]="w" />
      <ng-template appTopBarActions>
        <button hlmBtn size="icon-sm" variant="ghost" class="text-muted-foreground" aria-label="Copy link" hlmTooltip="Copy link (⌘⇧C)" position="bottom" (click)="actions.copyLink([w])">
          <svg [lucideIcon]="linkIcon" [size]="15"></svg>
        </button>
        @if (w.deltaThreadUrl) {
          <a hlmBtn size="sm" variant="outline" [href]="w.deltaThreadUrl" target="_blank" rel="noopener noreferrer" hlmTooltip="Open Delta thread (⇧O)" position="bottom">
            <app-provider-icon provider="delta" [size]="14" /><span class="max-sm:hidden">Delta thread</span><svg [lucideIcon]="extIcon" [size]="13"></svg>
          </a>
        }
      </ng-template>

      <header class="border-b px-4 pt-3 sm:px-6">
        <div class="flex items-center gap-2">
          <app-picker
            #statusPicker
            variant="bare"
            label="Status"
            triggerClass="size-7 justify-center"
            [searchable]="false"
            [clearable]="!!w.statusOverride"
            clearLabel="Automatic (derived)"
            [disabled]="!canEdit()"
            [options]="statuses"
            [value]="[w.status]"
            (valueChange)="setStatus($event[0])"
          >
            <app-status-icon entity="workstream" [status]="w.status" [size]="18" />
          </app-picker>
          <app-key-chip [value]="w.key" class="text-[13px]" />
          <app-inline-text
            #title
            class="min-w-0 flex-1"
            label="title"
            textClass="text-lg font-semibold tracking-tight"
            [value]="w.title"
            [canEdit]="canEdit()"
            (save)="store.updateWorkstream(w.id, { title: $event })"
          />
          <button hlmBtn variant="ghost" size="icon-sm" class="text-muted-foreground shrink-0" [hlmDropdownMenuTrigger]="menu.template() ?? null" aria-label="Workstream actions">
            <svg [lucideIcon]="moreIcon" [size]="16"></svg>
          </button>
        </div>

        <div class="mt-2 flex flex-wrap items-center gap-1.5 pb-3 text-xs">
          <hlm-popover align="start" sideOffset="6" [state]="whyState()" (stateChanged)="whyState.set($event)">
            <button
              hlmPopoverTrigger
              type="button"
              class="hover:bg-accent focus-visible:ring-ring inline-flex h-7 items-center gap-1.5 rounded-md border border-border-strong px-2 outline-none focus-visible:ring-2"
              [attr.aria-label]="'Status ' + statusLabel() + '. Why?'"
            >
              <app-status-icon entity="workstream" [status]="w.status" [size]="13" />
              <span class="font-medium">{{ statusLabel() }}</span>
              <span class="text-muted-foreground inline-flex items-center gap-1">
                <svg [lucideIcon]="info" [size]="12"></svg>{{ w.statusOverride ? 'manual' : 'derived' }}
              </span>
            </button>
            <hlm-popover-content *hlmPopoverPortal="let ctx" class="w-80 gap-2">
              <hlm-popover-header>
                <h3 hlmPopoverTitle class="flex items-center gap-1.5"><app-status-icon entity="workstream" [status]="w.status" />{{ statusLabel() }}</h3>
                <p hlmPopoverDescription class="text-xs">{{ explain().headline }}</p>
              </hlm-popover-header>
              <ul class="flex list-disc flex-col gap-1 pl-4 text-xs">
                @for (r of explain().reasons; track $index) {
                  <li>{{ r }}</li>
                }
              </ul>
              <p class="text-muted-foreground border-t pt-2 text-[11px] leading-relaxed">
                Status is derived from acceptance criteria, artifacts, input requests, decisions and dependencies. Press <app-kbd keys="s" /> to pin a status manually.
              </p>
              @if (canEdit()) {
                <div class="flex flex-wrap gap-1.5">
                  <button hlmBtn size="xs" variant="outline" (click)="override('draft')">Mark draft</button>
                  <button hlmBtn size="xs" variant="outline" (click)="override('canceled')">Mark canceled</button>
                  @if (w.statusOverride) {
                    <button hlmBtn size="xs" variant="ghost" (click)="override(null)"><svg [lucideIcon]="reset" [size]="12"></svg>Back to automatic</button>
                  }
                </div>
              }
            </hlm-popover-content>
          </hlm-popover>

          <app-picker #priorityPicker variant="bare" label="Priority" triggerClass="h-7 gap-1.5 border border-border-strong px-2" [searchable]="false" [disabled]="!canEdit()" [options]="priorities" [value]="[w.priority]" (valueChange)="setPriority($event[0])">
            <app-priority-icon [priority]="w.priority" /><span>{{ priorityLabel() }}</span>
          </app-picker>

          <app-picker #accountablePicker variant="bare" label="Accountable" triggerClass="h-7 gap-1.5 border border-border-strong px-2" [clearable]="true" clearLabel="Unassign" [disabled]="!canEdit()" [options]="users()" [value]="w.accountableUserId ? [w.accountableUserId] : []" (valueChange)="actions.setAccountable([w], $event[0] ?? null)">
            @if (w.accountableUserId) {
              <app-actor-avatar [actor]="{ type: 'user', id: w.accountableUserId }" [size]="16" />
              <span>{{ store.getUser(w.accountableUserId)?.name }}</span>
            } @else {
              <svg [lucideIcon]="userIcon" [size]="13" class="text-muted-foreground"></svg><span class="text-muted-foreground">Accountable</span>
            }
          </app-picker>

          <a
            [routerLink]="['/', slug(), 'teams', ownerKey()]"
            class="hover:bg-accent inline-flex h-7 items-center gap-1.5 rounded-md border border-border-strong px-2"
            [hlmTooltip]="'Owner team' + (w.participatingTeamIds.length ? ' · with ' + participantNames() : '')"
          >
            <app-actor-avatar [actor]="{ type: 'team', id: w.ownerTeamId }" [size]="16" />
            <span>{{ store.getTeam(w.ownerTeamId)?.name }}</span>
            @if (w.participatingTeamIds.length) {
              <span class="text-muted-foreground">+{{ w.participatingTeamIds.length }}</span>
            }
          </a>

          <app-ws-date-picker #datePicker label="Target date" triggerClass="h-7 gap-1.5 border border-border-strong px-2" [disabled]="!canEdit()" [value]="w.targetDate" (dateChange)="actions.setTargetDate([w], $event)">
            @if (w.targetDate) {
              <app-target-date [date]="w.targetDate" [done]="w.status === 'shipped' || w.status === 'canceled'" />
            } @else {
              <span class="text-muted-foreground">Target date</span>
            }
          </app-ws-date-picker>

          <app-next-milestone [workstreamId]="w.id" />

          <button type="button" class="hover:bg-accent inline-flex h-7 items-center gap-1.5 rounded-md px-2" (click)="setTab('issues')">
            <app-issue-progress [done]="issues().issuesDone" [active]="issues().issuesActive" [total]="issues().issuesTotal" />
          </button>
          <app-criteria-count class="px-1" [met]="criteria().met" [total]="w.acceptanceCriteria.length" />
          @if (openQuestions()) {
            <span class="text-status-needs-input bg-status-needs-input/10 inline-flex h-6 items-center rounded-full px-2 font-medium">{{ openQuestions() }} open question{{ openQuestions() > 1 ? 's' : '' }}</span>
          }
        </div>

        <hlm-tabs [tab]="current()" (tabActivated)="setTab($event)" class="-mx-4 sm:-mx-6">
          <div class="scrollbar-none overflow-x-auto px-4 sm:px-6">
            <hlm-tabs-list variant="line" class="h-9 w-max gap-1 p-0" aria-label="Workstream sections">
              @for (t of tabs; track t; let i = $index) {
                <button [hlmTabsTrigger]="t" class="h-9 flex-none px-2.5 after:bottom-0" [hlmTooltip]="tabLabel[t] + ' (' + (i + 1) + ')'" position="bottom">
                  {{ tabLabel[t] }}
                  @if (counts()[t]) {
                    <span class="text-muted-foreground ml-1 text-xs tabular-nums">{{ counts()[t] }}</span>
                  }
                </button>
              }
            </hlm-tabs-list>
          </div>
        </hlm-tabs>
      </header>

      <div class="min-w-0 flex-1">
        @switch (current()) {
          @case ('overview') {
            <app-ws-overview-tab [ws]="w" />
          }
          @case ('issues') {
            <div class="px-4 py-5 sm:px-6">
              <app-ws-issues-section [ws]="w" />
            </div>
          }
          @case ('stats') {
            <app-ws-stats-tab [ws]="w" />
          }
          @case ('artifacts') {
            <app-ws-artifacts-tab [ws]="w" />
          }
          @case ('decisions') {
            <app-ws-decisions-tab [ws]="w" />
          }
          @case ('graph') {
            <app-ws-graph-tab [ws]="w" />
          }
          @case ('activity') {
            <app-ws-activity-tab [ws]="w" />
          }
          @case ('context') {
            <app-ws-context-tab [ws]="w" />
          }
        }
      </div>
    } @else {
      <app-empty-state [icon]="flow" title="Workstream not found" description="It may have been deleted, or the key is wrong.">
        <a hlmBtn size="sm" variant="outline" [routerLink]="['/', slug(), 'workstreams']">Back to workstreams</a>
      </app-empty-state>
    }
  `,
})
export class WorkstreamDetailPage {
  protected readonly store = inject(NablaStore);
  protected readonly actions = inject(WsActions);
  private readonly router = inject(Router);

  /** From the parent `:workspaceSlug` route segment. */
  readonly workspaceSlug = input<string>();
  readonly key = input<string>();
  readonly tab = input<string>();

  protected readonly tabs = TABS;
  protected readonly tabLabel = TAB_LABEL;
  protected readonly moreIcon = LucideEllipsis;
  protected readonly info = LucideInfo;
  protected readonly reset = LucideRotateCcw;
  protected readonly flow = LucideWorkflow;
  protected readonly linkIcon = LucideLink;
  protected readonly extIcon = LucideArrowUpRight;
  protected readonly userIcon = LucideUserRound;
  protected readonly whyState = signal<'open' | 'closed'>('closed');
  protected readonly statuses = statusOptions();
  protected readonly priorities = priorityOptions();
  protected readonly users = computed(() => userOptions(this.store));

  private readonly statusPicker = viewChild<Picker>('statusPicker');
  private readonly priorityPicker = viewChild<Picker>('priorityPicker');
  private readonly accountablePicker = viewChild<Picker>('accountablePicker');
  private readonly datePicker = viewChild<WsDatePicker>('datePicker');
  private readonly titleEditor = viewChild<InlineText>('title');

  protected readonly slug = computed(() => this.store.slug() ?? '');
  protected readonly canEdit = computed(() => this.store.can('member'));
  protected readonly ws = computed(() => this.store.getWorkstream(this.key()));
  protected readonly ownerKey = computed(() => this.store.getTeam(this.ws()?.ownerTeamId)?.key ?? '');
  protected readonly participantNames = computed(() =>
    (this.ws()?.participatingTeamIds ?? []).map((id) => this.store.getTeam(id)?.name).filter(Boolean).join(', '),
  );
  protected readonly statusLabel = computed(() => WORKSTREAM_STATUS_META[this.ws()?.status ?? 'draft'].label);
  protected readonly priorityLabel = computed(() => PRIORITY_META[this.ws()?.priority ?? 'none'].label);
  protected readonly explain = computed(() => {
    const w = this.ws();
    return w ? explainStatus(this.store, w) : { headline: '', reasons: [''] };
  });
  protected readonly criteria = computed(() => {
    const list = this.ws()?.acceptanceCriteria ?? [];
    return { met: list.filter((c) => c.state === 'met').length };
  });
  protected readonly issues = computed(() => issueCounts(this.store.issuesByWorkstream().get(this.ws()?.id ?? '') ?? []));
  protected readonly openQuestions = computed(
    () => (this.store.inputRequestsByWorkstream().get(this.ws()?.id ?? '') ?? []).filter((r) => r.state === 'open').length,
  );
  protected readonly current = computed<Tab>(() => {
    const t = this.tab();
    return (TABS as readonly string[]).includes(t ?? '') ? (t as Tab) : 'overview';
  });
  protected readonly counts = computed<Partial<Record<Tab, number>>>(() => {
    const w = this.ws();
    if (!w) return {};
    const events = (this.store.eventsByWorkstream().get(w.id) ?? []).filter((e) => !(e.type === 'comment.created' && e.subject.type === 'workstream'));
    return {
      issues: this.store.issuesByWorkstream().get(w.id)?.length ?? 0,
      artifacts: this.store.artifactsByWorkstream().get(w.id)?.length ?? 0,
      decisions: this.store.decisionsByWorkstream().get(w.id)?.length ?? 0,
      graph:
        (this.store.incomingDependencies().get(w.id) ?? []).filter((d) => d.fromType === 'workstream').length +
        (this.store.outgoingDependencies().get(w.id) ?? []).filter((d) => d.toType === 'workstream').length,
      activity: events.length + this.store.commentsFor({ type: 'workstream', id: w.id }).length,
    };
  });

  protected readonly backToList = (): void => {
    void this.router.navigate(['/', this.slug(), 'workstreams']);
  };

  private readonly _crumbs = usePageCrumbs(() => [
    { label: 'Workstreams', link: ['/', this.slug(), 'workstreams'] },
    { label: this.ws()?.key ?? this.key() ?? '', mono: true },
  ]);

  private readonly has = (): boolean => !!this.ws() && !isTypingTarget(globalThis.document?.activeElement ?? null);
  private readonly editable = (): boolean => this.has() && this.canEdit();

  private readonly _keys = usePageShortcuts([
    ...TABS.map((t, i) => ({
      keys: String(i + 1),
      label: `${TAB_LABEL[t]} tab`,
      run: () => this.setTab(t),
      when: () => !!this.ws(),
    })),
    { keys: 's', label: 'Set status', when: this.editable, run: () => this.statusPicker()?.open() },
    { keys: 'p', label: 'Set priority', when: this.editable, run: () => this.priorityPicker()?.open() },
    { keys: 'a', label: 'Set accountable', when: this.editable, run: () => this.accountablePicker()?.open() },
    { keys: 't', label: 'Set target date', when: this.editable, run: () => this.datePicker()?.open() },
    { keys: 'e', label: 'Edit title', when: this.editable, run: () => this.titleEditor()?.start() },
    { keys: 'i', label: 'Link an issue', when: this.editable, run: () => this.intent('link-issue', ['overview', 'issues']) },
    { keys: 'shift+i', label: 'New linked issue', when: this.editable, run: () => this.intent('new-issue', ['overview', 'issues']) },
    { keys: 'd', label: 'Add dependency (waits on)', when: this.editable, run: () => this.intent('add-dependency', ['overview']) },
    { keys: 'q', label: 'Ask a question', when: this.editable, run: () => this.intent('ask', ['overview']) },
    { keys: 'mod+.', label: 'Copy key', when: this.has, run: () => this.actions.copyKey([this.ws()!]) },
    { keys: 'mod+shift+c', label: 'Copy link', when: this.has, run: () => this.actions.copyLink([this.ws()!]) },
    { keys: 'mod+shift+g', label: 'Copy git branch name', when: this.has, run: () => this.actions.copyBranch(this.ws()!) },
    { keys: 'mod+shift+.', label: 'Copy git branch name', hidden: true, when: this.has, run: () => this.actions.copyBranch(this.ws()!) },
    { keys: 'mod+shift+>', label: 'Copy git branch name', hidden: true, when: this.has, run: () => this.actions.copyBranch(this.ws()!) },
    { keys: 'shift+o', label: 'Open Delta thread', when: this.has, run: () => this.actions.openDelta(this.ws()!) },
    { keys: 'mod+backspace', label: 'Delete workstream', when: this.editable, run: () => this.actions.confirmDelete([this.ws()!], this.backToList) },
  ]);

  /** Switch to a tab that hosts the editor (if needed), then ask it to open. */
  private intent(kind: WsIntentKind, hosts: Tab[]): void {
    const w = this.ws();
    if (!w) return;
    if (!hosts.includes(this.current())) this.setTab(hosts[0]);
    this.actions.request(kind, w.id);
  }

  protected setTab(t: string | null | undefined): void {
    if (!t) return;
    void this.router.navigate([], {
      queryParams: { tab: t === 'overview' ? null : t },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  protected setStatus(v: string | undefined): void {
    const w = this.ws();
    if (w) this.actions.setStatus([w], (v as WorkstreamStatus | undefined) ?? null);
  }

  protected setPriority(v: string | undefined): void {
    const w = this.ws();
    if (w && v) this.actions.setPriority([w], v as Priority);
  }

  protected override(v: 'draft' | 'canceled' | null): void {
    const w = this.ws();
    if (!w) return;
    this.whyState.set('closed');
    this.actions.setStatus([w], v);
  }
}
