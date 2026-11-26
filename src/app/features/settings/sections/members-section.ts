import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  LucideCrown,
  LucideDynamicIcon,
  LucideEllipsis,
  LucideFolderLock,
  LucideMail,
  LucideSearch,
  LucideShield,
  LucideUserPlus,
  LucideX,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmCheckbox } from '@spartan-ng/helm/checkbox';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import { LiveSync } from '../../../core/sync/live-sync.service';
import { InvitesStore } from '../../../core/stores/invites.store';
import { TramaStore } from '../../../core/stores/trama.store';
import { UiStore } from '../../../core/stores/ui.store';
import {
  canGrantRole,
  emptyMemberAccess,
  findWorkspaceRole,
  GUEST_ROLE_ID,
  MEMBER_GRANTS,
  normalizeMemberAccess,
  workspaceRoleName,
  type InviteLink,
  type MemberAccess,
  type MemberGrant,
  type Membership,
  type Role,
  type WorkspaceInvite,
} from '../../../core/contracts/domain';
import { ActorAvatar } from '../../../shared/actor-avatar';
import { ago } from '../../../shared/ago';
import { AppSelect, type Option } from '../../create/form-kit';
import { MemberAccessEditor } from './member-access-editor';
import { MembersInviteDialog } from './members-invite-dialog';
import { memberRules, type MemberUiRules } from './member-permissions';
import { SECTION_KIT, SETTINGS_SELECT } from './section-kit';

const DAY_MS = 24 * 60 * 60 * 1000;
const ANY = 'any';

interface MemberTab {
  value: string;
  label: string;
  count: number;
}

