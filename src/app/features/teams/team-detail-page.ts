import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { LucideDynamicIcon, LucideEllipsis, LucideFolderGit2, LucideHexagon, LucideInbox, LucideLink, LucidePlus, LucideTrash2, LucideUsers, LucideX } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import { TramaStore, ROLE_META, UiStore } from '../../core';
import { Clipboard } from '../../core/notify/notifier';
import { TopBarActions, usePageCrumbs } from '../../layout/page-chrome';
import { TEAM_EDIT_POLICIES, type TeamEditPolicy } from '../../core/contracts/domain';
import { ActorAvatar } from '../../shared/actor-avatar';
import { EmptyState } from '../../shared/empty-state';
import { KeyChip } from '../../shared/key-chip';
import { ProviderIcon } from '../../shared/provider-icon';
import { StatusIcon } from '../../shared/status';
import { AppSelect, type Option } from '../create/form-kit';
import { IssueRow } from '../issues/issue-items';
import { InlineText } from '../workstreams/inline-edit';
import { Picker } from '../workstreams/picker';
import { buildSummary } from '../workstreams/ws-model';
import { WorkstreamRow } from '../workstreams/workstream-items';
import { TeamColorPicker } from './team-colors';

type TeamTab = 'workstreams' | 'issues' | 'members' | 'repositories';
const TABS: TeamTab[] = ['workstreams', 'issues', 'members', 'repositories'];
const OPEN_ISSUE = new Set(['backlog', 'todo', 'in_progress', 'in_review']);

