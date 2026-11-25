import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { LucideDynamicIcon, LucideEllipsis, LucideKeyRound, LucideMoon, LucideTrash2 } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmCheckbox } from '@spartan-ng/helm/checkbox';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { HlmSpinner } from '@spartan-ng/helm/spinner';
import { ApiClient } from '../../../core/api/api-client';
import { ApiError } from '../../../core/api/api-error';
import type {
  LunaGestConnectionConfigured,
  LunaGestImportResult,
  LunaGestImportableProject,
  SaveLunaGestConnectionInput,
} from '../../../core/api/api.types';
import { TramaStore } from '../../../core/stores/trama.store';
import { UiStore } from '../../../core/stores/ui.store';
import { SECTION_KIT } from './section-kit';

/** Most remote projects one import request takes (the API's limit). */
const IMPORT_MAX = 25;

/**
 * LunaGest as one of the integrations (Settings → Integrations): the workspace connection (base URL, username,
 * password), importing LunaGest projects and their tasks, and whether the timer follows LunaGest.
 * Projects opt in separately. The password is write-only and cleared after a successful save.
 */
@Component({
  selector: 'app-lunagest-integration',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButtonImports, HlmCheckbox, HlmDropdownMenuImports, HlmInputImports, HlmSpinner, LucideDynamicIcon, ...SECTION_KIT],
  host: { class: 'flex flex-col gap-3' },
  template: `
    <app-settings-group>
      <div class="flex min-h-14 items-center gap-3 px-4 py-3">
        <span class="bg-muted flex size-8 shrink-0 items-center justify-center rounded-md">
          <svg [lucideIcon]="moon" [size]="17"></svg>
        </span>
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2 text-[13px] font-medium">
            <span class="truncate">LunaGest</span>
            @if (configured(); as c) {
              <span class="text-muted-foreground truncate text-xs font-normal">{{ c.account }} · {{ host(c.baseUrl) }}</span>
            }
          </div>
          <div class="text-muted-foreground text-xs">Link projects and tasks to LunaGest, and import what is already there.</div>
        </div>
        @if (loading()) {
          <hlm-spinner class="size-4" />
        } @else if (configured()) {
          <span class="text-status-shipped flex shrink-0 items-center gap-1.5 text-xs">
            <span class="size-1.5 bg-current"></span>Connected
          </span>
          @if (canManage()) {
            <button hlmBtn variant="ghost" size="icon-sm" class="text-muted-foreground" [hlmDropdownMenuTrigger]="menu" aria-label="LunaGest connection actions">
              <svg [lucideIcon]="more" [size]="16"></svg>
            </button>
            <ng-template #menu>
              <hlm-dropdown-menu class="w-52">
                <button hlmDropdownMenuItem (triggered)="editing.set(true)">
                  <svg [lucideIcon]="keyIcon" [size]="14"></svg> Replace credentials…
                </button>
                <button hlmDropdownMenuItem variant="destructive" (triggered)="confirmRemove()">
                  <svg [lucideIcon]="trash" [size]="14"></svg> Disconnect
                </button>
              </hlm-dropdown-menu>
            </ng-template>
          }
        } @else if (canManage() && !editing()) {
          <button hlmBtn size="sm" (click)="editing.set(true)">Connect</button>
        } @else if (!canManage()) {
          <span class="text-muted-foreground shrink-0 text-xs">Not connected</span>
        }
      </div>

      @if (error(); as message) {
        <div class="bg-destructive/5 text-destructive px-4 py-2 text-xs" role="alert">{{ message }}</div>
      }

      @if (canManage() && editing()) {
        <form class="bg-muted/20" (submit)="save($event)">
            <app-settings-row label="Base URL" description="Leave empty to use the default." wide>
              <input
                hlmInput
                class="h-8 w-full font-mono text-xs"
                type="url"
                autocomplete="off"
                spellcheck="false"
                placeholder="https://panel.lunagest.com"
                aria-label="Base URL"
                [value]="baseUrl()"
                (input)="baseUrl.set($any($event.target).value)"
              />
            </app-settings-row>
            <app-settings-row label="Username" wide>
              <input
                hlmInput
                class="h-8 w-full text-[13px]"
                autocomplete="off"
                aria-label="Username"
                [value]="username()"
                (input)="username.set($any($event.target).value)"
              />
            </app-settings-row>
            <app-settings-row label="Password" description="Stored on the server. It is not shown again." wide>
              <input
                hlmInput
                class="h-8 w-full text-[13px]"
                type="password"
                autocomplete="off"
                aria-label="Password"
                [value]="password()"
                (input)="password.set($any($event.target).value)"
              />
            </app-settings-row>
            <div class="flex items-center justify-end gap-2 px-4 py-2">
              <button hlmBtn type="button" variant="ghost" size="sm" (click)="cancelEdit()">Cancel</button>
              <button hlmBtn type="submit" size="sm" [disabled]="!canSave()">
                @if (busy()) {
                  <hlm-spinner class="size-3.5" />
                }
                Save
              </button>
            </div>
          </form>
      }

      @if (configured() && !editing()) {
        <!-- Import -->
        <app-settings-row
          label="Import from LunaGest"
          description="Bring LunaGest projects and their tasks into Trama. Running it again never duplicates anything: what is already linked is reused."
        >
          @if (canImport()) {
            @if (picking()) {
              <button hlmBtn variant="ghost" size="sm" (click)="closeImport()">Close</button>
            } @else {
              <button hlmBtn variant="outline" size="sm" (click)="openImport()">Choose projects…</button>
            }
          } @else {
            <span class="text-muted-foreground text-xs">Needs permission to manage projects and create tasks</span>
          }
        </app-settings-row>

        @if (picking()) {
          <div class="bg-muted/20 px-4 py-3">
            @if (loadingProjects()) {
              <p class="text-muted-foreground flex items-center gap-2 py-3 text-xs" role="status">
                <hlm-spinner class="size-3.5" /> Reading your LunaGest projects…
              </p>
            } @else if (projectsError(); as message) {
              <p class="text-destructive py-3 text-xs" role="alert">{{ message }}</p>
              <button hlmBtn variant="outline" size="sm" (click)="loadProjects()">Try again</button>
            } @else if (!projects().length) {
              <p class="text-muted-foreground py-3 text-xs">LunaGest returned no projects for this account.</p>
            } @else {
              <div class="mb-1 flex items-center justify-between gap-3 text-xs">
                <span class="text-muted-foreground">
                  {{ selected().size }} of {{ projects().length }} selected · {{ selectedTasks() }}
                  {{ selectedTasks() === 1 ? 'task' : 'tasks' }}
                </span>
                <button hlmBtn variant="ghost" size="sm" class="h-7 px-2 text-xs" (click)="toggleAll()">
                  {{ allSelected() ? 'Clear selection' : 'Select all' }}
                </button>
              </div>
              <ul class="flex flex-col" aria-label="LunaGest projects">
                @for (p of projects(); track p.id) {
                  <li>
                    <label class="hover:bg-hover -mx-2 flex min-h-9 cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 text-[13px]">
                      <hlm-checkbox
                        [checked]="selected().has(p.id)"
                        (checkedChange)="toggle(p.id, $event)"
                        [aria-label]="'Import ' + p.name"
                      />
                      <span class="min-w-0 flex-1 truncate">{{ p.name }}</span>
                      <span class="text-muted-foreground shrink-0 text-xs tabular-nums">
                        {{ p.taskCount === null ? 'tasks unavailable' : p.taskCount + (p.taskCount === 1 ? ' task' : ' tasks') }}
                      </span>
                      @if (p.imported) {
                        <span class="bg-muted text-muted-foreground shrink-0 px-2 py-0.5 text-[11px]">
                          {{ p.projectName ? 'Linked to ' + p.projectName : 'Already linked' }}{{ p.linkedTaskCount ? ' · ' + p.linkedTaskCount + ' linked' : '' }}
                        </span>
                      }
                    </label>
                  </li>
                }
              </ul>
              @if (selected().size > importMax) {
                <p class="text-destructive mt-2 text-xs" role="alert">Select at most {{ importMax }} projects at a time.</p>
              }
              <div class="mt-3 flex items-center justify-end gap-2">
                <button hlmBtn size="sm" [disabled]="!canRun()" (click)="runImport()">
                  @if (importing()) {
                    <hlm-spinner class="size-3.5" />
                  }
                  {{ importing() ? 'Importing…' : 'Import ' + selected().size + (selected().size === 1 ? ' project' : ' projects') }}
                </button>
              </div>
            }
          </div>
        }

        @if (result(); as r) {
          <div class="px-4 py-3" role="status" aria-label="Import result">
            <p class="text-[13px] font-medium">Import finished</p>
            <ul class="mt-2 flex flex-col gap-1.5">
              @for (p of r.projects; track p.remoteProjectId) {
                <li class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs">
                  <span class="text-[13px] font-medium">{{ p.remoteProjectName }}</span>
                  @if (p.error) {
                    <span class="text-destructive">{{ p.error }}</span>
                  } @else {
                    <span class="text-muted-foreground">{{ projectOutcome(p.project) }}</span>
                    <span class="text-muted-foreground tabular-nums">
                      · <span class="text-foreground font-medium">{{ p.tasks.created }}</span> created,
                      <span class="text-foreground font-medium">{{ p.tasks.linked }}</span> linked to an existing task,
                      {{ p.tasks.existing }} already there
                    </span>
                  }
                </li>
              }
            </ul>
            <p class="text-muted-foreground mt-2 text-xs tabular-nums">
              Total: {{ totals().created }} created, {{ totals().linked }} linked.
            </p>
          </div>
        }
      }
    </app-settings-group>
  `,
})
export class LunagestIntegration {
  private readonly store = inject(TramaStore);
  private readonly api = inject(ApiClient);
  private readonly ui = inject(UiStore);

