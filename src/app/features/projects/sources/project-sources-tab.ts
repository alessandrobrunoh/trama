// The Sources tab of a project (v4 "App · 13 Project · Sources"): where this project's tasks come from.
// Each rule reads one external source through one connection; the rail beside them says what arrived this
// week and how matching works. Adding and editing a rule happens in an inline panel (`app-source-panel`).
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  LucideArrowDownLeft,
  LucideArrowLeftRight,
  LucideDynamicIcon,
  LucideEllipsis,
  LucideHistory,
  LucidePencil,
  LucidePlus,
  LucideTrash2,
  LucideTriangleAlert,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import type { ID, RoutingRule } from '../../../core/contracts/domain';
import { relativeTime } from '../../../core/format';
import { Notifier } from '../../../core/notify/notifier';
import { TramaStore } from '../../../core/stores/trama.store';
import { UiStore } from '../../../core/stores/ui.store';
import { ProviderIcon } from '../../../shared/provider-icon';
import { ProjectSourcesStore } from './project-sources.store';
import { SourcePanel } from './source-panel';
import {
  connectionTag,
  filterTerms,
  filterText,
  reconnectSection,
  ruleActivity,
  ruleErrorSince,
} from './source-model';

@Component({
  selector: 'app-project-sources-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButtonImports, HlmDropdownMenuImports, LucideDynamicIcon, ProviderIcon, RouterLink, SourcePanel],
  host: { class: 'flex min-w-0 flex-1 max-lg:flex-col' },
  template: `
    <div class="flex min-w-0 flex-1 flex-col gap-4 px-4 py-[22px] sm:px-10">
      <div class="flex items-end gap-2.5">
        <div class="flex min-w-0 flex-1 flex-col gap-1">
          <h2 class="font-title text-foreground m-0 text-[20px] leading-normal font-normal">Sources</h2>
          <p class="text-muted-foreground m-0 text-[12.5px]">
            Where this project's tasks come from. Each rule reads one external source through one connection.
          </p>
        </div>
        @if (canManage() && !panel()) {
          <button hlmBtn type="button" (click)="panel.set('add')">
            <svg [lucideIcon]="plus" [size]="13"></svg>
            Add source
          </button>
        }
      </div>

      @if (store.failed() && !store.overview()) {
        <div class="border-border flex items-center gap-3 border px-3.5 py-3 text-[12.5px]">
          <span class="text-muted-foreground flex-1">The sources could not be loaded.</span>
          <button hlmBtn variant="outline" size="sm" type="button" (click)="reload()">Try again</button>
        </div>
      } @else if (!store.overview()) {
        <p class="text-faint m-0 font-mono text-[11px]">Loading sources…</p>
      } @else {
        @if (panel() === 'add') {
          <app-source-panel [projectId]="projectId()" (closed)="panel.set(null)" />
        }

        <ul class="m-0 flex list-none flex-col gap-2.5 p-0" aria-label="Sources">
          @for (r of store.rules(); track r.id) {
            <li class="bg-card border-border flex flex-col border">
              <div class="flex items-center gap-3.5 px-3.5 py-3">
                <span class="bg-secondary border-border text-muted-foreground flex size-[30px] shrink-0 items-center justify-center border">
                  <app-provider-icon [provider]="r.provider" [size]="15" />
                </span>
                <div class="flex min-w-0 flex-1 flex-col gap-[3px]">
                  <div class="flex min-w-0 flex-wrap items-center gap-2">
                    <span class="text-foreground min-w-0 truncate font-mono text-[12.5px]">{{ source(r) }}</span>
                    @for (t of terms(r); track filterText(t)) {
                      <span class="bg-secondary border-border text-text-2 border px-[7px] py-0.5 font-mono text-[11px]">{{ chip(t) }}</span>
                    }
                  </div>
                  <div class="flex min-w-0 flex-wrap items-center gap-1.5">
                    <span class="text-faint font-mono text-[10.5px]">via</span>
                    @if (r.connection; as c) {
                      <span class="text-text-2 truncate text-xs">{{ c.label }}</span>
                      <span
                        class="border px-[7px] py-0.5 font-mono text-[11px]"
                        [class]="c.ownerType === 'workspace' ? 'bg-primary/10 border-primary/40 text-foreground' : 'bg-secondary border-border text-text-2'"
                      >{{ tag(r) }}</span>
                    } @else {
                      <span class="text-destructive text-xs">a connection that was removed</span>
                    }
                  </div>
                </div>
                <span class="text-text-2 flex w-24 shrink-0 items-center gap-[5px] font-mono text-[10.5px] max-md:hidden">
                  <svg [lucideIcon]="r.direction === 'two_way' ? twoWay : inbound" [size]="12" class="text-muted-foreground"></svg>
                  {{ r.direction === 'two_way' ? 'Two-way' : 'Inbound' }}
                </span>
                <span class="flex w-[130px] shrink-0 flex-col items-end gap-0.5 max-sm:hidden">
                  <span class="border-border text-text-2 inline-flex items-center gap-[5px] border px-[7px] py-0.5 font-mono text-[10.5px]">
                    <span class="size-1.5" [style.background]="r.health === 'ok' ? 'var(--status-done)' : 'var(--red)'" aria-hidden="true"></span>
                    {{ r.health === 'ok' ? 'Healthy' : 'Error' }}
                  </span>
                  <span class="text-faint font-mono text-[10px]">{{ detail(r) }}</span>
                </span>
                @if (canManage()) {
                  <button
                    hlmBtn
                    variant="ghost"
                    size="icon"
                    type="button"
                    class="text-muted-foreground shrink-0"
                    [attr.aria-label]="'Actions for ' + source(r)"
                    [hlmDropdownMenuTrigger]="menu"
                  >
                    <svg [lucideIcon]="more" [size]="14"></svg>
                  </button>
                  <ng-template #menu>
                    <hlm-dropdown-menu class="w-44">
                      <button hlmDropdownMenuItem (triggered)="edit(r)">
                        <svg [lucideIcon]="pencil" [size]="14"></svg> Edit
                      </button>
                      <hlm-dropdown-menu-separator />
                      <button hlmDropdownMenuItem variant="destructive" (triggered)="remove(r)">
                        <svg [lucideIcon]="trash" [size]="14"></svg> Remove
                      </button>
                    </hlm-dropdown-menu>
                  </ng-template>
                }
              </div>

              @if (r.health === 'error') {
                <div class="border-red/20 flex flex-wrap items-center gap-2.5 border-t px-3.5 py-2.5" role="alert">
                  <svg [lucideIcon]="alert" [size]="13" class="text-destructive shrink-0"></svg>
                  <span class="text-text-2 min-w-0 flex-1 text-xs">{{ r.healthReason ?? r.lastError ?? 'This source is not arriving.' }}</span>
                  @if (canManage() && r.connection?.ownerType !== 'workspace') {
                    <button hlmBtn variant="outline" size="sm" type="button" (click)="useWorkspaceConnection(r)">
                      {{ r.connection ? 'Switch to workspace connection' : 'Choose a connection' }}
                    </button>
                  }
                  @if (canReconnect(r)) {
                    <a hlmBtn size="sm" [routerLink]="['/', slug(), 'settings', section(r)]">Reconnect</a>
                  }
                </div>
              }

              @if (editing()?.id === r.id) {
                <div class="border-border border-t p-3.5">
                  <app-source-panel [projectId]="projectId()" [rule]="r" (closed)="panel.set(null)" />
                </div>
              }
            </li>
          } @empty {
            <li class="border-border flex flex-col items-start gap-1.5 border border-dashed px-4 py-5">
              <span class="text-foreground text-[13px]">No sources yet</span>
              <span class="text-muted-foreground text-xs leading-[18px]">
                Issues and pull requests from GitHub or GitLab only arrive here once a source is added.
              </span>
            </li>
          }
        </ul>
      }
    </div>

    <aside class="bg-card border-border shrink-0 max-lg:border-t lg:w-[300px] lg:border-l" aria-label="About sources">
      <section class="border-border flex flex-col gap-2.5 border-b px-4 py-3.5">
        <h3 class="text-faint m-0 font-mono text-[10.5px] font-normal">THIS WEEK</h3>
        <div class="flex items-center">
          <span class="text-muted-foreground flex-1 text-[12.5px]">Tasks arrived</span>
          <span class="text-foreground font-mono text-[10.5px] tabular-nums">{{ store.stats().tasksArrived }}</span>
        </div>
        <div class="flex items-center">
          <span class="text-muted-foreground flex-1 text-[12.5px]">Unmatched PRs placed here</span>
          <span class="text-foreground font-mono text-[10.5px] tabular-nums">{{ store.stats().unmatchedPlaced }}</span>
        </div>
        <div class="flex items-center">
          <span class="text-muted-foreground flex-1 text-[12.5px]">Rules failing</span>
          <span
            class="font-mono text-[10.5px] tabular-nums"
            [class]="store.stats().rulesFailing ? 'text-destructive' : 'text-foreground'"
          >{{ store.stats().rulesFailing }}</span>
        </div>
      </section>
      <section class="border-border flex flex-col gap-2.5 border-b px-4 py-3.5">
        <h3 class="text-faint m-0 font-mono text-[10.5px] font-normal">MATCHING</h3>
        <p class="text-text-2 m-0 text-xs leading-[18px]">
          Pull requests, commits and CI still attach to tasks by key, like {{ exampleKey() }}. A rule only decides where unmatched ones go.
        </p>
      </section>
      <section class="border-border flex flex-col gap-2.5 border-b px-4 py-3.5">
        <h3 class="text-faint m-0 font-mono text-[10.5px] font-normal">WHO CAN ADD SOURCES</h3>
        <p class="text-text-2 m-0 text-xs leading-[18px]">
          Admins, organizers, members and guests who can create tasks in {{ projectName() }}.
        </p>
      </section>
      @if (migrated(); as m) {
        <section class="border-border flex flex-col gap-2.5 border-b px-4 py-3.5">
          <h3 class="text-faint m-0 font-mono text-[10.5px] font-normal">MIGRATED</h3>
          <p class="text-muted-foreground m-0 flex items-center gap-2 text-xs">
            <svg [lucideIcon]="history" [size]="12" class="shrink-0"></svg>
            <span class="min-w-0">Repository field <span class="font-mono">{{ m.rule.migratedFrom }}</span> became rule {{ m.number }}.</span>
          </p>
        </section>
      }
    </aside>
  `,
})
export class ProjectSourcesTab {
  readonly projectId = input.required<ID>();

