import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { HlmSwitchImports } from '@spartan-ng/helm/switch';
import { LucideUsers, LucideWorkflow } from '@lucide/angular';
import { TramaStore, usePageShortcuts } from '../../core';
import { PageHeader } from '../../shared/page-header';
import { OptionMenu, type PickOption } from '../views/option-controls';
import { ExecutionGraph } from './execution-graph';
import { buildExecutionGraph, graphStats } from './graph-model';

/** `/:ws/graph` — the workspace execution graph with team / workstream filters. */
@Component({
  selector: 'app-graph-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PageHeader, OptionMenu, HlmSwitchImports, ExecutionGraph],
  host: { class: 'flex h-full min-h-0 flex-col' },
  template: `
    <app-page-header
      title="Execution graph"
      [description]="stats().workstreams + ' workstreams · ' + stats().artifacts + ' artifacts · ' + stats().dependencies + ' dependencies'"
    />
    <div class="flex flex-wrap items-center gap-2 border-b px-4 py-2 sm:px-6">
      <app-option-menu label="Team" [options]="teamOptions()" [(selected)]="team" anyLabel="All teams" [icon]="usersIcon" />
      <app-option-menu label="Workstream" [options]="wsOptions()" [(selected)]="workstream" anyLabel="All workstreams" [icon]="flowIcon" />
      <label class="text-muted-foreground ml-1 flex cursor-pointer items-center gap-2 text-xs">
        <hlm-switch size="sm" [(checked)]="artifacts" /> Artifacts
      </label>
      <label class="text-muted-foreground flex cursor-pointer items-center gap-2 text-xs">
        <hlm-switch size="sm" [(checked)]="hideShipped" /> Hide shipped
      </label>
    </div>
    @if (stats().workstreams && !stats().dependencies) {
      <p class="text-muted-foreground border-b px-4 py-2 text-xs sm:px-6" role="status">
        No dependencies in this view. Select a workstream and add a dependency from its details to show what blocks the work.
      </p>
    }
    <div class="min-h-0 flex-1">
      <app-execution-graph [graph]="graph()" />
    </div>
  `,
})
export class GraphPage {
  /** From the parent `:workspaceSlug` route segment. */
  readonly workspaceSlug = input<string>();

  private readonly store = inject(TramaStore);
  protected readonly usersIcon = LucideUsers;
  protected readonly flowIcon = LucideWorkflow;

  protected readonly team = signal<string[]>([]);
  protected readonly workstream = signal<string[]>([]);
  protected readonly artifacts = signal(true);
  protected readonly hideShipped = signal(false);

  protected readonly teamOptions = computed<PickOption[]>(() =>
    this.store.teams().map((t) => ({ value: t.id, label: t.name, color: t.color, hint: t.key })),
  );
  protected readonly wsOptions = computed<PickOption[]>(() =>
    this.store.workstreams().map((w) => ({ value: w.id, label: `${w.key} ${w.title}`, status: w.status })),
  );

  protected readonly graph = computed(() =>
    buildExecutionGraph(
      {
        workstreams: this.store.workstreams(),
        artifacts: this.store.artifacts(),
        dependencies: this.store.dependencies(),
      },
      {
        teamId: this.team()[0] ?? null,
        workstreamId: this.workstream()[0] ?? null,
        includeArtifacts: this.artifacts(),
        hideShipped: this.hideShipped(),
      },
    ),
  );
  protected readonly stats = computed(() => graphStats(this.graph()));

  private readonly _keys = usePageShortcuts([
    { keys: 'a', label: 'Toggle artifacts', run: () => this.artifacts.update((v) => !v) },
    { keys: 'h', label: 'Toggle hide shipped', run: () => this.hideShipped.update((v) => !v) },
  ]);
}