  protected readonly moon = LucideMoon;
  protected readonly more = LucideEllipsis;
  protected readonly keyIcon = LucideKeyRound;
  protected readonly trash = LucideTrash2;
  protected readonly importMax = IMPORT_MAX;

  protected readonly canManage = computed(() => this.store.allowed('manageIntegrations'));
  protected readonly canImport = computed(() => this.store.allowed('manageProjects') && this.store.allowed('createIssues'));
  protected readonly loading = signal(true);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly connection = signal<LunaGestConnectionConfigured | null>(null);
  protected readonly configured = computed(() => this.connection());
  protected readonly editing = signal(false);
  protected readonly baseUrl = signal('');
  protected readonly username = signal('');
  protected readonly password = signal('');
  protected readonly canSave = computed(
    () => !this.busy() && this.username().trim().length > 0 && this.password().trim().length > 0,
  );

  // import
  protected readonly picking = signal(false);
  protected readonly loadingProjects = signal(false);
  protected readonly projectsError = signal('');
  protected readonly projects = signal<readonly LunaGestImportableProject[]>([]);
  protected readonly selected = signal<ReadonlySet<string>>(new Set());
  protected readonly importing = signal(false);
  protected readonly result = signal<LunaGestImportResult | null>(null);
  protected readonly allSelected = computed(() => this.projects().length > 0 && this.selected().size === this.projects().length);
  protected readonly selectedTasks = computed(() =>
    this.projects().filter((p) => this.selected().has(p.id)).reduce((n, p) => n + (p.taskCount ?? 0), 0),
  );
  protected readonly canRun = computed(
    () => !this.importing() && this.selected().size > 0 && this.selected().size <= IMPORT_MAX,
  );
  protected readonly totals = computed(() => {
    const r = this.result();
    return {
      created: r?.projects.reduce((n, p) => n + p.tasks.created, 0) ?? 0,
      linked: r?.projects.reduce((n, p) => n + p.tasks.linked, 0) ?? 0,
    };
  });