  protected readonly store = inject(ProjectSourcesStore);
  private readonly trama = inject(TramaStore);
  private readonly ui = inject(UiStore);
  private readonly notifier = inject(Notifier);

  protected readonly plus = LucidePlus;
  protected readonly more = LucideEllipsis;
  protected readonly pencil = LucidePencil;
  protected readonly trash = LucideTrash2;
  protected readonly alert = LucideTriangleAlert;
  protected readonly history = LucideHistory;
  protected readonly inbound = LucideArrowDownLeft;
  protected readonly twoWay = LucideArrowLeftRight;
  protected readonly filterText = filterText;

  /** `add` is the panel under the header; a rule id edits that rule where it is. */
  protected readonly panel = signal<'add' | ID | null>(null);
  protected readonly editing = computed(() => {
    const id = this.panel();
    return id && id !== 'add' ? (this.store.rules().find((r) => r.id === id) ?? null) : null;
  });

  protected readonly slug = computed(() => this.trama.slug() ?? '');
  protected readonly canManage = computed(() => this.store.canManage());
  protected readonly projectName = computed(() => this.trama.getProject(this.projectId())?.name ?? 'this project');
  protected readonly exampleKey = computed(() => `${this.trama.getProject(this.projectId())?.key ?? 'WEB'}-142`);
  protected readonly migrated = computed(() => {
    const rules = this.store.rules();
    const index = rules.findIndex((r) => r.migratedFrom);
    return index < 0 ? null : { rule: rules[index], number: index + 1 };
  });