/** People in the workspace: invite by email, change roles and project access, remove. Guests are listed with their projects. */
@Component({
  selector: 'app-members-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    HlmButtonImports,
    HlmCheckbox,
    HlmDropdownMenuImports,
    LucideDynamicIcon,
    ActorAvatar,
    AppSelect,
    MemberAccessEditor,
    MembersInviteDialog,
    NgTemplateOutlet,
    ...SECTION_KIT,
  ],
  host: { class: 'flex flex-col gap-9' },
  template: `
    <app-section-header
      flush
      title="Members"
      description="People in {{ store.slug() ?? 'this workspace' }}. Members get the projects their role and access allow; guests only see the projects they were invited to."
    >
      @if (canInvite()) {
        <button actions hlmBtn size="sm" type="button" (click)="inviting.set(true)">
          <svg [lucideIcon]="userPlusIcon" [size]="13"></svg> Invite people
        </button>
      }
    </app-section-header>

    @if (sent(); as s) {
      <div class="border-border bg-card border px-3.5 py-3" role="status">
        <p class="text-[13px] leading-snug">
          @if (s.link.emailed) {
            Invitation emailed to
            <span class="text-foreground font-mono text-[12px]">{{ s.link.invite.email }}</span
            >. You can also share this link:
          } @else {
            Email is not set up on this server. Share this link with
            <span class="text-foreground font-mono text-[12px]">{{ s.link.invite.email }}</span
            >:
          }
        </p>
        <app-copy-field class="mt-2" [value]="s.link.url" label="Invite link" />
        <p class="text-faint mt-1.5 font-mono text-[10.5px]">
          It works for 7 days and only for that email address. Sending again replaces it.
        </p>
      </div>
    }

    <div class="flex flex-col gap-3.5">
      <div class="border-border flex flex-wrap gap-x-[18px] border-b" role="tablist" aria-label="Show">
        @for (t of tabs(); track t.value) {
          <button
            type="button"
            role="tab"
            class="focus-visible:ring-ring/50 -mb-px flex items-center gap-1.5 border-b-2 pb-[9px] text-[13px] leading-[normal] outline-none focus-visible:ring-2"
            [class]="t.value === tab() ? 'text-foreground border-primary' : 'text-muted-foreground hover:text-foreground border-transparent'"
            [attr.aria-selected]="t.value === tab()"
            (click)="tab.set(t.value)"
          >
            {{ t.label }}
            <span class="text-faint font-mono text-[10.5px] leading-[normal]">{{ t.count }}</span>
          </button>
        }
      </div>

      @if (tab() !== 'pending') {
        <div class="flex flex-wrap items-center gap-2 ${SETTINGS_SELECT}">
          <label
            class="bg-background border-border focus-within:border-primary flex w-full items-center gap-2 border px-[9px] py-1.5 sm:w-[280px]"
          >
            <svg [lucideIcon]="searchIcon" [size]="13" class="text-faint shrink-0"></svg>
            <input
              class="text-foreground placeholder:text-faint min-w-0 flex-1 bg-transparent text-[13px] leading-[normal] outline-none"
              placeholder="Search name or email"
              aria-label="Search members"
              [value]="query()"
              (input)="query.set($any($event.target).value)"
            />
          </label>
          @if (projectOptions().length > 1) {
            <div class="w-40">
              <app-select size="sm" label="Project" [options]="projectOptions()" [(value)]="projectFilter" />
            </div>
          }
          <div class="w-[140px]">
            <app-select size="sm" label="Role" [options]="roleFilterOptions()" [(value)]="roleFilter" />
          </div>
          <span class="flex-1"></span>
          <span class="text-faint font-mono text-[10.5px] leading-[normal]">{{ counts().members }} members · {{ counts().guests }} guests</span>
        </div>
      }
    </div>

    @if (tab() !== 'pending') {
      <div class="bg-card border-border border">
        <div
          class="bg-bg-deep text-faint hidden items-center gap-4 px-4 py-2 font-mono text-[10.5px] leading-[normal] uppercase sm:flex"
        >
          <span class="min-w-0 flex-1">Member</span>
          <span class="w-[150px] shrink-0">Role</span>
          <span class="w-[170px] shrink-0">Access</span>
          <span class="w-[14px] shrink-0"></span>
        </div>
        @for (m of shown(); track m.membership.id) {
          @let rules = rulesFor(m.membership);
          <div class="border-border flex flex-wrap items-center gap-x-4 gap-y-2 border-t px-4 py-2.5 sm:flex-nowrap">
            <div class="flex min-w-0 flex-1 items-center gap-2">
              <app-actor-avatar [actor]="{ type: 'user', id: m.user.id }" [size]="26" />
              <div class="flex min-w-0 flex-col gap-0.5">
                <div class="truncate text-[13px] leading-[normal]">
                  <span class="text-foreground">{{ m.user.name }}</span>
                  @if (m.user.id === meId()) {
                    <span class="text-faint"> · you</span>
                  }
                </div>
                <div class="text-faint truncate font-mono text-[10.5px] leading-[normal]">{{ m.user.email }}</div>
              </div>
            </div>
            <div class="flex w-[150px] shrink-0 items-center gap-2">
              @if (canAdmin() && !rules.roleLocked) {
                <div class="w-[130px] min-w-0 ${SETTINGS_SELECT}">
                  <app-select
                    size="sm"
                    [options]="roleOptionsFor(m.membership.role)"
                    [value]="m.membership.role"
                    (valueChange)="setRole(m.membership, $event)"
                    label="Role"
                  />
                </div>
              } @else {
                @if (m.membership.role === 'owner') {
                  <svg [lucideIcon]="crownIcon" [size]="12" class="text-primary shrink-0"></svg>
                }
                <span
                  class="text-text-2 text-[13px] leading-[normal]"
                  [class.cursor-help]="!!rules.roleLocked"
                  [attr.title]="rules.roleLocked"
                  [attr.tabindex]="rules.roleLocked ? 0 : null"
                  >{{ roleName(m.membership.role) }}</span
                >
              }
            </div>
            <div class="text-text-2 flex w-[170px] shrink-0 items-center gap-2 text-[12.5px] leading-[normal]" [attr.title]="accessLabel(m.membership)">
              @if (m.membership.role === guestId) {
                <svg [lucideIcon]="folderLockIcon" [size]="12" class="text-muted-foreground shrink-0"></svg>
              }
              <span class="min-w-0 truncate">{{ accessLabel(m.membership) }}</span>
            </div>
            <div class="flex w-[14px] shrink-0 items-center justify-center">
              @if (canAdmin() && (rules.canTransfer || (m.membership.role !== 'owner' && !rules.roleLocked) || !rules.removeLocked)) {
                <button
                  type="button"
                  class="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 -m-2 p-2 outline-none focus-visible:ring-2"
                  [hlmDropdownMenuTrigger]="rowMenu"
                  [attr.aria-label]="'Actions for ' + m.user.name"
                >
                  <svg [lucideIcon]="ellipsisIcon" [size]="14"></svg>
                </button>
                <ng-template #rowMenu>
                  <hlm-dropdown-menu class="w-44">
                    @if (rules.canTransfer) {
                      <button hlmDropdownMenuItem (triggered)="transfer(m.membership.id, m.user.name)">Make owner</button>
                    }
                    @if (m.membership.role !== 'owner' && !rules.roleLocked) {
                      <button hlmDropdownMenuItem (triggered)="openAccess(m.membership)">Edit access</button>
                    }
                    @if (!rules.removeLocked) {
                      <hlm-dropdown-menu-separator />
                      <button hlmDropdownMenuItem variant="destructive" (triggered)="remove(m.membership.id, m.user.name)">
                        <svg [lucideIcon]="xIcon" [size]="14"></svg> Remove
                      </button>
                    }
                  </hlm-dropdown-menu>
                </ng-template>
              }
            </div>
          </div>
          @if (editingId() === m.membership.id) {
            <div class="border-border bg-bg-deep border-t px-4 py-3.5">
              @if (m.membership.role !== guestId) {
                <label class="flex items-start gap-2 text-[13px]">
                  <hlm-checkbox class="mt-0.5" [checked]="draftCustom()" (checkedChange)="setDraftCustom(m.membership, $event)" />
                  <span>
                    <span class="text-foreground">Adjust {{ m.user.name }}</span>
                    <span class="text-muted-foreground block text-[12px] leading-snug">Off keeps the {{ roleName(m.membership.role) }} role as it is. On lets you limit projects or add actions.</span>
                  </span>
                </label>
              }
              @if (draftCustom() || m.membership.role === guestId) {
                <app-member-access-editor class="mt-3" [role]="m.membership.role" [locked]="baseline(m.membership.role)" [projects]="projectChoices()" [disabled]="busy()" [(value)]="draft" />
              }
              <div class="mt-3 flex gap-2">
                <button hlmBtn size="sm" type="button" [disabled]="busy() || !draftValid(m.membership)" (click)="saveAccess(m.membership.id)">Save access</button>
                <button hlmBtn size="sm" variant="ghost" type="button" (click)="editingId.set(null)">Cancel</button>
              </div>
            </div>
          }
        } @empty {
          <div class="text-muted-foreground border-border border-t px-4 py-6 text-center text-[13px]">
            @if (filtering()) {
              No one matches these filters.
            } @else if (tab() === 'guests') {
              No guests yet. Guests are added from a project's Share button.
            } @else {
              No one here yet.
            }
          </div>
        }
      </div>

      <div class="bg-card border-border flex gap-2.5 border px-3.5 py-2.5">
        <svg [lucideIcon]="folderLockIcon" [size]="14" class="text-text-2 mt-[3px] shrink-0"></svg>
        <p class="text-text-2 text-[12.5px] leading-[19px]">
          Guests are added from a project's Share menu. To give a guest more projects, invite them to another project or open their row. Promoting a guest to member is just a role change.
        </p>
      </div>

      @if (canInvite() && pending().length) {
        <app-settings-block title="Pending invitations" [caption]="'' + pending().length">
          <ng-container *ngTemplateOutlet="inviteTable" />
        </app-settings-block>
      }
    } @else {
      @if (pending().length) {
        <ng-container *ngTemplateOutlet="inviteTable" />
      } @else {
        <div class="bg-card text-muted-foreground border-border border px-4 py-6 text-center text-[13px]">
          No invitations waiting.
        </div>
      }
    }

    <div class="bg-card border-border flex gap-2.5 border px-3.5 py-2.5">
      <svg [lucideIcon]="shieldIcon" [size]="14" class="text-text-2 mt-[3px] shrink-0"></svg>
      <p class="text-text-2 text-[12.5px] leading-[19px]">
        Removing someone keeps their tasks, comments and time entries. Projects belong to the workspace, so nothing leaves with them. Their agents, API tokens and personal connections stop working here at once.
      </p>
    </div>

    <ng-template #inviteTable>
      <div class="bg-card border-border border">
        <div
          class="bg-bg-deep text-faint hidden items-center gap-4 px-4 py-2 font-mono text-[10.5px] leading-[normal] uppercase sm:flex"
        >
          <span class="min-w-0 flex-1">Email</span>
          <span class="w-[200px] shrink-0">Joins as</span>
          <span class="w-[230px] shrink-0">Invited by</span>
          <span class="w-[110px] shrink-0"></span>
        </div>
        @for (i of pending(); track i.id) {
          <div class="border-border flex flex-wrap items-center gap-x-4 gap-y-2 border-t px-4 py-2 sm:flex-nowrap">
            <div class="flex min-w-0 flex-1 items-center gap-2">
              <svg [lucideIcon]="mailIcon" [size]="14" class="text-muted-foreground shrink-0"></svg>
              <span class="text-foreground truncate text-[13px] leading-[normal]">{{ i.email }}</span>
            </div>
            <span class="text-text-2 w-[200px] shrink-0 truncate font-mono text-[10.5px] leading-[normal]">
              {{ roleName(i.role) }} · {{ inviteAccess(i) }}
            </span>
            <span
              class="text-muted-foreground w-[230px] shrink-0 truncate font-mono text-[10.5px] leading-[normal]"
              [class.text-red]="expired(i)"
            >
              {{ inviter(i) }} · {{ createdAgo(i) }} · {{ expiry(i) }}
            </span>
            <div class="flex w-[110px] shrink-0 items-center justify-end">
              <button
                hlmBtn
                variant="ghost"
                size="sm"
                type="button"
                class="text-text-2"
                [disabled]="busy()"
                (click)="resend(i)"
              >
                Resend
              </button>
              <button
                hlmBtn
                variant="ghost"
                size="icon-sm"
                type="button"
                class="text-text-2"
                [attr.aria-label]="'Revoke invitation for ' + i.email"
                (click)="confirmRevoke(i)"
              >
                <svg [lucideIcon]="xIcon" [size]="13"></svg>
              </button>
            </div>
          </div>
        }
      </div>
    </ng-template>

    <app-members-invite-dialog [open]="inviting()" (closed)="inviting.set(false)" />
  `,
})
export class MembersSection {
  protected readonly store = inject(TramaStore);
  private readonly ui = inject(UiStore);
  private readonly invites = inject(InvitesStore);
  private readonly live = inject(LiveSync);