@Component({
  selector: 'app-team-detail-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    HlmButtonImports,
    HlmDropdownMenuImports,
    HlmTooltip,
    LucideDynamicIcon,
    TopBarActions,
    ActorAvatar,
    EmptyState,
    KeyChip,
    ProviderIcon,
    StatusIcon,
    InlineText,
    Picker,
    WorkstreamRow,
    IssueRow,
    TeamColorPicker,
    AppSelect,
  ],
  host: { class: 'flex min-h-full flex-col' },
  template: `
    @if (team(); as t) {
      <ng-template appTopBarActions>
        @if (canNewIssue()) {
          <button hlmBtn variant="outline" size="sm" (click)="newIssue()">
            <svg [lucideIcon]="plus" [size]="14"></svg><span>Issue</span>
          </button>
        }
        @if (canNewWorkstream()) {
          <button hlmBtn size="sm" (click)="newWorkstream()">
            <svg [lucideIcon]="plus" [size]="14"></svg><span>Workstream</span>
          </button>
        }
        <button hlmBtn variant="ghost" size="icon-sm" class="text-muted-foreground" [hlmDropdownMenuTrigger]="more" aria-label="Team actions">
          <svg [lucideIcon]="moreIcon" [size]="16"></svg>
        </button>
        <ng-template #more>
          <hlm-dropdown-menu class="w-44">
            <button hlmDropdownMenuItem (triggered)="copyLink()">
              <svg [lucideIcon]="linkIcon" [size]="14"></svg> Copy link
            </button>
            @if (canDelete()) {
              <button hlmDropdownMenuItem variant="destructive" (triggered)="remove()">
                <svg [lucideIcon]="trash" [size]="14"></svg> Delete team
              </button>
            }
          </hlm-dropdown-menu>
        </ng-template>
      </ng-template>

      <header class="px-4 pt-5 sm:px-6">
        <div class="flex min-w-0 items-center gap-2">
          <app-team-color-picker [color]="t.color" [canEdit]="canManage()" [size]="14" (colorChange)="saveColor($event)" />
          <app-inline-text class="min-w-0 flex-1" label="name" textClass="text-xl font-semibold tracking-tight" [value]="t.name" [canEdit]="canManage()" (save)="saveName($event)" />
          <app-key-chip [value]="t.key" hlmTooltip="The key prefixes this team's workstream keys and cannot change" />
        </div>
        <app-inline-text
          class="mt-1 block"
          label="description"
          placeholder="Add a description…"
          textClass="text-muted-foreground text-[13px]"
          [value]="t.description ?? ''"
          [allowEmpty]="true"
          [canEdit]="canManage()"
          (save)="saveDescription($event)"
        />
        <div class="text-muted-foreground mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          <span class="flex items-center gap-1.5"><app-status-icon status="working" entity="workstream" [size]="12" /> {{ activeOwned() }} active workstreams</span>
          <span class="flex items-center gap-1.5"><app-status-icon status="todo" entity="issue" [size]="12" /> {{ openIssues() }} open issues</span>
          <span>{{ t.memberIds.length }} {{ t.memberIds.length === 1 ? 'member' : 'members' }}</span>
          <span>Key <span class="font-mono">{{ t.key }}</span> · workstreams are numbered {{ t.key }}-1, {{ t.key }}-2…</span>
        </div>

        <nav class="-mb-px mt-4 flex gap-4 overflow-x-auto border-b" role="tablist" aria-label="Team sections">
          @for (x of tabs; track x) {
            <button
              type="button"
              role="tab"
              class="hover:text-foreground -mb-px flex shrink-0 items-center gap-1.5 border-b-2 py-2 text-[13px] transition-colors"
              [class]="tab() === x ? 'border-foreground text-foreground font-medium' : 'text-muted-foreground border-transparent'"
              [attr.aria-selected]="tab() === x"
              (click)="setTab(x)"
            >
              {{ tabLabel(x) }}
              <span class="text-muted-foreground tabular-nums">{{ tabCount(x) }}</span>
            </button>
          }
        </nav>
      </header>

      <div class="min-w-0 flex-1 pb-8">
        @switch (tab()) {
          @case ('workstreams') {
            @if (owned().length || participating().length) {
              @if (owned().length) {
                <h2 class="text-muted-foreground bg-muted/30 border-b px-4 py-1.5 text-xs font-medium sm:px-6">Owned · {{ owned().length }}</h2>
                @for (s of owned(); track s.ws.id) {
                  <app-workstream-row [summary]="s" />
                }
              }
              @if (participating().length) {
                <h2 class="text-muted-foreground bg-muted/30 border-b px-4 py-1.5 text-xs font-medium sm:px-6">Participating · {{ participating().length }}</h2>
                @for (s of participating(); track s.ws.id) {
                  <app-workstream-row [summary]="s" />
                }
              }
            } @else {
              <app-empty-state
                [icon]="layers"
                title="No workstreams yet"
                [description]="'Workstreams (hexagons) are the outcomes ' + t.name + ' owns and ships — a goal with acceptance criteria, agents and pull requests. Their keys start with ' + t.key + '-.'"
              >
                @if (canNewWorkstream()) {
                  <button hlmBtn size="sm" (click)="newWorkstream()"><svg [lucideIcon]="plus" [size]="14"></svg>New workstream</button>
                }
              </app-empty-state>
            }
          }
          @case ('issues') {
            @if (issues().length) {
              @for (i of issues(); track i.id) {
                <app-issue-row [issue]="i" />
              }
            } @else {
              <app-empty-state
                [icon]="inbox"
                title="No issues for this team"
                [description]="'Issues (circles) are incoming demand — bugs, requests and incidents — that ' + t.name + ' triages. Link one to a workstream when the team commits to an outcome.'"
              >
                @if (canNewIssue()) {
                  <button hlmBtn size="sm" variant="outline" (click)="newIssue()"><svg [lucideIcon]="plus" [size]="14"></svg>New issue</button>
                }
              </app-empty-state>
            }
          }
          @case ('members') {
            <div class="flex flex-col gap-2 border-b px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6 sm:px-6">
              <div class="min-w-0">
                <div class="text-[13px] font-medium">Who can edit this team's work</div>
                <div class="text-muted-foreground text-xs leading-snug">
                  {{ policyMeta(t.editPolicy).description }} Workspace admins always can.
                </div>
              </div>
              @if (canManage()) {
                <div class="sm:w-56 sm:shrink-0">
                  <app-select size="sm" label="Edit policy" [options]="policyOptions" [value]="t.editPolicy" (valueChange)="setPolicy($event)" />
                </div>
              } @else {
                <span class="text-muted-foreground text-xs">{{ policyMeta(t.editPolicy).label }}</span>
              }
            </div>
            <div class="flex items-center justify-between gap-2 border-b px-4 py-2 sm:px-6">
              <span class="text-muted-foreground text-xs">
                Team <strong class="text-foreground font-medium">leads</strong> can edit the team and its members. Members see its attention items and can be assigned its work.
              </span>
              @if (canManage()) {
                <app-picker
                  variant="chip"
                  label="Add member"
                  searchPlaceholder="Add someone…"
                  [options]="addableUsers()"
                  [value]="[]"
                  (valueChange)="addMembers($event)"
                />
              }
            </div>
            @for (m of members(); track m.id) {
              <div class="hover:bg-muted/40 group flex items-center gap-3 border-b px-4 py-2 sm:px-6">
                <app-actor-avatar [actor]="{ type: 'user', id: m.id }" [size]="24" />
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-[13px] font-medium">{{ m.name }}</span>
                  <span class="text-muted-foreground block truncate text-xs">{{ m.email }}</span>
                </span>
                <span class="text-muted-foreground hidden w-16 text-right text-xs sm:block" title="Workspace role">{{ m.role }}</span>
                @if (canManage()) {
                  <div class="w-28 shrink-0">
                    <app-select size="sm" [attr.aria-label]="'Team role of ' + m.name" label="Team role" [options]="teamRoleOptions" [value]="m.lead ? 'lead' : 'member'" (valueChange)="setLead(m.id, $event === 'lead')" />
                  </div>
                } @else {
                  <span class="text-muted-foreground w-16 text-right text-xs">{{ m.lead ? 'Lead' : 'Member' }}</span>
                }
                @if (canManage()) {
                  <button
                    hlmBtn
                    variant="ghost"
                    size="icon-sm"
                    class="text-muted-foreground opacity-60 group-hover:opacity-100"
                    [attr.aria-label]="'Remove ' + m.name + ' from ' + t.name"
                    hlmTooltip="Remove from team"
                    (click)="removeMember(m.id)"
                  >
                    <svg [lucideIcon]="xIcon" [size]="14"></svg>
                  </button>
                }
              </div>
            } @empty {
              <app-empty-state [icon]="usersIcon" title="No members yet" description="Add the people who own this team's workstreams and triage its issues." />
            }
          }
          @case ('repositories') {
            @for (p of repositories(); track p.id) {
              <a class="hover:bg-muted/60 flex items-center gap-2.5 border-b px-4 py-2 sm:px-6" [routerLink]="['/', slug(), 'repositories', p.id]">
                <app-provider-icon [provider]="p.provider" [size]="14" />
                <span class="min-w-0 flex-1 truncate font-mono text-[13px]">{{ p.fullName }}</span>
                <span class="text-muted-foreground font-mono text-xs">{{ p.defaultBranch }}</span>
              </a>
            } @empty {
              <app-empty-state [icon]="folder" title="No repositories" description="The repositories this team's workstreams land in. Assign a team on a repository's page." >
                <a hlmBtn size="sm" variant="outline" [routerLink]="['/', slug(), 'repositories']">Browse repositories</a>
              </app-empty-state>
            }
          }
        }
      </div>
    } @else {
      <app-empty-state [icon]="usersIcon" title="Team not found" description="It may have been deleted.">
        <a hlmBtn size="sm" variant="outline" [routerLink]="['/', slug(), 'teams']">Back to teams</a>
      </app-empty-state>
    }
  `,
})
export class TeamDetailPage {
  readonly workspaceSlug = input<string>();
  readonly key = input<string>();
  /** Query `?tab=issues`. */
  readonly tabParam = input<string>(undefined, { alias: 'tab' });

