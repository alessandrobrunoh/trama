import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import {
  LucideCircleHelp,
  LucideDynamicIcon,
  LucideEllipsis,
  LucideInfo,
  LucideRotateCcw,
  LucideTrash2,
  LucideWorkflow,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import { HlmPopoverImports } from '@spartan-ng/helm/popover';
import { HlmTabsImports } from '@spartan-ng/helm/tabs';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import { NablaStore, UiStore, WORKSTREAM_STATUS_META, usePageShortcuts } from '../../core';
import { TopBarActions, usePageCrumbs } from '../../layout/page-chrome';
import { ActorLabel } from '../../shared/actor-avatar';
import { EmptyState } from '../../shared/empty-state';
import { KeyChip } from '../../shared/key-chip';
import { PriorityIcon } from '../../shared/priority-icon';
import { StatusBadge, StatusIcon } from '../../shared/status';
import { InlineText } from './inline-edit';
import { WsActivityTab } from './ws-activity-tab';
import { WsArtifactsTab } from './ws-artifacts-tab';
import { WsContextTab, WsGraphTab } from './ws-context-graph-tabs';
import { WsDecisionsTab } from './ws-decisions-tab';
import { explainStatus } from './ws-model';
import { WsOverviewTab } from './ws-overview-tab';
import { CriteriaBar, TargetDate } from './ws-parts';

const TABS = ['overview', 'artifacts', 'decisions', 'graph', 'activity', 'context'] as const;
type Tab = (typeof TABS)[number];
const TAB_LABEL: Record<Tab, string> = {
  overview: 'Overview',
  artifacts: 'Artifacts',
  decisions: 'Decisions',
  graph: 'Graph',
  activity: 'Activity',
  context: 'Agent context',
};

@Component({
  selector: 'app-workstream-detail-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    HlmButtonImports,
    HlmDropdownMenuImports,
    HlmPopoverImports,
    HlmTabsImports,
    HlmTooltip,
    LucideDynamicIcon,
    TopBarActions,
    ActorLabel,
    EmptyState,
    KeyChip,
    PriorityIcon,
    StatusBadge,
    StatusIcon,
    InlineText,
    CriteriaBar,
    TargetDate,
    WsOverviewTab,
    WsArtifactsTab,
    WsDecisionsTab,
    WsGraphTab,
    WsActivityTab,
    WsContextTab,
  ],
  host: { class: 'flex min-h-full flex-col' },
  template: `
    @if (ws(); as w) {
      <ng-template appTopBarActions>
        @if (w.deltaThreadUrl) {
          <a hlmBtn size="sm" variant="outline" [href]="w.deltaThreadUrl" target="_blank" rel="noopener noreferrer">
            Open Delta thread
          </a>
        }
      </ng-template>

      <header class="border-b px-4 pt-3 sm:px-6">
        <div class="flex items-center gap-2">
          <app-key-chip [value]="w.key" class="text-sm" />
          <app-inline-text
            class="min-w-0 flex-1"
            label="title"
            textClass="text-lg font-semibold tracking-tight"
            [value]="w.title"
            [canEdit]="canEdit()"
            (save)="store.updateWorkstream(w.id, { title: $event })"
          />
          @if (canEdit()) {
            <button hlmBtn variant="ghost" size="icon-sm" class="text-muted-foreground shrink-0" [hlmDropdownMenuTrigger]="more" aria-label="Workstream actions">
              <svg [lucideIcon]="moreIcon" [size]="16"></svg>
            </button>
          }
        </div>

        <div class="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-2 pb-2.5">
          <hlm-popover align="start" sideOffset="6" [state]="whyState()" (stateChanged)="whyState.set($event)">
            <button
              hlmPopoverTrigger
              type="button"
              class="hover:bg-muted focus-visible:ring-ring -ml-1 inline-flex h-7 items-center gap-1.5 rounded-md px-1 outline-none focus-visible:ring-2"
              [hlmTooltip]="explain().reasons[0]"
              position="bottom"
              [attr.aria-label]="'Status ' + statusLabel() + '. Why?'"
            >
              <app-status-badge [status]="w.status" />
              <span class="text-muted-foreground inline-flex items-center gap-1 text-xs">
                <svg [lucideIcon]="info" [size]="12"></svg>{{ w.statusOverride ? 'override' : 'derived' }}
              </span>
            </button>
            <hlm-popover-content *hlmPopoverPortal="let ctx" class="w-80 gap-2">
              <hlm-popover-header>
                <h3 hlmPopoverTitle class="flex items-center gap-1.5"><app-status-icon [status]="w.status" />{{ statusLabel() }}</h3>
                <p hlmPopoverDescription class="text-xs">{{ explain().headline }}</p>
              </hlm-popover-header>
              <ul class="flex list-disc flex-col gap-1 pl-4 text-xs">
                @for (r of explain().reasons; track $index) {
                  <li>{{ r }}</li>
                }
              </ul>
              <p class="text-muted-foreground border-t pt-2 text-[11px] leading-relaxed">
                Status is derived from artifacts, input requests, decisions and dependencies. Use the menu to mark it draft or canceled.
              </p>
              @if (canEdit()) {
                <div class="flex flex-wrap gap-1.5">
                  <button hlmBtn size="xs" variant="outline" (click)="override('draft')">Mark draft</button>
                  <button hlmBtn size="xs" variant="outline" (click)="override('canceled')">Mark canceled</button>
                  @if (w.statusOverride) {
                    <button hlmBtn size="xs" variant="ghost" (click)="override(null)"><svg [lucideIcon]="reset" [size]="12"></svg>Clear override</button>
                  }
                </div>
              }
            </hlm-popover-content>
          </hlm-popover>

          <a [routerLink]="['/', slug(), 'teams', ownerKey()]" class="hover:text-foreground text-muted-foreground inline-flex items-center gap-1.5 text-xs">
            <app-actor [actor]="{ type: 'team', id: w.ownerTeamId }" [size]="16" class="text-foreground" />
          </a>
          @if (w.accountableUserId) {
            <app-actor [actor]="{ type: 'user', id: w.accountableUserId }" [size]="16" class="text-xs" />
          }
          <app-priority-icon [priority]="w.priority" [showLabel]="true" class="text-xs" />
          <app-target-date [date]="w.targetDate" [done]="w.status === 'shipped' || w.status === 'canceled'" />
          <app-criteria-bar [met]="criteria().met" [inProgress]="criteria().prog" [total]="w.acceptanceCriteria.length" />
        </div>

        <hlm-tabs [tab]="current()" (tabActivated)="setTab($event)" class="-mx-4 sm:-mx-6">
          <div class="scrollbar-none overflow-x-auto px-4 sm:px-6">
            <hlm-tabs-list variant="line" class="h-9 w-max gap-1 p-0" aria-label="Workstream sections">
              @for (t of tabs; track t) {
                <button [hlmTabsTrigger]="t" class="h-9 flex-none px-2.5 after:bottom-0">
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

      <ng-template #more>
        <hlm-dropdown-menu class="w-52">
          <hlm-dropdown-menu-label>Status override</hlm-dropdown-menu-label>
          <hlm-dropdown-menu-group>
            <button hlmDropdownMenuItem (triggered)="override('draft')"><app-status-icon status="draft" /> Mark as draft</button>
            <button hlmDropdownMenuItem (triggered)="override('canceled')"><app-status-icon status="canceled" /> Mark as canceled</button>
            @if (w.statusOverride) {
              <button hlmDropdownMenuItem (triggered)="override(null)"><svg [lucideIcon]="reset" [size]="14"></svg> Clear override</button>
            }
          </hlm-dropdown-menu-group>
          <hlm-dropdown-menu-separator />
          <button hlmDropdownMenuItem variant="destructive" (triggered)="remove()"><svg [lucideIcon]="trash" [size]="14"></svg> Delete workstream</button>
        </hlm-dropdown-menu>
      </ng-template>
    } @else {
      <app-empty-state [icon]="flow" title="Workstream not found" description="It may have been deleted, or the key is wrong.">
        <a hlmBtn size="sm" variant="outline" [routerLink]="['/', slug(), 'workstreams']">Back to workstreams</a>
      </app-empty-state>
    }
  `,
})
export class WorkstreamDetailPage {
  protected readonly store = inject(NablaStore);
  private readonly ui = inject(UiStore);
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
  protected readonly trash = LucideTrash2;
  protected readonly flow = LucideWorkflow;
  protected readonly help = LucideCircleHelp;
  protected readonly whyState = signal<'open' | 'closed'>('closed');