  protected readonly guestId = GUEST_ROLE_ID;
  protected readonly searchIcon = LucideSearch;
  protected readonly xIcon = LucideX;
  protected readonly crownIcon = LucideCrown;
  protected readonly ellipsisIcon = LucideEllipsis;
  protected readonly folderLockIcon = LucideFolderLock;
  protected readonly mailIcon = LucideMail;
  protected readonly shieldIcon = LucideShield;
  protected readonly userPlusIcon = LucideUserPlus;
  protected readonly inviting = signal(false);
  /** `all` · `members` · `guests` · `pending` */
  protected readonly tab = signal<string>('all');
  protected readonly projectFilter = signal(ANY);
  protected readonly roleFilter = signal(ANY);
  protected readonly editingId = signal<string | null>(null);
  protected readonly draftCustom = signal(false);
  protected readonly draft = signal<MemberAccess>(emptyMemberAccess());
  protected readonly query = signal('');
  protected readonly busy = signal(false);
  protected readonly canAdmin = computed(() => this.store.can('admin'));
  protected readonly canInvite = computed(() => this.store.allowed('inviteMembers'));
  /** Invitations are only listed for people who can send them. */
  protected readonly pending = computed(() => (this.canInvite() ? this.invites.invites() : []));
  /** The link of the invitation just resent (the only time it is available). */
  protected readonly sent = signal<{ link: InviteLink } | null>(null);
  protected readonly workspaceRoles = computed(() => this.store.settings().roles);
  protected readonly meId = computed(() => this.store.me()?.id);
  protected readonly projectChoices = computed(() =>
    [...this.store.projects()].map((project) => ({ id: project.id, name: project.name })).sort((a, b) => a.name.localeCompare(b.name)),
  );
  private readonly projectName = computed(() => new Map(this.store.projects().map((project) => [project.id, project.name])));