  private readonly store = inject(TramaStore);
  private readonly ui = inject(UiStore);
  private readonly router = inject(Router);
  private readonly clipboard = inject(Clipboard);

  protected readonly tabs = TABS;
  protected readonly moreIcon = LucideEllipsis;
  protected readonly trash = LucideTrash2;
  protected readonly usersIcon = LucideUsers;
  protected readonly plus = LucidePlus;
  protected readonly xIcon = LucideX;
  protected readonly linkIcon = LucideLink;
  protected readonly inbox = LucideInbox;
  protected readonly folder = LucideFolderGit2;
  protected readonly layers = LucideHexagon;

  protected readonly slug = computed(() => this.store.slug() ?? this.workspaceSlug() ?? '');
  protected readonly team = computed(() => this.store.getTeam(this.key()));
  /** Edit the team itself: the `manageTeams` capability, or being one of its leads. */
  protected readonly canManage = computed(() => this.store.allowed('manageTeams') || this.store.isTeamLead(this.team()?.id));
  protected readonly canDelete = computed(() => this.store.allowed('manageTeams'));
  protected readonly canNewIssue = computed(() => this.store.allowed('createIssues') && this.store.canEditTeamWork(this.team()?.id));
  protected readonly canNewWorkstream = computed(() => this.store.allowed('createWorkstreams') && this.store.canEditTeamWork(this.team()?.id));
  protected readonly policyOptions: Option[] = (Object.keys(TEAM_EDIT_POLICIES) as TeamEditPolicy[]).map((p) => ({ value: p, label: TEAM_EDIT_POLICIES[p].label }));
  protected readonly teamRoleOptions: Option[] = [
    { value: 'member', label: 'Member' },
    { value: 'lead', label: 'Lead' },
  ];
  protected policyMeta(p: TeamEditPolicy) {
    return TEAM_EDIT_POLICIES[p];
  }
  protected readonly tab = computed<TeamTab>(() => {
    const t = this.tabParam();
    return TABS.includes(t as TeamTab) ? (t as TeamTab) : 'workstreams';
  });

