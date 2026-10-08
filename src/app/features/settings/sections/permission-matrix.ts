import { ChangeDetectionStrategy, Component, computed, model } from '@angular/core';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import {
  API_PERMISSIONS,
  API_RESOURCES,
  PERMISSION_PRESETS,
  type ApiAction,
  type ApiPermission,
  type ApiResource,
} from '../../../core/contracts/domain';

const COLUMNS: { id: ApiAction; label: string }[] = [
  { id: 'read', label: 'Read' },
  { id: 'write', label: 'Write' },
  { id: 'delete', label: 'Delete' },
  { id: 'accept', label: 'Accept' },
];

/** Grants that let a key reshape who can access the workspace; worth a second look. */
const SENSITIVE: ApiPermission[] = ['tokens:write', 'members:write', 'members:delete', 'integrations:write', 'workspace:delete', 'agents:write'];

/** Resource × action grid for `custom` API tokens. Writing implies reading; removing read clears the row. */
@Component({
  selector: 'app-permission-matrix',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButtonImports],
  host: { class: 'flex flex-col gap-2' },
  template: `
    <div class="flex flex-wrap items-center gap-1.5">
      @for (p of presets; track p.id) {
        <button type="button" hlmBtn variant="outline" size="sm" class="h-7 text-xs" [title]="p.description" (click)="value.set([...p.permissions])">
          {{ p.label }}
        </button>
      }
      <button type="button" hlmBtn variant="ghost" size="sm" class="text-muted-foreground h-7 text-xs" (click)="value.set([])">Clear</button>
      <span class="text-muted-foreground ml-auto text-xs">{{ value().length }} of {{ total }} selected</span>
    </div>

    <div class="rounded-md border" role="group" aria-label="API permissions">
      <div class="bg-muted/40 text-muted-foreground flex items-center gap-3 border-b px-3 py-1.5 text-[11px] font-medium uppercase">
        <span class="flex-1">Resource</span>
        @for (c of columns; track c.id) {
          <span class="w-14 text-center">{{ c.label }}</span>
        }
      </div>
      @for (g of groups; track g.name) {
        <div class="text-muted-foreground bg-muted/20 border-b px-3 py-1 text-[11px] font-medium">{{ g.name }}</div>
        @for (r of g.items; track r.id) {
          <div class="flex items-center gap-3 border-b px-3 py-1.5 last:border-b-0">
            <span class="flex-1 text-[13px]">{{ r.label }}</span>
            @for (c of columns; track c.id) {
              <span class="flex w-14 justify-center">
                @if (r.actions.includes(c.id)) {
                  <input
                    type="checkbox"
                    class="accent-primary size-4 cursor-pointer"
                    [checked]="has(r.id, c.id)"
                    [attr.aria-label]="c.label + ' ' + r.label"
                    (change)="toggle(r.id, c.id, $any($event.target).checked)"
                  />
                }
              </span>
            }
          </div>
        }
      }
    </div>

    @if (sensitive().length) {
      <p class="text-status-needs-input text-xs leading-snug">
        Includes access-management permissions ({{ sensitive().join(', ') }}). Whoever holds this key can change who can use the workspace.
      </p>
    }
  `,
})
export class PermissionMatrix {
  readonly value = model<ApiPermission[]>([]);

  protected readonly columns = COLUMNS;
  protected readonly total = API_PERMISSIONS.length;
  protected readonly presets = (Object.keys(PERMISSION_PRESETS) as (keyof typeof PERMISSION_PRESETS)[]).map((id) => ({ id, ...PERMISSION_PRESETS[id] }));
  protected readonly groups = (['Work', 'Insight', 'Organization', 'Access & automation'] as const).map((name) => ({
    name,
    items: (Object.keys(API_RESOURCES) as ApiResource[]).filter((id) => API_RESOURCES[id].group === name).map((id) => ({ id, ...API_RESOURCES[id] })),
  }));
  protected readonly sensitive = computed(() => SENSITIVE.filter((p) => this.value().includes(p)));

  protected has(resource: ApiResource, action: ApiAction): boolean {
    return this.value().includes(`${resource}:${action}`);
  }

  protected toggle(resource: ApiResource, action: ApiAction, on: boolean): void {
    const row = new Set(this.value().filter((p) => p.startsWith(`${resource}:`)));
    const perm = `${resource}:${action}` as ApiPermission;
    if (on) {
      row.add(perm);
      row.add(`${resource}:read` as ApiPermission); // anything beyond read implies read
    } else if (action === 'read') {
      row.clear();
    } else {
      row.delete(perm);
    }
    const others = this.value().filter((p) => !p.startsWith(`${resource}:`));
    this.value.set(API_PERMISSIONS.filter((p) => others.includes(p) || row.has(p)));
  }
}
