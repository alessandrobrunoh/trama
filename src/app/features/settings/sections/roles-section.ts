import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import {
  LucideBot,
  LucideBuilding2,
  LucideCrown,
  LucideDynamicIcon,
  LucideFolderLock,
  LucideLayers,
  LucideLock,
  LucidePlus,
  LucideUser,
  type LucideIconInput,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmCheckbox } from '@spartan-ng/helm/checkbox';
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
import { MemberAccessEditor } from './member-access-editor';
import { SECTION_KIT, SETTINGS_FIELD } from './section-kit';

const GROUP_ORDER: CapabilityMeta['group'][] = ['Work', 'Access & automation'];

interface Rule {
  icon: LucideIconInput;
  title: string;
  text: string;
}

const RULES: readonly Rule[] = [
  {
    icon: LucideLock,
    title: 'Owner holds the keys',
    text: 'Only an owner creates, renames or deletes roles, or grants the owner role. The owner role cannot be deleted.',
  },
  {
    icon: LucideLayers,
    title: 'No inheritance',
    text: 'A role can do only what is checked on it. Admin, Member and Viewer are not built in.',
  },
  {
    icon: LucideUser,
    title: 'One role per person',
    text: 'A member has exactly one role. Extra actions on an invitation are added on top of that role.',
  },
  {
    icon: LucideBuilding2,
    title: 'Projects belong to the workspace',
    text: 'Nothing leaves with the person who created it, or with a guest who is removed.',
  },
  {
    icon: LucideFolderLock,
    title: 'Guests see their projects only',
    text: 'The people on those projects, and nothing else: no settings, integrations, AI or tokens. Their access is the projects they were invited to.',
  },
  {
    icon: LucideBot,
    title: 'Agents act as members',
    text: 'An agent uses the historical member permissions.',
  },
];

/**
 * Workspace roles. Each role has its own capabilities and work grants. Owner cannot be deleted
 * and always keeps the permissions needed to manage members.
 */