  protected readonly owned = computed(() => {
    const id = this.team()?.id;
    return id ? (this.store.workstreamsByOwnerTeam().get(id) ?? []).map((ws) => buildSummary(this.store, ws)) : [];
  });
  protected readonly participating = computed(() => {
    const id = this.team()?.id;
    return id ? (this.store.workstreamsByParticipatingTeam().get(id) ?? []).map((ws) => buildSummary(this.store, ws)) : [];
  });
  protected readonly activeOwned = computed(
    () => this.owned().filter((s) => s.ws.status !== 'shipped' && s.ws.status !== 'canceled').length,
  );
  protected readonly issues = computed(() => {
    const id = this.team()?.id;
    if (!id) return [];
    const order = (s: string) => (OPEN_ISSUE.has(s) ? 0 : 1);
    return [...(this.store.issuesByTeam().get(id) ?? [])].sort(
      (a, b) => order(a.status) - order(b.status) || (a.updatedAt < b.updatedAt ? 1 : -1),
    );
  });
  protected readonly openIssues = computed(() => this.issues().filter((i) => OPEN_ISSUE.has(i.status)).length);
  protected readonly members = computed(() => {
    const t = this.team();
    if (!t) return [];
    return t.memberIds
      .map((id) => this.store.userById().get(id))
      .filter((u) => !!u)
      .map((u) => {
        const role = this.store.membershipByUserId().get(u.id)?.role;
        return { id: u.id, name: u.name, email: u.email, role: role ? ROLE_META[role].label : '', lead: t.leadIds.includes(u.id) };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  });
  protected readonly addableUsers = computed(() => {
    const ids = new Set(this.team()?.memberIds ?? []);
    return this.store
      .users()
      .filter((u) => !ids.has(u.id) && this.store.membershipByUserId().has(u.id))
      .map((u) => ({ value: u.id, label: u.name, kind: 'user' as const, search: `${u.name} ${u.email}` }));
  });
  protected readonly repositories = computed(() => {
    const id = this.team()?.id;
    if (!id) return [];
    return this.store
      .repositories()
      .filter((r) => r.teamIds.includes(id))
      .sort((a, b) => a.fullName.localeCompare(b.fullName));
  });

  private readonly _crumbs = usePageCrumbs(() => [
    { label: 'Teams', link: ['/', this.slug(), 'teams'] },
    { label: this.team()?.key ?? this.key() ?? '', mono: true },
  ]);

  protected tabLabel(t: TeamTab): string {
    return t === 'workstreams' ? 'Workstreams' : t === 'issues' ? 'Issues' : t === 'members' ? 'Members' : 'Repositories';
  }
  protected tabCount(t: TeamTab): number {
    switch (t) {
      case 'workstreams':
        return this.owned().length + this.participating().length;
      case 'issues':
        return this.issues().length;
      case 'members':
        return this.members().length;
      case 'repositories':
        return this.repositories().length;
    }
  }
  protected setTab(t: TeamTab): void {
    void this.router.navigate([], { queryParams: { tab: t === 'workstreams' ? null : t }, queryParamsHandling: 'merge', replaceUrl: true });
  }

  protected saveName(name: string): void {
    const t = this.team();
    if (t && name.trim() && name.trim() !== t.name) void this.store.updateTeam(t.id, { name: name.trim() });
  }
  protected saveDescription(description: string): void {
    const t = this.team();
    if (t && description.trim() !== (t.description ?? '')) void this.store.updateTeam(t.id, { description: description.trim() || null });
  }
  protected saveColor(color: string): void {
    const t = this.team();
    if (t) void this.store.updateTeam(t.id, { color });
  }
  protected addMembers(ids: string[]): void {
    const t = this.team();
    if (!t || !ids.length) return;
    void this.store.updateTeam(t.id, { memberIds: [...new Set([...t.memberIds, ...ids])] });
  }
  protected removeMember(userId: string): void {
    const t = this.team();
    if (t) void this.store.updateTeam(t.id, { memberIds: t.memberIds.filter((id) => id !== userId), leadIds: t.leadIds.filter((id) => id !== userId) });
  }
  protected setLead(userId: string, lead: boolean): void {
    const t = this.team();
    if (!t) return;
    const leads = new Set(t.leadIds);
    if (lead) leads.add(userId);
    else leads.delete(userId);
    void this.store.updateTeam(t.id, { leadIds: [...leads] });
  }
  protected setPolicy(value: string): void {
    const t = this.team();
    if (t && value !== t.editPolicy) void this.store.updateTeam(t.id, { editPolicy: value as TeamEditPolicy });
  }
  protected copyLink(): void {
    void this.clipboard.copy(location.href, 'Link copied');
  }
  protected newWorkstream(): void {
    const t = this.team();
    if (t) this.ui.openCreate('workstream', { ownerTeamId: t.id });
  }
  protected newIssue(): void {
    const t = this.team();
    if (t) this.ui.openCreate('issue', { teamId: t.id });
  }
  protected remove(): void {
    const t = this.team();
    if (!t) return;
    this.ui.setConfirmDelete({
      title: `Delete ${t.name}?`,
      description: 'Only possible while it owns no workstreams. Issues and repositories are detached from it.',
      onConfirm: async () => {
        const ok = await this.store.deleteTeam(t.id);
        if (ok) await this.router.navigate(['/', this.slug(), 'teams']);
      },
    });
  }
}