  /** Loads the sources when the tab opens or the project changes. */
  private readonly _load = effect(() => {
    const id = this.projectId();
    untracked(() => {
      this.panel.set(null);
      void this.store.load(id);
    });
  });

  protected source(r: RoutingRule): string {
    return r.host === 'github.com' ? r.sourcePath : `${r.host}/${r.sourcePath}`;
  }

  protected terms(r: RoutingRule) {
    return filterTerms(r.filters);
  }

  protected chip(t: ReturnType<typeof filterTerms>[number]): string {
    return filterText(t);
  }

  protected tag(r: RoutingRule): string {
    return connectionTag(r.connection);
  }

  protected detail(r: RoutingRule): string {
    return r.health === 'ok' ? ruleActivity(r, relativeTime) : ruleErrorSince(r, relativeTime);
  }

  protected section(r: RoutingRule): string {
    return reconnectSection(r.connection);
  }

  /** The workspace's integrations are for people who manage them; a personal connection is fixed by its owner. */
  protected canReconnect(r: RoutingRule): boolean {
    const c = r.connection;
    if (!c) return false;
    return c.ownerType === 'user' ? c.mine === true : this.trama.allowed('manageIntegrations');
  }

  protected edit(r: RoutingRule): void {
    this.panel.set(r.id);
  }

  protected reload(): void {
    void this.store.load(this.projectId());
  }

  protected remove(r: RoutingRule): void {
    const projectId = this.projectId();
    this.ui.setConfirmDelete({
      title: `Remove ${this.source(r)}?`,
      description:
        'New issues and pull requests from it stop arriving here. Tasks that already arrived stay.',
      confirmLabel: 'Remove',
      onConfirm: async () => {
        await this.store.remove(projectId, r.id);
      },
    });
  }

  /** The workspace connection keeps working when people leave: move the rule onto it. */
  protected async useWorkspaceConnection(r: RoutingRule): Promise<void> {
    const projectId = this.projectId();
    const options = await this.store.connections(projectId, r.provider);
    const target = options.find((o) => o.ownerType === 'workspace' && o.healthy);
    if (!target) {
      if (r.connection) {
        this.notifier.error('No workspace connection for ' + r.provider, {
          description: 'Ask an admin to connect one in Settings → Integrations, or pick another connection.',
        });
      } else this.panel.set(r.id);
      return;
    }
    const result = await this.store.update(projectId, r.id, { connectionId: target.id });
    if (!result.ok) this.notifier.error('Could not switch the connection', { description: result.message });
  }
}