@Component({
  selector: 'app-roles-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButtonImports, HlmCheckbox, LucideDynamicIcon, MemberAccessEditor, ...SECTION_KIT],
  host: { class: 'flex flex-col gap-9' },
  template: `
    <app-section-header
      flush
      title="Roles & permissions"
      description="What each role can do. One role per person; access decides which projects they see."
    >
      @if (isOwner()) {
        <button actions hlmBtn size="sm" [disabled]="busy()" (click)="creating.set(true)">
          <svg [lucideIcon]="plusIcon" [size]="13"></svg> New role
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
      <form class="flex flex-wrap items-center gap-2" (submit)="create($event)">
        <span class="block w-56">
          <input
            class="${SETTINGS_FIELD}"
            placeholder="Role name"
            aria-label="New role name"
            [value]="draftName()"
            (input)="draftName.set($any($event.target).value)"
          />
        </span>
        <button hlmBtn size="sm" type="submit" [disabled]="busy() || !draftName().trim()">Create</button>
        <button hlmBtn size="sm" variant="outline" type="button" (click)="creating.set(false)">Cancel</button>
      </form>
    }

    <div class="bg-background border-border overflow-x-auto border" role="table" aria-label="What each role can do">
      <div class="min-w-fit">
        <div class="bg-bg-deep flex items-end pl-4" role="row">
          <div
            class="text-faint min-w-56 flex-1 py-3 font-mono text-[10.5px] leading-[normal]"
            role="columnheader"
          >
            CAPABILITY
          </div>
          @for (role of roles(); track role.id) {
            <button
              type="button"
              role="columnheader"
              class="border-border hover:bg-card flex w-24 shrink-0 flex-col items-center gap-[3px] border-l px-1.5 py-1.5"
              [class.bg-card]="role.id === selected().id"
              [attr.aria-pressed]="role.id === selected().id"
              (click)="select(role.id)"
            >
              <span class="text-foreground flex items-center gap-1 text-[12.5px] leading-[normal] font-medium">
                @if (role.owner) {
                  <svg [lucideIcon]="crownIcon" [size]="12" class="text-primary shrink-0"></svg>
                }
                <span class="max-w-20 truncate">{{ role.name }}</span>
              </span>
              <span class="text-faint font-mono text-[10px] leading-[normal]">{{ countFor(role.id) }}</span>
            </button>
          }
          <div class="border-border flex h-11 w-10 shrink-0 items-center justify-center border-l">
            @if (isOwner()) {
              <button
                type="button"
                class="text-muted-foreground hover:text-foreground"
                aria-label="New role"
                [disabled]="busy()"
                (click)="creating.set(true)"
              >
                <svg [lucideIcon]="plusIcon" [size]="14"></svg>
              </button>
            }
          </div>
        </div>
        @for (group of groups; track group) {
          <div
            class="bg-card border-border text-muted-foreground border-t px-4 py-2 font-mono text-[10.5px] leading-[normal] uppercase"
            role="row"
          >
            {{ group }}
          </div>
          @for (cap of capsIn(group); track cap) {
            <div class="border-border flex items-center border-t pl-4" role="row">
              <div class="flex min-w-56 flex-1 flex-col gap-0.5 py-[9px]" role="rowheader">
                <span class="text-foreground text-[13px] leading-[normal]">{{ meta(cap).label }}</span>
                <span class="text-faint text-[11.5px] leading-[normal]">{{ meta(cap).description }}</span>
              </div>
              @for (role of roles(); track role.id) {
                <div class="flex w-24 shrink-0 items-center justify-center py-[9px]" role="cell">
                  @if (locked(role, cap)) {
                    <span
                      class="bg-border-strong text-text-2 flex size-4 items-center justify-center"
                      [attr.aria-label]="meta(cap).label + ' for ' + role.name + ': always on'"
                      role="img"
                    >
                      <svg [lucideIcon]="lockIcon" [size]="10"></svg>
                    </span>
                  } @else {
                    <hlm-checkbox
                      [checked]="hasCap(role, cap)"
                      [disabled]="!isOwner() || busy()"
                      [aria-label]="meta(cap).label + ' for ' + role.name"
                      (checkedChange)="toggleCap(role, cap, $event)"
                    />
                  }
                </div>
              }
              <div class="w-10 shrink-0"></div>
            </div>
          }
        }
      </div>
    </div>

    @if (selected(); as role) {
      <app-settings-block
        [title]="role.name"
        [description]="
          role.owner
            ? 'This role cannot be deleted or renamed away from ownership, and it keeps the ability to manage members.'
            : 'People with this role can do only what is checked above.'
        "
      >
        <app-settings-card>
          @if (!role.owner && isOwner()) {
            <app-card-row label="Name" description="Rename the role or remove it once nobody uses it.">
              <span class="block w-44">
                <input
                  class="${SETTINGS_FIELD}"
                  aria-label="Role name"
                  [value]="draftName()"
                  (input)="draftName.set($any($event.target).value)"
                />
              </span>
              <button
                hlmBtn
                variant="outline"
                [disabled]="busy() || !draftName().trim() || draftName().trim() === role.name"
                (click)="rename(role)"
              >
                Rename
              </button>
              <button hlmBtn variant="outline" [disabled]="busy()" (click)="remove(role)">Delete</button>
            </app-card-row>
          } @else {
            <app-card-row [label]="countFor(role.id)" description="People who have this role." />
          }
          @if (!role.owner) {
            <div class="flex flex-col gap-3 px-4 py-3.5">
              <div class="flex flex-col gap-[3px]">
                <span class="text-foreground text-[13.5px] leading-[normal]">Work this role starts with</span>
                <span class="text-muted-foreground text-[12.5px] leading-[18px]">
                  View, create, edit, delete. Invitations can add, not remove.
                </span>
              </div>
              <app-member-access-editor
                [showProjects]="false"
                [role]="role.id"
                [disabled]="!isOwner() || busy()"
                [(value)]="grantDraft"
              />
              @if (isOwner()) {
                <div>
                  <button type="button" hlmBtn [disabled]="busy()" (click)="saveGrants(role)">
                    Save work permissions
                  </button>
                </div>
              }
            </div>
          }
        </app-settings-card>
      </app-settings-block>
    }

    <app-settings-block title="Always true" description="These rules stay, whatever a role's checkboxes say.">
      <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        @for (rule of rules; track rule.title) {
          <div class="border-border flex flex-col gap-1.5 border p-4">
            <svg [lucideIcon]="rule.icon" [size]="15" class="text-primary"></svg>
            <span class="text-foreground text-[13px] leading-[normal] font-medium">{{ rule.title }}</span>
            <span class="text-muted-foreground text-[12px] leading-[18px]">{{ rule.text }}</span>
          </div>
        }
      </div>
    </app-settings-block>
  `,
})
export class RolesSection {
  private readonly store = inject(TramaStore);
  private readonly ui = inject(UiStore);

  protected readonly groups = GROUP_ORDER;
  protected readonly rules = RULES;
  protected readonly plusIcon = LucidePlus;
  protected readonly crownIcon = LucideCrown;
  protected readonly lockIcon = LucideLock;
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
