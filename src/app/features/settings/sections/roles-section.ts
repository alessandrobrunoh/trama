import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmCheckbox } from '@spartan-ng/helm/checkbox';
import { HlmInputImports } from '@spartan-ng/helm/input';
import {
  CAPABILITIES,
  CAPABILITY_META,
  emptyMemberAccess,
  MEMBER_GRANTS,
  OWNER_REQUIRED_CAPABILITIES,
  type Capability,
  type CapabilityMeta,
  type MemberAccess,
  type WorkspaceRole,
} from '../../../core/contracts/domain';
import { TramaStore } from '../../../core/stores/trama.store';
import { UiStore } from '../../../core/stores/ui.store';
import { V3Segmented, type V3SegmentOption } from '../../../shared/v3';
import { MemberAccessEditor } from './member-access-editor';
import { SECTION_KIT } from './section-kit';

const GROUP_ORDER: CapabilityMeta['group'][] = ['Work', 'Access & automation'];

/**
 * Workspace roles. Each role has its own capabilities and work grants. Owner cannot be deleted
 * and always keeps the permissions needed to manage members.
 */
@Component({
  selector: 'app-roles-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButtonImports, HlmCheckbox, HlmInputImports, MemberAccessEditor, V3Segmented, ...SECTION_KIT],
  host: { class: 'flex flex-col gap-10' },
  template: `
    <div>
      <app-section-header
        title="Roles & permissions"
        description="Create a role and choose exactly what it can do. Nothing is inherited from another role. The Owner role stays, because someone must be able to manage roles and members."
      >
        @if (isOwner()) {
          <button actions hlmBtn size="sm" [disabled]="busy()" (click)="creating.set(true)">
            New role
          </button>
        }
      </app-section-header>
      @if (!isOwner()) {
        <app-readonly-note
          >Only owners can change roles and permissions. You can see what each role may
          do.</app-readonly-note
        >
      }

      @if (creating()) {
        <form class="mb-4 flex flex-wrap items-center gap-2" (submit)="create($event)">
          <input
            hlmInput
            class="h-8 w-56 text-[13px]"
            placeholder="Role name"
            aria-label="New role name"
            [value]="draftName()"
            (input)="draftName.set($any($event.target).value)"
          />
          <button hlmBtn size="sm" type="submit" [disabled]="busy() || !draftName().trim()">
            Create
          </button>
          <button hlmBtn size="sm" variant="ghost" type="button" (click)="creating.set(false)">
            Cancel
          </button>
        </form>
      }

      <v3-segmented
        class="mb-6"
        aria-label="Role"
        [options]="roleOptions()"
        [value]="selected()?.id ?? ''"
        (valueChange)="select($event)"
      />

      @if (selected(); as role) {
        <app-settings-group
          [title]="role.name"
          [description]="
            role.owner
              ? 'This role cannot be deleted or renamed away from ownership, and it keeps the ability to manage members.'
              : 'People with this role can do only what is checked here.'
          "
        >
          @if (!role.owner && isOwner()) {
            <div class="border-border flex flex-wrap items-center gap-2 border-b px-1 py-3">
              <input
                hlmInput
                class="h-8 w-56 text-[13px]"
                aria-label="Role name"
                [value]="draftName()"
                (input)="draftName.set($any($event.target).value)"
              />
              <button
                hlmBtn
                size="sm"
                variant="outline"
                [disabled]="busy() || !draftName().trim() || draftName().trim() === role.name"
                (click)="rename(role)"
              >
                Rename
              </button>
              <button hlmBtn size="sm" variant="outline" [disabled]="busy()" (click)="remove(role)">
                Delete
              </button>
            </div>
          } @else {
            <app-settings-row
              [label]="countFor(role.id)"
              description="People who have this role."
            />
          }
        </app-settings-group>

        <app-settings-section
          class="mt-8"
          title="Capabilities"
          caption="checked means this role can do it; unchecked is refused"
        >
          @for (group of groups; track group) {
            <div class="mt-4">
              <div class="text-faint font-mono text-[10px] tracking-[1px] uppercase">
                {{ group }}
              </div>
              @for (cap of capsIn(group); track cap) {
                <label class="border-border hover:bg-secondary flex items-start gap-2 border-b px-1 py-2">
                  <hlm-checkbox
                    class="mt-0.5"
                    [checked]="hasCap(role, cap)"
                    [disabled]="!isOwner() || busy() || locked(role, cap)"
                    [aria-label]="meta(cap).label"
                    (checkedChange)="toggleCap(role, cap, $event)"
                  />
                  <span class="min-w-0">
                    <span class="text-foreground block text-[13px]">{{ meta(cap).label }}</span>
                    <span class="text-muted-foreground block text-[12px] leading-snug">{{
                      meta(cap).description
                    }}</span>
                  </span>
                </label>
              }
            </div>
          }
        </app-settings-section>

        @if (!role.owner) {
          <app-settings-section
            class="mt-8"
            title="Work this role starts with"
            caption="view, create, edit, delete · invitations can add, not remove"
          >
            <app-member-access-editor
              class="mt-3"
              [showProjects]="false"
              [role]="role.id"
              [disabled]="!isOwner() || busy()"
              [(value)]="grantDraft"
            />
            @if (isOwner()) {
              <button
                type="button"
                hlmBtn
                size="sm"
                class="mt-3"
                [disabled]="busy()"
                (click)="saveGrants(role)"
              >
                Save work permissions
              </button>
            }
          </app-settings-section>
        }
      }
    </div>

    <app-settings-group
      title="Always true"
      description="These rules stay, whatever a role's checkboxes say."
    >
      <app-settings-row
        label="Owner holds the keys"
        description="Only an owner creates, renames or deletes roles, or grants the owner role. The owner role cannot be deleted."
      />
      <app-settings-row
        label="No inheritance"
        description="A role can do only what is checked on it. Admin, Member and Viewer are not built in."
      />
      <app-settings-row
        label="One role per person"
        description="A member has exactly one role. Extra actions on an invitation are added on top of that role."
      />
      <app-settings-row
        label="Agents act as members"
        description="An agent uses the historical member permissions."
      />
    </app-settings-group>
  `,
})
export class RolesSection {
  private readonly store = inject(TramaStore);
  private readonly ui = inject(UiStore);