  protected readonly slug = computed(() => this.store.slug() ?? '');
  protected readonly canEdit = computed(() => this.store.can('member'));
  protected readonly ws = computed(() => this.store.getWorkstream(this.key()));
  protected readonly ownerKey = computed(() => this.store.getTeam(this.ws()?.ownerTeamId)?.key ?? '');
  protected readonly statusLabel = computed(() => WORKSTREAM_STATUS_META[this.ws()?.status ?? 'draft'].label);
  protected readonly explain = computed(() => {
    const w = this.ws();
    return w ? explainStatus(this.store, w) : { headline: '', reasons: [''] };
  });
  protected readonly criteria = computed(() => {
    const list = this.ws()?.acceptanceCriteria ?? [];
    return { met: list.filter((c) => c.state === 'met').length, prog: list.filter((c) => c.state === 'in_progress').length };
  });
  protected readonly current = computed<Tab>(() => {
    const t = this.tab();
    return (TABS as readonly string[]).includes(t ?? '') ? (t as Tab) : 'overview';
  });
  protected readonly counts = computed<Partial<Record<Tab, number>>>(() => {
    const w = this.ws();
    if (!w) return {};
    return {
      artifacts: this.store.artifactsByWorkstream().get(w.id)?.length ?? 0,
      decisions: this.store.decisionsByWorkstream().get(w.id)?.length ?? 0,
    };
  });

  private readonly _crumbs = usePageCrumbs(() => [
    { label: 'Workstreams', link: ['/', this.slug(), 'workstreams'] },
    { label: this.ws()?.key ?? this.key() ?? '', mono: true },
  ]);

  private readonly _keys = usePageShortcuts([
    ...TABS.map((t, i) => ({
      keys: String(i + 1),
      label: `${TAB_LABEL[t]} tab`,
      run: () => this.setTab(t),
      when: () => !!this.ws(),
    })),
  ]);

  protected setTab(t: string | null | undefined): void {
    if (!t) return;
    void this.router.navigate([], {
      queryParams: { tab: t === 'overview' ? null : t },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  protected override(v: 'draft' | 'canceled' | null): void {
    const w = this.ws();
    if (!w) return;
    this.whyState.set('closed');
    void this.store.updateWorkstream(w.id, { statusOverride: v });
  }

  protected remove(): void {
    const w = this.ws();
    if (!w) return;
    this.ui.setConfirmDelete({
      title: `Delete ${w.key}?`,
      description: 'The workstream, its artifacts, comments and acceptance criteria are deleted. This cannot be undone.',
      onConfirm: async () => {
        if (await this.store.deleteWorkstream(w.id)) void this.router.navigate(['/', this.slug(), 'workstreams']);
      },
    });
  }
}
