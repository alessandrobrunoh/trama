import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideCheck, LucideDynamicIcon, LucideMinus } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import {
  CAPABILITIES,
  CAPABILITY_META,
  CAPABILITY_ROLES,
  DEFAULT_PERMISSIONS,
  TEAM_EDIT_POLICIES,
  type Capability,
  type CapabilityMeta,
  type Role,
} from '../../../core/contracts/domain';
import { ROLES, ROLE_DETAILS, ROLE_META } from '../../../core/meta';
import { TramaStore } from '../../../core/stores/trama.store';
import { SECTION_KIT } from './section-kit';

interface Group {
  title: string;
  rows: { cap: Capability; meta: CapabilityMeta; min: Role; custom: boolean }[];
}

const GROUP_ORDER: CapabilityMeta['group'][] = ['Work', 'Organization', 'Access & automation'];

/**
 * Who may do what in this workspace: one row per capability, one column per role.
 * The highlighted cell is the minimum role; every role to its left (higher rank) may do it too.
 * Owners edit the matrix; everyone else sees it.
 */
@Component({
  selector: 'app-roles-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, HlmButtonImports, LucideDynamicIcon, ...SECTION_KIT],
  host: { class: 'flex flex-col gap-10' },
  template: `
    <div>
      <app-section-header
        title="Roles & permissions"
        description="Everyone in the workspace has one role. Choose the lowest role that may do each action; higher roles always can too."
      >
        @if (isOwner() && customCount() > 0) {
          <button actions hlmBtn size="sm" variant="outline" [disabled]="busy()" (click)="reset()">Reset to defaults</button>
        }
      </app-section-header>
      @if (!isOwner()) {
        <app-readonly-note>Only owners can change roles and permissions. You can see what each role may do.</app-readonly-note>
      }

      <app-settings-group title="Roles">
        @for (r of roles; track r) {
          <app-settings-row [label]="label(r)" [description]="details[r]">
            <span class="text-muted-foreground text-xs tabular-nums">{{ countFor(r) }}</span>
          </app-settings-row>
        }
      </app-settings-group>
    </div>

    <div>
      <div class="mb-2 px-0.5">
        <h3 class="text-[13px] font-medium">Permission matrix</h3>
        <p class="text-muted-foreground mt-0.5 text-xs leading-snug">
          {{ isOwner() ? 'Click a role to make it the minimum for that action.' : 'The outlined role is the minimum for that action.' }}
          Viewers are read-only, so they never appear as a minimum.
        </p>
      </div>
      <div class="bg-card overflow-hidden rounded-lg border">
        <div class="bg-muted/40 grid grid-cols-[minmax(0,1fr)_repeat(4,2.75rem)] items-end gap-x-1 border-b px-4 py-2 sm:grid-cols-[minmax(0,1fr)_repeat(4,3.5rem)]">
          <span class="text-muted-foreground text-[11px] font-medium">Action</span>
          @for (r of roles; track r) {
            <span class="text-muted-foreground text-center text-[11px] font-medium">{{ label(r) }}</span>
          }
        </div>
        @for (g of groups(); track g.title) {
          <div class="bg-muted/20 text-muted-foreground border-b px-4 py-1.5 text-[11px] font-medium tracking-wide uppercase">{{ g.title }}</div>
          @for (row of g.rows; track row.cap) {
            <div class="grid grid-cols-[minmax(0,1fr)_repeat(4,2.75rem)] items-center gap-x-1 border-b px-4 py-2.5 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_repeat(4,3.5rem)]">
              <div class="min-w-0 pr-2">
                <div class="flex items-center gap-1.5 text-[13px] font-medium">
                  {{ row.meta.label }}
                  @if (row.custom) {
                    <span class="bg-muted text-muted-foreground rounded px-1 py-px text-[10px] font-normal" title="Differs from the default">Custom</span>
                  }
                </div>
                <div class="text-muted-foreground text-xs leading-snug">{{ row.meta.description }}</div>
              </div>
              @for (r of roles; track r) {
                <div class="flex justify-center">
                  @if (r === 'viewer') {
                    <span class="text-muted-foreground/40 flex size-8 items-center justify-center" aria-label="Viewers cannot do this">
                      <svg [lucideIcon]="dash" [size]="14"></svg>
                    </span>
                  } @else {
                    <button
                      type="button"
                      class="flex size-8 items-center justify-center rounded-md border transition-colors disabled:cursor-default"
                      [class]="cellClass(r, row.min)"
                      [disabled]="!isOwner() || busy()"
                      [attr.aria-label]="label(r) + (allows(r, row.min) ? ' can ' : ' cannot ') + row.meta.label.toLowerCase()"
                      [attr.aria-pressed]="r === row.min"
                      (click)="set(row.cap, r)"
                    >
                      @if (allows(r, row.min)) {
                        <svg [lucideIcon]="check" [size]="14"></svg>
                      } @else {
                        <span class="bg-muted-foreground/30 size-1 rounded-full"></span>
                      }
                    </button>
                  }
                </div>
              }
            </div>
          }
        }
      </div>
    </div>

    <app-settings-group title="Always true" description="These rules are fixed, whatever the matrix says.">
      <app-settings-row label="Owners hold the keys" description="Only owners change this matrix, grant the owner role or delete the workspace." />
      <app-settings-row label="Roles are not escalated" description="Nobody can grant a role above their own, and a workspace always keeps at least one owner." />
      <app-settings-row label="Agents act as members" description="An agent can never go above member, and can never accept or reject a decision: that stays a human call." />
      <app-settings-row label="API tokens can only be narrower" description="A token has a scope (read, write, admin) that caps what it can do, never raises it." />
    </app-settings-group>

    <app-settings-group title="Team roles" description="On top of the workspace role, each team has its own roles and a policy.">
      <app-settings-row label="Team member" description="Listed on the team. Sees the team's attention items and can be assigned its work." />
      <app-settings-row label="Team lead" description="A member who can also edit the team itself (name, colour, members, edit policy) without being a workspace admin." />
      <app-settings-row label="Edit policy" description="Per team. Everyone in the workspace, or team members and leads only, may edit the team's workstreams and issues. Admins always can.">
        <span class="text-muted-foreground max-w-48 text-right text-xs">
          {{ policyA }} or {{ policyB }}
        </span>
      </app-settings-row>
      <div class="bg-muted/30 flex items-center justify-between gap-3 px-4 py-2 text-xs">
        <span class="text-muted-foreground">Set leads and the edit policy in each team's Members tab.</span>
        <a hlmBtn variant="outline" size="sm" class="h-7 shrink-0" [routerLink]="['/', slug(), 'settings', 'teams']">Teams</a>
      </div>
    </app-settings-group>
  `,
})
export class RolesSection {
  private readonly store = inject(TramaStore);