  constructor() {
    effect(() => {
      const slug = this.store.slug();
      if (!slug || !this.store.ready()) return;
      untracked(() => void this.load(slug));
    });
  }

  protected host(url: string): string {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  }

  protected projectOutcome(kind: 'created' | 'linked' | 'existing' | 'failed'): string {
    switch (kind) {
      case 'created':
        return 'New project created';
      case 'linked':
        return 'Linked to the project with the same name';
      case 'existing':
        return 'Project was already linked';
      default:
        return 'Not imported';
    }
  }

  private async load(slug: string): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    try {
      const connection = await this.api.lunagest.connection(slug, { quiet: true });
      if (connection.configured) {
        this.connection.set(connection);
        this.baseUrl.set(connection.baseUrl);
      } else {
        this.connection.set(null);
      }
    } catch (e) {
      this.connection.set(null);
      this.error.set(ApiError.from(e).message);
    } finally {
      this.loading.set(false);
    }
  }

  protected cancelEdit(): void {
    this.editing.set(false);
    this.password.set('');
    this.error.set('');
  }

  protected async save(event: Event): Promise<void> {
    event.preventDefault();
    const slug = this.store.slug();
    if (!slug || !this.canSave()) return;
    const input: SaveLunaGestConnectionInput = {
      username: this.username().trim(),
      password: this.password(),
    };
    const baseUrl = this.baseUrl().trim();
    if (baseUrl) input.baseUrl = baseUrl;
    this.busy.set(true);
    this.error.set('');
    try {
      const saved = await this.api.lunagest.saveConnection(slug, input, { quiet: true });
      this.connection.set(saved);
      this.baseUrl.set(saved.baseUrl);
      this.password.set('');
      this.editing.set(false);
    } catch (e) {
      this.error.set(ApiError.from(e).message);
    } finally {
      this.busy.set(false);
    }
  }

  protected confirmRemove(): void {
    this.ui.setConfirmDelete({
      title: 'Disconnect LunaGest?',
      description: 'Projects and tasks stay in Trama, but they stop syncing with LunaGest until you connect again.',
      confirmLabel: 'Disconnect',
      onConfirm: () => this.remove(),
    });
  }

  private async remove(): Promise<void> {
    const slug = this.store.slug();
    if (!slug || this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      await this.api.lunagest.removeConnection(slug, { quiet: true });
      this.connection.set(null);
      this.username.set('');
      this.password.set('');
      this.baseUrl.set('');
      this.closeImport();
      this.result.set(null);
    } catch (e) {
      this.error.set(ApiError.from(e).message);
    } finally {
      this.busy.set(false);
    }
  }

  // ── import

  protected openImport(): void {
    this.picking.set(true);
    this.result.set(null);
    void this.loadProjects();
  }

  protected closeImport(): void {
    this.picking.set(false);
    this.selected.set(new Set());
  }

  protected async loadProjects(): Promise<void> {
    const slug = this.store.slug();
    if (!slug) return;
    this.loadingProjects.set(true);
    this.projectsError.set('');
    try {
      const list = await this.api.lunagest.importable(slug, { quiet: true });
      this.projects.set(list);
      // Not-yet-imported projects start selected: that is what people come here to do.
      this.selected.set(new Set(list.filter((p) => !p.imported).slice(0, IMPORT_MAX).map((p) => p.id)));
    } catch (e) {
      this.projectsError.set(ApiError.from(e).message);
    } finally {
      this.loadingProjects.set(false);
    }
  }

  protected toggle(id: string, on: boolean): void {
    this.selected.update((s) => {
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  protected toggleAll(): void {
    this.selected.set(this.allSelected() ? new Set() : new Set(this.projects().map((p) => p.id)));
  }

  protected async runImport(): Promise<void> {
    const slug = this.store.slug();
    if (!slug || !this.canRun()) return;
    this.importing.set(true);
    this.projectsError.set('');
    try {
      const res = await this.api.lunagest.importProjects(slug, [...this.selected()], { quiet: true });
      this.result.set(res);
      this.picking.set(false);
      this.selected.set(new Set());
      // New projects and tasks are in the workspace now: bring them into the app.
      void this.store.refetch();
    } catch (e) {
      this.projectsError.set(ApiError.from(e).message);
    } finally {
      this.importing.set(false);
    }
  }
}
