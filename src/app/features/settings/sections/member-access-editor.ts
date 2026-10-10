import { ChangeDetectionStrategy, Component, computed, input, model } from '@angular/core';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import {
  MEMBER_ACTION_META,
  MEMBER_RESOURCE_ORDER,
  MEMBER_RESOURCES,
  type MemberAccess,
  type MemberAction,
  type MemberGrant,
  type MemberResource,
  type Role,
} from '../../../core/contracts/domain';

const GROUPS = ['Planning', 'Work', 'Collaboration'] as const;
const ALL_GRANTS: MemberGrant[] = MEMBER_RESOURCE_ORDER.flatMap((id) =>
  MEMBER_RESOURCES[id].actions.map((action) => `${id}:${action}` as MemberGrant),
);

/**
 * Resource × action table. `locked` grants come from the role: checked, and not removable.
 * Everything else in `value.grants` is an extra for this person. With no locked grants, the table edits the role itself.
 */
@Component({
  selector: 'app-member-access-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButtonImports],
  host: { class: 'flex flex-col gap-3' },
  template: `
    <div class="flex flex-wrap items-center gap-1.5">
      @for (p of presetButtons(); track p.id) {
        <button type="button" hlmBtn variant="outline" size="sm" class="h-7 text-xs" [disabled]="disabled()" (click)="applyPreset(p.id)">
          {{ p.label }}
        </button>
      }
      <span class="text-muted-foreground ml-auto text-xs">{{ summary() }}</span>
    </div>

    @if (showProjects()) {
    <div class="bg-card overflow-hidden rounded-lg border">
      <div class="flex items-start gap-3 px-3 py-2.5">
        <input
          type="checkbox"
          class="accent-primary mt-0.5 size-4 cursor-pointer"
          [checked]="value().projects.all"
          [disabled]="disabled()"
          aria-label="All projects, including ones created later"
          (change)="setAllProjects($any($event.target).checked)"
        />
        <span class="min-w-0">
          <span class="block text-[13px] font-medium">All projects</span>
          <span class="text-muted-foreground block text-xs leading-snug">Including projects created after this person joins. Turn off to choose which ones they can see.</span>
        </span>
      </div>
      @if (!value().projects.all) {
        <div class="border-t px-3 py-2">
          @if (projects().length) {
            <div class="flex max-h-40 flex-col gap-1 overflow-y-auto">
              @for (p of projects(); track p.id) {
                <label class="flex items-center gap-2 py-0.5 text-[13px]">
                  <input
                    type="checkbox"
                    class="accent-primary size-4 cursor-pointer"
                    [checked]="value().projects.projectIds.includes(p.id)"
                    [disabled]="disabled()"
                    [attr.aria-label]="'Can see ' + p.name"
                    (change)="toggleProject(p.id, $any($event.target).checked)"
                  />
                  <span class="truncate">{{ p.name }}</span>
                </label>
              }
            </div>
          } @else {
            <p class="text-muted-foreground text-xs">This workspace has no projects yet.</p>
          }
          <label class="mt-2 flex items-center gap-2 border-t pt-2 text-[13px]">
            <input
              type="checkbox"
              class="accent-primary size-4 cursor-pointer"
              [checked]="value().includeUnassigned"
              [disabled]="disabled()"
              (change)="setUnassigned($any($event.target).checked)"
            />
            Also see work that is not in a project
          </label>
        </div>
      }
    </div>
    }

    <div class="bg-card overflow-hidden rounded-lg border" role="group" aria-label="What they can do">
      <div class="bg-muted/40 text-muted-foreground flex items-center gap-3 border-b px-3 py-1.5 text-[11px] font-medium uppercase">
        <span class="flex-1">Action</span>
        @for (c of columns; track c.id) {
          <span class="w-14 text-center">
            <button type="button" class="hover:text-foreground" [disabled]="disabled()" [attr.aria-label]="'Toggle ' + c.label + ' for every row'" (click)="toggleColumn(c.id)">
              {{ c.label }}
            </button>
          </span>
        }
      </div>
      @for (g of groups(); track g.name) {
        <div class="text-muted-foreground bg-muted/20 border-b px-3 py-1 text-[11px] font-medium tracking-wide uppercase">{{ g.name }}</div>
        @for (r of g.items; track r.id) {
          <div class="flex items-center gap-3 border-b px-3 py-1.5 last:border-b-0">
            <span class="min-w-0 flex-1">
              <span class="block text-[13px]">{{ r.label }}</span>
              <span class="text-muted-foreground block text-xs leading-snug">{{ r.description }}</span>
            </span>
            @for (c of columns; track c.id) {
              <span class="flex w-14 justify-center">
                <input
                  type="checkbox"
                  class="accent-primary size-4 cursor-pointer disabled:cursor-not-allowed disabled:opacity-30"
                  [checked]="has(r.id, c.id)"
                  [disabled]="disabled() || lockedIn(r.id, c.id)"
                  [attr.aria-label]="(lockedIn(r.id, c.id) ? 'From the role: ' : '') + c.label + ' ' + r.label"
                  (change)="toggle(r.id, c.id, $any($event.target).checked)"
                />
              </span>
            }
          </div>
        }
      }
    </div>
    <p class="text-muted-foreground text-xs leading-snug">
      @if (locked().length) {
        Greyed checks come from the role and stay. Anything else you tick is added for this person only. Create, edit and delete include view.
      } @else {
        This is what the role starts with. People keep these actions; an invitation can add more, not take them away.
      }
    </p>
  `,
})
export class MemberAccessEditor {
  /** Kept so callers can name the role. Not used to clamp the table. */
  readonly role = input<Role>('member');
  readonly projects = input<{ id: string; name: string }[]>([]);
  readonly showProjects = input(true);
  /** Grants the role already gives. Shown checked and not removable. */
  readonly locked = input<readonly MemberGrant[]>([]);
  readonly disabled = input(false);
  readonly value = model.required<MemberAccess>();