  protected readonly roles = ROLES;
  protected readonly details = ROLE_DETAILS;
  protected readonly policyA = TEAM_EDIT_POLICIES.workspace.label;
  protected readonly policyB = TEAM_EDIT_POLICIES.members.label.toLowerCase();
  protected readonly check = LucideCheck;
  protected readonly dash = LucideMinus;
  protected readonly busy = signal(false);
  protected readonly isOwner = computed(() => this.store.can('owner'));
  protected readonly slug = computed(() => this.store.slug() ?? '');

  protected readonly groups = computed<Group[]>(() => {
    const perms = this.store.settings().permissions;
    return GROUP_ORDER.map((title) => ({
      title,
      rows: CAPABILITIES.filter((cap) => CAPABILITY_META[cap].group === title).map((cap) => ({
        cap,
        meta: CAPABILITY_META[cap],
        min: perms[cap],
        custom: perms[cap] !== DEFAULT_PERMISSIONS[cap],
      })),
    }));
  });
  protected readonly customCount = computed(() => this.groups().reduce((n, g) => n + g.rows.filter((r) => r.custom).length, 0));

  protected label(r: Role): string {
    return ROLE_META[r].label;
  }
  protected countFor(role: Role): string {
    const n = this.store.memberships().filter((m) => m.role === role).length;
    return n === 1 ? '1 person' : `${n} people`;
  }
  protected allows(role: Role, min: Role): boolean {
    return ROLE_META[role].rank >= ROLE_META[min].rank;
  }
  protected cellClass(role: Role, min: Role): string {
    if (role === min) return 'border-primary bg-selected text-foreground';
    return this.allows(role, min) ? 'border-transparent text-muted-foreground hover:bg-accent' : 'border-transparent hover:bg-accent';
  }

  protected async set(cap: Capability, role: Role): Promise<void> {
    if (!this.isOwner() || this.busy() || !CAPABILITY_ROLES.includes(role) || this.store.settings().permissions[cap] === role) return;
    this.busy.set(true);
    await this.store.updateSettings({ permissions: { [cap]: role } });
    this.busy.set(false);
  }

  protected async reset(): Promise<void> {
    this.busy.set(true);
    await this.store.updateSettings({ permissions: { ...DEFAULT_PERMISSIONS } });
    this.busy.set(false);
  }
}
