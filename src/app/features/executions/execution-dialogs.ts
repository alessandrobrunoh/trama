// Dialogs for executions: create, report progress, complete, edit dependencies.
// One host component; the caller sets `action` (a model) to open the right dialog.
import { ChangeDetectionStrategy, Component, computed, effect, inject, model, signal, untracked } from '@angular/core';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { HlmLabelImports } from '@spartan-ng/helm/label';
import { HlmTextareaImports } from '@spartan-ng/helm/textarea';
import {
  EXECUTION_STATES,
  EXECUTION_STATE_META,
  NablaStore,
  type ActorRef,
  type Execution,
  type ExecutionProvider,
  type ExecutionState,
} from '../../core';
import { Kbd } from '../../shared/kbd';
import { Picker, actorValue, parseActor, type PickOption } from '../workstreams/picker';
import { performerOptions, providerOptions, repoOptions, teamOptions } from '../workstreams/ws-model';

export type ExecAction =
  | { kind: 'create'; workstreamId?: string; parentExecutionId?: string }
  | { kind: 'progress'; executionId: string }
  | { kind: 'complete'; executionId: string }
  | { kind: 'deps'; executionId: string };

/** Options for choosing executions of one workstream. */
export function executionOptions(store: NablaStore, workstreamId: string | undefined, exclude: ReadonlySet<string> = new Set()): PickOption[] {
  if (!workstreamId) return [];
  return (store.executionsByWorkstream().get(workstreamId) ?? [])
    .filter((e) => !exclude.has(e.id))
    .map((e) => ({ value: e.id, label: e.title, kind: 'status' as const, status: e.state }));
}

function descendants(store: NablaStore, id: string): Set<string> {
  const out = new Set<string>([id]);
  const walk = (x: string) => {
    for (const c of store.childExecutions().get(x) ?? []) {
      if (!out.has(c.id)) {
        out.add(c.id);
        walk(c.id);
      }
    }
  };
  walk(id);
  return out;
}

