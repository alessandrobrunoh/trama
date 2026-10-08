import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { LucideDynamicIcon, LucideSearch, LucideX } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { ROLE_DETAILS, ROLE_META, ROLES } from '../../../core/meta';
import { NablaStore } from '../../../core/stores/nabla.store';
import { UiStore } from '../../../core/stores/ui.store';
import type { Role } from '../../../core/contracts/domain';
import { ActorAvatar } from '../../../shared/actor-avatar';
import { AppSelect, type Option } from '../../create/form-kit';
import { SECTION_KIT } from './section-kit';

/** People in the workspace: invite by email, change roles, remove. */
@Component({
  selector: 'app-members-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButtonImports, HlmInputImports, LucideDynamicIcon, ActorAvatar, AppSelect, ...SECTION_KIT],
  host: { class: 'flex flex-col gap-10' },
  template: `
    <div>
      <app-section-header title="Members" description="People who can open this workspace. Invite someone who already has a Nabla account." />

      @if (canInvite()) {
        <app-settings-group title="Invite">
          <form class="flex flex-wrap items-center gap-2 px-4 pt-3" (submit)="invite($event)">
            <input
              hlmInput
              type="email"
              class="h-8 min-w-48 flex-1 text-[13px]"
              placeholder="email@company.com"
              aria-label="Email"
              [value]="email()"
              (input)="email.set($any($event.target).value)"
            />
            <div class="w-32">
              <app-select size="sm" [options]="inviteOptions()" [(value)]="role" label="Role" />
            </div>
            <button hlmBtn size="sm" type="submit" [disabled]="!email().trim() || busy()">Invite</button>
          </form>
          <p class="text-muted-foreground px-4 pt-2 pb-3 text-xs leading-snug">
            <strong class="text-foreground font-medium">{{ roleName(roleValue()) }}.</strong> {{ roleDetail(roleValue()) }}
          </p>
        </app-settings-group>
      }
    </div>

    <app-settings-group [title]="'Members · ' + store.members().length">
      <div aside class="relative w-44">
        <svg [lucideIcon]="searchIcon" [size]="13" class="text-muted-foreground pointer-events-none absolute top-1/2 left-2 -translate-y-1/2"></svg>
        <input hlmInput class="h-7 w-full pl-7 text-xs" placeholder="Filter…" aria-label="Filter members" [value]="query()" (input)="query.set($any($event.target).value)" />
      </div>
      @for (m of shown(); track m.membership.id) {
        <div class="flex min-h-13 flex-wrap items-center gap-3 px-4 py-2.5">
          <app-actor-avatar [actor]="{ type: 'user', id: m.user.id }" [size]="28" />
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-1.5 text-[13px] font-medium">
              <span class="truncate">{{ m.user.name }}</span>
              @if (m.user.id === meId()) {
                <span class="text-muted-foreground bg-muted rounded px-1 py-px text-[10px] font-normal">You</span>
              }
            </div>
            <div class="text-muted-foreground truncate text-xs">{{ m.user.email }}{{ teamsOf(m.user.id) ? ' · ' + teamsOf(m.user.id) : '' }}</div>
          </div>
          @if (canAdmin()) {
            <div class="w-28">
              <app-select size="sm" [options]="roleOptions" [value]="m.membership.role" (valueChange)="setRole(m.membership.id, $event)" label="Role" />
            </div>
            <button hlmBtn variant="ghost" size="icon-sm" class="text-muted-foreground" [attr.aria-label]="'Remove ' + m.user.name" (click)="remove(m.membership.id, m.user.name)">
              <svg [lucideIcon]="xIcon" [size]="14"></svg>
            </button>
          } @else {
            <span class="text-muted-foreground text-xs">{{ roleName(m.membership.role) }}</span>
          }
        </div>
      } @empty {
        <div class="text-muted-foreground px-4 py-6 text-center text-[13px]">No member matches “{{ query().trim() }}”.</div>
      }
    </app-settings-group>

    <app-settings-group title="Roles" description="What each role means. Which actions need which role is set in Roles & permissions.">
      @for (r of roles; track r) {
        <app-settings-row [label]="roleName(r)" [description]="roleDetail(r)">
          <span class="text-muted-foreground text-xs tabular-nums">{{ countFor(r) }}</span>
        </app-settings-row>
      }
    </app-settings-group>
  `,
})
export class MembersSection {
  protected readonly store = inject(NablaStore);
  private readonly ui = inject(UiStore);

  protected readonly searchIcon = LucideSearch;
  protected readonly xIcon = LucideX;
  protected readonly roles = ROLES;
  protected readonly roleOptions: Option[] = ROLES.map((r) => ({ value: r, label: ROLE_META[r].label }));
  protected readonly email = signal('');
  protected readonly role = signal<string>('member');
  protected readonly query = signal('');
  protected readonly busy = signal(false);
  protected readonly canAdmin = computed(() => this.store.can('admin'));
  protected readonly canInvite = computed(() => this.store.allowed('inviteMembers'));
  /** Nobody can grant a role above their own. */
  protected readonly inviteOptions = computed<Option[]>(() => {
    const mine = this.store.myRole();
    return this.roleOptions.filter((o) => !mine || ROLE_META[o.value as Role].rank <= ROLE_META[mine].rank);
  });
  protected readonly roleValue = computed(() => this.role() as Role);
  protected readonly meId = computed(() => this.store.me()?.id);
  protected readonly shown = computed(() => {
    const q = this.query().trim().toLowerCase();
    const rows = this.store.members();
    return q ? rows.filter((m) => `${m.user.name} ${m.user.email}`.toLowerCase().includes(q)) : rows;
  });
  private readonly teamNamesByUser = computed(() => {
    const map = new Map<string, string[]>();
    for (const t of this.store.teams())
      for (const id of t.memberIds) map.set(id, [...(map.get(id) ?? []), t.leadIds.includes(id) ? `${t.key} (lead)` : t.key]);
    return map;
  });

  protected teamsOf(userId: string): string {
    return (this.teamNamesByUser().get(userId) ?? []).join(', ');
  }
  protected roleName(role: Role): string {
    return ROLE_META[role].label;
  }
  protected roleDetail(role: Role): string {
    return ROLE_DETAILS[role];
  }
  protected countFor(role: Role): string {
    const n = this.store.memberships().filter((m) => m.role === role).length;
    return n === 1 ? '1 person' : `${n} people`;
  }

  protected async invite(event: Event): Promise<void> {
    event.preventDefault();
    const email = this.email().trim();
    if (!email) return;
    this.busy.set(true);
    const created = await this.store.addMember({ email, role: this.role() as Role });
    this.busy.set(false);
    if (created) this.email.set('');
  }

  protected setRole(membershipId: string, role: string): void {
    if (ROLES.includes(role as Role)) void this.store.updateMemberRole(membershipId, role as Role);
  }

  protected remove(id: string, name: string): void {
    this.ui.setConfirmDelete({
      title: `Remove ${name}?`,
      description: 'They lose access to this workspace and leave its teams. Their account stays.',
      confirmLabel: 'Remove',
      onConfirm: async () => {
        await this.store.removeMember(id);
      },
    });
  }
}