  protected readonly columns = MEMBER_ACTION_META;
  protected readonly groups = computed(() =>
    GROUPS.map((name) => ({
      name,
      items: MEMBER_RESOURCE_ORDER.filter((id) => MEMBER_RESOURCES[id].group === name).map((id) => ({ id, ...MEMBER_RESOURCES[id] })),
    })),
  );
  protected readonly presetButtons = computed(() =>
    this.locked().length
      ? [
          { id: 'clear' as const, label: 'No extras' },
          { id: 'create' as const, label: 'Add create' },
          { id: 'all' as const, label: 'Add all' },
        ]
      : [
          { id: 'full' as const, label: 'Full access' },
          { id: 'read' as const, label: 'Read only' },
          { id: 'create' as const, label: "Create, don't edit" },
        ],
  );
  protected readonly summary = computed(() =>
    this.locked().length ? `${this.value().grants.length} added` : `${this.value().grants.length} selected`,
  );

  protected lockedIn(resource: MemberResource, action: MemberAction): boolean {
    return this.locked().includes(`${resource}:${action}`);
  }

  protected has(resource: MemberResource, action: MemberAction): boolean {
    return this.lockedIn(resource, action) || this.value().grants.includes(`${resource}:${action}`);
  }

  protected setAllProjects(all: boolean): void {
    const current = this.value();
    this.value.set({
      ...current,
      projects: { all, projectIds: all ? [] : current.projects.projectIds },
      includeUnassigned: all ? true : current.includeUnassigned,
    });
  }

  protected toggleProject(id: string, on: boolean): void {
    const ids = new Set(this.value().projects.projectIds);
    if (on) ids.add(id);
    else ids.delete(id);
    this.value.set({ ...this.value(), projects: { all: false, projectIds: [...ids] } });
  }

  protected setUnassigned(includeUnassigned: boolean): void {
    this.value.set({ ...this.value(), includeUnassigned });
  }

  protected toggle(resource: MemberResource, action: MemberAction, on: boolean): void {
    const grant = `${resource}:${action}` as MemberGrant;
    if (this.locked().includes(grant)) return;
    const locked = new Set(this.locked());
    const row = new Set(this.value().grants.filter((item) => item.startsWith(`${resource}:`) && !locked.has(item)));
    if (on) {
      row.add(grant);
      const view = `${resource}:view` as MemberGrant;
      if (!locked.has(view)) row.add(view);
    } else if (action === 'view') row.clear();
    else row.delete(grant);
    const others = this.value().grants.filter((item) => !item.startsWith(`${resource}:`));
    this.value.set({ ...this.value(), grants: ALL_GRANTS.filter((item) => !locked.has(item) && (others.includes(item) || row.has(item))) });
  }

  protected toggleColumn(action: MemberAction): void {
    const turnOn = MEMBER_RESOURCE_ORDER.some((resource) => !this.lockedIn(resource, action) && !this.value().grants.includes(`${resource}:${action}`));
    for (const resource of MEMBER_RESOURCE_ORDER) this.toggle(resource, action, turnOn);
  }

  protected applyPreset(id: 'full' | 'read' | 'create' | 'clear' | 'all'): void {
    const locked = new Set(this.locked());
    if (locked.size) {
      const grants =
        id === 'clear' || id === 'full'
          ? []
          : id === 'all'
            ? ALL_GRANTS.filter((grant) => !locked.has(grant))
            : id === 'create'
              ? ALL_GRANTS.filter((grant) => !locked.has(grant) && (grant.endsWith(':view') || grant.endsWith(':create')))
              : [];
      this.value.set({ ...this.value(), grants });
      return;
    }
    const grants =
      id === 'read'
        ? ALL_GRANTS.filter((grant) => grant.endsWith(':view'))
        : id === 'create'
          ? ALL_GRANTS.filter((grant) => grant.endsWith(':view') || grant.endsWith(':create'))
          : [...ALL_GRANTS];
    this.value.set({ ...this.value(), grants });
  }
}