@Component({
  selector: 'app-execution-dialogs',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmDialogImports, HlmButtonImports, HlmInputImports, HlmTextareaImports, HlmLabelImports, Picker, Kbd],
  template: `
    <!-- create -->
    <hlm-dialog [state]="kind() === 'create' ? 'open' : 'closed'" (closed)="close('create')">
      <hlm-dialog-content *hlmDialogPortal="let ctx" class="max-h-[92svh] overflow-y-auto sm:max-w-xl" (keydown.meta.enter)="create()" (keydown.control.enter)="create()">
        <hlm-dialog-header>
          <h2 hlmDialogTitle>New execution</h2>
          <p hlmDialogDescription>A concrete attempt to perform part of a workstream, by people and/or agents.</p>
        </hlm-dialog-header>
        <div class="grid gap-3">
          @if (!fixedWorkstream()) {
            <div class="grid gap-1.5">
              <label hlmLabel>Workstream</label>
              <app-picker label="Workstream" placeholder="Select workstream" [options]="workstreamOptions()" [value]="cWorkstream() ? [cWorkstream()] : []" (valueChange)="cWorkstream.set($event[0] ?? ''); cParent.set(''); cDeps.set([])" />
            </div>
          }
          <div class="grid gap-1.5">
            <label hlmLabel for="ce-title">Title</label>
            <input hlmInput id="ce-title" autocomplete="off" placeholder="Implement token family revocation" [value]="cTitle()" (input)="cTitle.set($any($event.target).value)" />
          </div>
          <div class="grid gap-1.5">
            <label hlmLabel for="ce-desc">Description <span class="text-muted-foreground font-normal">(optional)</span></label>
            <textarea hlmTextarea id="ce-desc" rows="2" class="min-h-14" [value]="cDesc()" (input)="cDesc.set($any($event.target).value)"></textarea>
          </div>
          <div class="grid gap-1.5">
            <label hlmLabel>Performers</label>
            <app-picker label="Performers" placeholder="Unassigned" [multiple]="true" [options]="performers()" [value]="cPerformers()" (valueChange)="setPerformers($event)" />
          </div>
          <div class="grid gap-3 sm:grid-cols-2">
            <div class="grid min-w-0 gap-1.5">
              <label hlmLabel>Provider</label>
              <app-picker label="Provider" [searchable]="false" [options]="providers" [value]="[cProvider()]" (valueChange)="setProvider($event[0])" />
            </div>
            <div class="grid min-w-0 gap-1.5">
              <label hlmLabel>Team</label>
              <app-picker label="Team" placeholder="No team" [clearable]="true" [options]="teams()" [value]="cTeam() ? [cTeam()] : []" (valueChange)="cTeam.set($event[0] ?? '')" />
            </div>
          </div>
          <div class="grid gap-1.5">
            <label hlmLabel>Repositories</label>
            <app-picker label="Repositories" placeholder="None" [multiple]="true" [options]="repos()" [value]="cRepos()" (valueChange)="cRepos.set($event)" />
          </div>
          <div class="grid gap-3 sm:grid-cols-2">
            <div class="grid min-w-0 gap-1.5">
              <label hlmLabel>Parent execution</label>
              <app-picker label="Parent" placeholder="None (top level)" [clearable]="true" [options]="siblings()" [value]="cParent() ? [cParent()] : []" (valueChange)="cParent.set($event[0] ?? '')" />
            </div>
            <div class="grid min-w-0 gap-1.5">
              <label hlmLabel>Depends on</label>
              <app-picker label="Depends on" placeholder="Nothing" [multiple]="true" [options]="siblings()" [value]="cDeps()" (valueChange)="cDeps.set($event)" />
            </div>
          </div>
        </div>
        <hlm-dialog-footer>
          <button hlmBtn variant="outline" hlmDialogClose type="button">Cancel</button>
          <button hlmBtn type="button" [disabled]="!canCreate() || busy()" (click)="create()">
            Create execution <app-kbd keys="mod+enter" class="opacity-70" />
          </button>
        </hlm-dialog-footer>
      </hlm-dialog-content>
    </hlm-dialog>

    <!-- progress / complete -->
    <hlm-dialog [state]="kind() === 'progress' || kind() === 'complete' ? 'open' : 'closed'" (closed)="close('progress'); close('complete')">
      <hlm-dialog-content *hlmDialogPortal="let ctx" class="sm:max-w-md" (keydown.meta.enter)="submitProgress()" (keydown.control.enter)="submitProgress()">
        <hlm-dialog-header>
          <h2 hlmDialogTitle>{{ kind() === 'complete' ? 'Complete execution' : 'Report progress' }}</h2>
          <p hlmDialogDescription class="truncate">{{ target()?.title }}</p>
        </hlm-dialog-header>
        <div class="grid gap-3">
          <div class="grid gap-1.5">
            <label hlmLabel for="pr-note">{{ kind() === 'complete' ? 'Closing note (optional)' : 'Progress note' }}</label>
            <textarea hlmTextarea id="pr-note" rows="3" class="min-h-20" placeholder="What happened since the last update?" [value]="pNote()" (input)="pNote.set($any($event.target).value)"></textarea>
          </div>
          @if (kind() === 'progress') {
            <div class="grid gap-1.5">
              <label hlmLabel>State</label>
              <app-picker label="State" [searchable]="false" [options]="stateOptions" [value]="[pState()]" (valueChange)="pState.set($any($event[0] ?? ''))" />
            </div>
          }
        </div>
        <hlm-dialog-footer>
          <button hlmBtn variant="outline" hlmDialogClose type="button">Cancel</button>
          <button hlmBtn type="button" [disabled]="busy() || (kind() === 'progress' && !pNote().trim())" (click)="submitProgress()">
            {{ kind() === 'complete' ? 'Mark completed' : 'Report progress' }}
          </button>
        </hlm-dialog-footer>
      </hlm-dialog-content>
    </hlm-dialog>

    <!-- dependencies -->
    <hlm-dialog [state]="kind() === 'deps' ? 'open' : 'closed'" (closed)="close('deps')">
      <hlm-dialog-content *hlmDialogPortal="let ctx" class="sm:max-w-md">
        <hlm-dialog-header>
          <h2 hlmDialogTitle>Dependencies</h2>
          <p hlmDialogDescription>Executions that must complete before “{{ target()?.title }}” can proceed.</p>
        </hlm-dialog-header>
        <div class="grid gap-1.5">
          <label hlmLabel>Depends on</label>
          <app-picker label="Depends on" placeholder="Nothing" [multiple]="true" [options]="depOptions()" [value]="dDeps()" (valueChange)="dDeps.set($event)" />
        </div>
        <hlm-dialog-footer>
          <button hlmBtn variant="outline" hlmDialogClose type="button">Cancel</button>
          <button hlmBtn type="button" [disabled]="busy()" (click)="saveDeps()">Save dependencies</button>
        </hlm-dialog-footer>
      </hlm-dialog-content>
    </hlm-dialog>
  `,
})
export class ExecutionDialogs {
  private readonly store = inject(NablaStore);

  readonly action = model<ExecAction | null>(null);

  protected readonly kind = computed(() => this.action()?.kind ?? null);
  protected readonly busy = signal(false);
  protected readonly providers = providerOptions();
  protected readonly stateOptions: PickOption[] = [
    { value: '', label: 'Keep current state', kind: 'plain' },
    ...EXECUTION_STATES.map((s) => ({ value: s, label: EXECUTION_STATE_META[s].label, kind: 'status' as const })),
  ];