  protected readonly groups = GROUP_ORDER;
  protected readonly busy = signal(false);
  protected readonly creating = signal(false);
  protected readonly draftName = signal('');
  protected readonly selectedId = signal<string | null>(null);
  protected readonly grantDraft = signal<MemberAccess>({ ...emptyMemberAccess(), grants: [] });
  protected readonly isOwner = computed(() => this.store.can('owner'));
  protected readonly roles = computed(() => this.store.settings().roles);
  protected readonly selected = computed(
    () => this.roles().find((role) => role.id === this.selectedId()) ?? this.roles()[0],
  );
  protected readonly roleOptions = computed<V3SegmentOption[]>(() =>
    this.roles().map((role) => ({
      value: role.id,
      label: `${role.name} ${this.store.memberships().filter((m) => m.role === role.id).length}`,
    })),
  );

  private readonly syncDraft = effect(() => {
    const role = this.selected();
    untracked(() => {
      if (!role) return;
      if (!this.creating()) this.draftName.set(role.name);
      this.grantDraft.set({
        ...emptyMemberAccess(),
        grants: role.owner ? [...MEMBER_GRANTS] : [...role.grants],
      });
      if (!this.selectedId()) this.selectedId.set(role.id);
    });
  });

  protected meta(cap: Capability): CapabilityMeta {
    return CAPABILITY_META[cap];
  }
  protected capsIn(group: CapabilityMeta['group']): Capability[] {
    return CAPABILITIES.filter((cap) => CAPABILITY_META[cap].group === group);
  }
  protected countFor(roleId: string): string {
    const n = this.store.memberships().filter((member) => member.role === roleId).length;
    return n === 1 ? '1 person' : `${n} people`;
  }
  protected hasCap(role: WorkspaceRole, cap: Capability): boolean {
    return role.capabilities.includes(cap);
  }
  protected locked(role: WorkspaceRole, cap: Capability): boolean {
    return role.owner && (OWNER_REQUIRED_CAPABILITIES as readonly string[]).includes(cap);
  }

  protected select(id: string): void {
    this.creating.set(false);
    this.selectedId.set(id);
  }

  protected async create(event: Event): Promise<void> {
    event.preventDefault();
    const name = this.draftName().trim();
    if (!name || this.busy()) return;
    this.busy.set(true);
    const id = await this.store.createRole({ name, capabilities: [], grants: [] });
    this.busy.set(false);
    if (!id) return;
    this.creating.set(false);
    this.draftName.set('');
    this.selectedId.set(id);
  }

  protected async rename(role: WorkspaceRole): Promise<void> {
    const name = this.draftName().trim();
    if (!name || name === role.name || this.busy()) return;
    this.busy.set(true);
    await this.store.updateRole(role.id, { name });
    this.busy.set(false);
  }

  protected remove(role: WorkspaceRole): void {
    this.ui.setConfirmDelete({
      title: `Delete ${role.name}?`,
      description: 'People and invitations using it have to move first. This cannot be undone.',
      confirmLabel: 'Delete role',
      onConfirm: async () => {
        const ok = await this.store.deleteRole(role.id);
        if (ok) this.selectedId.set(null);
      },
    });
  }

  protected async toggleCap(role: WorkspaceRole, cap: Capability, on: boolean): Promise<void> {
    if (!this.isOwner() || this.busy() || this.locked(role, cap)) return;
    const next = new Set(role.capabilities);
    if (on) next.add(cap);
    else next.delete(cap);
    this.busy.set(true);
    await this.store.updateRole(role.id, { capabilities: [...next] });
    this.busy.set(false);
  }

  protected async saveGrants(role: WorkspaceRole): Promise<void> {
    if (!this.isOwner() || this.busy() || role.owner) return;
    this.busy.set(true);
    await this.store.updateRole(role.id, { grants: [...this.grantDraft().grants] });
    this.busy.set(false);
  }
}