  protected readonly counts = computed(() => {
    const rows = this.store.members();
    const guests = rows.filter((m) => m.membership.role === GUEST_ROLE_ID).length;
    return { all: rows.length, guests, members: rows.length - guests, pending: this.pending().length };
  });
  protected readonly tabs = computed<MemberTab[]>(() => {
    const c = this.counts();
    const tabs: MemberTab[] = [
      { value: 'all', label: 'All', count: c.all },
      { value: 'members', label: 'Members', count: c.members },
      { value: 'guests', label: 'Guests', count: c.guests },
    ];
    if (this.canInvite()) tabs.push({ value: 'pending', label: 'Pending', count: c.pending });
    return tabs;
  });
  protected readonly projectOptions = computed<Option[]>(() => [
    { value: ANY, label: 'Any project' },
    ...this.projectChoices().map((p) => ({ value: p.id, label: p.name })),
  ]);
  protected readonly roleFilterOptions = computed<Option[]>(() => [
    { value: ANY, label: 'Any role' },
    ...this.workspaceRoles().map((role) => ({ value: role.id, label: role.name })),
  ]);
  protected readonly filtering = computed(
    () => !!this.query().trim() || this.projectFilter() !== ANY || this.roleFilter() !== ANY,
  );
  protected readonly shown = computed(() => {
    const q = this.query().trim().toLowerCase();
    const tab = this.tab();
    const project = this.projectFilter();
    const role = this.roleFilter();
    return this.store.members().filter((m) => {
      const guest = m.membership.role === GUEST_ROLE_ID;
      if (tab === 'guests' && !guest) return false;
      if (tab === 'members' && guest) return false;
      if (role !== ANY && m.membership.role !== role) return false;
      if (project !== ANY && !this.onProject(m.membership, project)) return false;
      return !q || `${m.user.name} ${m.user.email}`.toLowerCase().includes(q);
    });
  });