  protected readonly teams = computed(() => teamOptions(this.store));
  protected readonly repos = computed(() => repoOptions(this.store));
  protected readonly performers = computed(() => performerOptions(this.store));
  protected readonly workstreamOptions = computed<PickOption[]>(() =>
    this.store.workstreams().map((w) => ({ value: w.id, label: `${w.key} ${w.title}`, kind: 'status', status: w.status })),
  );

  // create form
  protected readonly cWorkstream = signal('');
  protected readonly cTitle = signal('');
  protected readonly cDesc = signal('');
  protected readonly cPerformers = signal<string[]>([]);
  protected readonly cProvider = signal<ExecutionProvider>('human');
  protected readonly cTeam = signal('');
  protected readonly cRepos = signal<string[]>([]);
  protected readonly cParent = signal('');
  protected readonly cDeps = signal<string[]>([]);
  private providerTouched = false;

  protected readonly fixedWorkstream = computed(() => {
    const a = this.action();
    return a?.kind === 'create' && !!a.workstreamId;
  });
  protected readonly siblings = computed(() => executionOptions(this.store, this.cWorkstream()));
  protected readonly canCreate = computed(() => this.cTitle().trim().length > 0 && !!this.cWorkstream());

  // progress form
  protected readonly pNote = signal('');
  protected readonly pState = signal<ExecutionState | ''>('');
  protected readonly target = computed<Execution | undefined>(() => {
    const a = this.action();
    return a && a.kind !== 'create' ? this.store.getExecution(a.executionId) : undefined;
  });

  // deps form
  protected readonly dDeps = signal<string[]>([]);
  protected readonly depOptions = computed(() => {
    const t = this.target();
    return t ? executionOptions(this.store, t.workstreamId, descendants(this.store, t.id)) : [];
  });

  constructor() {
    effect(() => {
      const a = this.action();
      untracked(() => {
        this.busy.set(false);
        if (!a) return;
        if (a.kind === 'create') {
          this.cWorkstream.set(a.workstreamId ?? '');
          this.cTitle.set('');
          this.cDesc.set('');
          this.cPerformers.set([]);
          this.cProvider.set('human');
          this.providerTouched = false;
          this.cTeam.set('');
          this.cRepos.set(a.workstreamId ? [...(this.store.getWorkstream(a.workstreamId)?.repositoryIds ?? [])] : []);
          this.cParent.set(a.parentExecutionId ?? '');
          this.cDeps.set([]);
        } else {
          const e = this.store.getExecution(a.executionId);
          this.pNote.set('');
          this.pState.set('');
          this.dDeps.set(e ? [...e.dependsOnExecutionIds] : []);
        }
      });
    });
  }

  protected close(k: ExecAction['kind']): void {
    if (this.action()?.kind === k) this.action.set(null);
  }

  protected setPerformers(values: string[]): void {
    this.cPerformers.set(values);
    if (this.providerTouched) return;
    const agent = values.map(parseActor).find((a) => a.type === 'agent');
    if (agent) {
      const p = this.store.agentById().get(agent.id ?? '')?.provider;
      if (p) this.cProvider.set(p);
    } else {
      this.cProvider.set('human');
    }
  }

  protected setProvider(p: string | undefined): void {
    this.providerTouched = true;
    this.cProvider.set((p ?? 'human') as ExecutionProvider);
  }

  protected async create(): Promise<void> {
    if (!this.canCreate() || this.busy()) return;
    this.busy.set(true);
    const performers: ActorRef[] = this.cPerformers().map(parseActor);
    const created = await this.store.createExecution({
      workstreamId: this.cWorkstream(),
      title: this.cTitle().trim(),
      description: this.cDesc().trim() || undefined,
      performers,
      provider: this.cProvider(),
      teamId: this.cTeam() || undefined,
      repositoryIds: this.cRepos(),
      parentExecutionId: this.cParent() || undefined,
      dependsOnExecutionIds: this.cDeps().length ? this.cDeps() : undefined,
      state: 'queued',
    });
    this.busy.set(false);
    if (created) this.action.set(null);
  }

  protected async submitProgress(): Promise<void> {
    const a = this.action();
    if (!a || (a.kind !== 'progress' && a.kind !== 'complete') || this.busy()) return;
    this.busy.set(true);
    const note = this.pNote().trim();
    if (a.kind === 'complete') await this.store.completeExecution(a.executionId, note || undefined);
    else if (note) await this.store.reportProgress(a.executionId, { note, state: this.pState() || undefined });
    this.busy.set(false);
    this.action.set(null);
  }

  protected async saveDeps(): Promise<void> {
    const a = this.action();
    if (a?.kind !== 'deps') return;
    this.busy.set(true);
    await this.store.updateExecution(a.executionId, { dependsOnExecutionIds: this.dDeps() });
    this.busy.set(false);
    this.action.set(null);
  }
}

export { actorValue };