  /** A role I can grant: its permissions are inside mine. Owners can grant any role. */
  private readonly grantable = computed<Option[]>(() => {
    const mine = findWorkspaceRole(this.workspaceRoles(), this.store.myRole() ?? '');
    return this.workspaceRoles().filter((role) => canGrantRole(mine, role)).map((role) => ({ value: role.id, label: role.name }));
  });

  constructor() {
    effect(() => {
      if (this.canInvite() && this.store.slug()) untracked(() => void this.invites.load());
    });
    effect(() => {
      // The tab can disappear (no right to invite): fall back to the full list.
      if (this.tab() === 'pending' && !this.canInvite()) untracked(() => this.tab.set('all'));
    });
    // Someone else invited, revoked or accepted: keep the list current.
    this.live.events$.pipe(takeUntilDestroyed()).subscribe((e) => {
      if (e.entity === 'invite' && this.canInvite()) void this.invites.load();
    });
  }

  /** Roles I may assign; the row's current role always stays listed. */
  protected roleOptionsFor(current: Role): Option[] {
    const allowed = new Set(this.grantable().map((option) => option.value));
    return this.workspaceRoles()
      .map((role) => ({ value: role.id, label: role.name }))
      .filter((option) => option.value === current || allowed.has(option.value));
  }
  protected rulesFor(m: Membership): MemberUiRules {
    return memberRules(
      {
        meId: this.meId(),
        myRole: this.store.myRole(),
        primaryOwnerId: this.store.workspace()?.primaryOwnerId,
        ownerCount: this.store.memberships().filter((x) => x.role === 'owner').length,
      },
      m,
    );
  }

  private onProject(m: Membership, projectId: string): boolean {
    const access = m.access;
    if (access && !access.projects.all) return access.projects.projectIds.includes(projectId);
    return m.role !== GUEST_ROLE_ID;
  }

  /** "All projects", or the names of the ones they were given ("Web, API +2"). */
  protected accessLabel(m: Membership): string {
    const access = m.access;
    if (m.role !== GUEST_ROLE_ID && (!access || access.projects.all)) return 'All projects';
    const ids = access?.projects.projectIds ?? [];
    if (!ids.length) return 'No projects';
    const names = ids.map((id) => this.projectName().get(id) ?? 'a project');
    return names.length > 2 ? `${names.slice(0, 2).join(', ')} +${names.length - 2}` : names.join(', ');
  }

  protected inviteAccess(i: WorkspaceInvite): string {
    const access = i.access;
    if (i.role !== GUEST_ROLE_ID && (!access || access.projects.all)) return 'All projects';
    const count = access?.projects.projectIds.length ?? 0;
    if (!count) return 'No projects';
    const names = (access?.projects.projectIds ?? []).map((id) => this.projectName().get(id) ?? 'a project');
    return names.length > 2 ? `${names.slice(0, 2).join(', ')} +${names.length - 2}` : names.join(', ');
  }

  /** Who sent the invitation ("You" for me). */
  protected inviter(i: WorkspaceInvite): string {
    if (!i.invitedByUserId) return 'Someone';
    if (i.invitedByUserId === this.meId()) return 'You';
    return this.store.userById().get(i.invitedByUserId)?.name ?? 'Someone';
  }

  protected createdAgo(i: WorkspaceInvite): string {
    const when = ago(i.createdAt);
    return when === 'now' ? 'now' : `${when} ago`;
  }

  protected expired(i: WorkspaceInvite): boolean {
    return new Date(i.expiresAt).getTime() < Date.now();
  }
  protected expiry(i: WorkspaceInvite): string {
    const days = Math.ceil((new Date(i.expiresAt).getTime() - Date.now()) / DAY_MS);
    if (days < 0) return 'expired';
    if (days === 0) return 'expires today';
    return `expires in ${days}d`;
  }

  protected roleName(role: Role): string {
    return workspaceRoleName(this.workspaceRoles(), role);
  }

  protected baseline(roleId: Role): MemberGrant[] {
    const role = findWorkspaceRole(this.workspaceRoles(), roleId);
    if (!role || role.owner) return [...MEMBER_GRANTS];
    return role.grants;
  }

  protected openAccess(membership: Membership): void {
    this.editingId.set(membership.id);
    this.draftCustom.set(!!membership.access || membership.role === GUEST_ROLE_ID);
    this.draft.set(membership.access ?? this.startingAccess(membership.role));
  }

  protected setDraftCustom(membership: Membership, on: boolean): void {
    this.draftCustom.set(on);
    if (on) this.draft.set(this.clamp(membership.access ?? emptyMemberAccess(), membership.role));
  }

  /** A list of projects with nothing ticked would show the person nothing (and a guest always has a list). */
  protected draftValid(membership: Membership): boolean {
    const guest = membership.role === GUEST_ROLE_ID;
    if (!guest && !this.draftCustom()) return true;
    const projects = this.draft().projects;
    return projects.all ? !guest : projects.projectIds.length > 0;
  }

  protected async saveAccess(membershipId: string): Promise<void> {
    const membership = this.store.memberships().find((m) => m.id === membershipId);
    if (!membership) return;
    const guest = membership.role === GUEST_ROLE_ID;
    this.busy.set(true);
    const ok = await this.store.updateMember(membershipId, {
      access: guest || this.draftCustom() ? this.clamp(this.draft(), membership.role) : null,
    });
    this.busy.set(false);
    if (ok) this.editingId.set(null);
  }

  private clamp(access: MemberAccess, role: Role): MemberAccess {
    return normalizeMemberAccess(access, this.baseline(role)) ?? emptyMemberAccess();
  }

  /** What a role starts with: a guest has no projects yet, everyone else has them all. */
  private startingAccess(role: Role): MemberAccess {
    return role === GUEST_ROLE_ID
      ? { projects: { all: false, projectIds: [] }, includeUnassigned: false, grants: [] }
      : emptyMemberAccess();
  }

  protected async resend(i: WorkspaceInvite): Promise<void> {
    this.busy.set(true);
    const link = await this.invites.resend(i.id);
    this.busy.set(false);
    if (link) this.sent.set({ link });
  }

  protected confirmRevoke(i: WorkspaceInvite): void {
    this.ui.setConfirmDelete({
      title: `Revoke the invitation for ${i.email}?`,
      description: 'The invitation link stops working. You can invite them again later.',
      confirmLabel: 'Revoke',
      onConfirm: () => this.revoke(i),
    });
  }

  protected async revoke(i: WorkspaceInvite): Promise<void> {
    if ((await this.invites.revoke(i.id)) && this.sent()?.link.invite.id === i.id)
      this.sent.set(null);
  }

  /**
   * A role change is the whole promotion path: a guest becomes a member (keeping the projects they had until
   * someone widens them), and a member becomes a guest by choosing which projects to keep.
   */
  protected async setRole(membership: Membership, role: string): Promise<void> {
    if (role === membership.role || !this.workspaceRoles().some((item) => item.id === role)) return;
    if (role === GUEST_ROLE_ID) {
      const keep = membership.access && !membership.access.projects.all ? membership.access.projects.projectIds : [];
      const ok = await this.store.updateMember(membership.id, {
        role,
        access: { projects: { all: false, projectIds: [...keep] }, includeUnassigned: false, grants: [] },
      });
      if (ok) this.openAccess({ ...membership, role, access: { projects: { all: false, projectIds: [...keep] }, includeUnassigned: false, grants: [] } });
      return;
    }
    await this.store.updateMemberRole(membership.id, role);
  }

  protected transfer(id: string, name: string): void {
    this.ui.setConfirmDelete({
      title: `Transfer ownership to ${name}?`,
      description: `${name} becomes the workspace owner and can remove or demote other owners, including you. You stay an owner.`,
      confirmLabel: 'Transfer ownership',
      destructive: false,
      onConfirm: async () => {
        await this.store.transferOwnership(id);
      },
    });
  }

  protected remove(id: string, name: string): void {
    this.ui.setConfirmDelete({
      title: `Remove ${name}?`,
      description: 'They lose access to this workspace. Their account stays.',
      confirmLabel: 'Remove',
      onConfirm: async () => {
        await this.store.removeMember(id);
      },
    });
  }
}
