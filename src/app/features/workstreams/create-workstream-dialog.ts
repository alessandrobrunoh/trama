import { ChangeDetectionStrategy, Component, computed, effect, inject, input, model, signal, untracked } from '@angular/core';
import { Router } from '@angular/router';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDatePickerImports } from '@spartan-ng/helm/date-picker';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { HlmLabelImports } from '@spartan-ng/helm/label';
import { HlmTextareaImports } from '@spartan-ng/helm/textarea';
import { TramaStore, WORKSTREAM_STATUS_META, isDeltaThreadUrl, type Priority, type WorkstreamStatus } from '../../core';
import { Notifier } from '../../core/notify/notifier';
import { Kbd } from '../../shared/kbd';
import { Picker } from './picker';
import { priorityOptions, projectOptions, repoOptionsIn, teamOptions, userOptions } from './ws-model';

export interface CreateWorkstreamDefaults {
  ownerTeamId?: string;
  projectId?: string;
  repositoryIds?: string[];
  title?: string;
  priority?: Priority;
  accountableUserId?: string;
  /** Pin the status (e.g. created from a board column). */
  statusOverride?: WorkstreamStatus;
}

/** "New workstream" dialog: title, objective, owner / participating teams, accountable, priority, date, repos. */
@Component({
  selector: 'app-create-workstream-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    HlmDialogImports,
    HlmButtonImports,
    HlmInputImports,
    HlmTextareaImports,
    HlmLabelImports,
    HlmDatePickerImports,
    Picker,
    Kbd,
  ],
  template: `
    <hlm-dialog [state]="open() ? 'open' : 'closed'" (closed)="open.set(false)">
      <hlm-dialog-content *hlmDialogPortal="let ctx" class="max-h-[92svh] overflow-y-auto sm:max-w-xl" (keydown.meta.enter)="submit()" (keydown.control.enter)="submit()">
        <hlm-dialog-header>
          <h2 hlmDialogTitle>New workstream</h2>
          <p hlmDialogDescription>An outcome the team decided to pursue. Link the issues it resolves, then track PRs, decisions and acceptance criteria on it.</p>
        </hlm-dialog-header>
        @if (statusOverride(); as so) {
          <p class="bg-muted text-muted-foreground -mt-1 rounded-md px-2.5 py-1.5 text-xs">
            Status will be pinned to <span class="text-foreground font-medium">{{ statusLabel(so) }}</span>. You can switch it back to automatic later.
          </p>
        }

        <div class="grid gap-3">
          <div class="grid gap-1.5">
            <label hlmLabel for="cw-title">Title</label>
            <input
              hlmInput
              id="cw-title"
              placeholder="Stabilize authentication before v2"
              autocomplete="off"
              [attr.aria-invalid]="titleError() ? 'true' : null"
              [value]="title()"
              (input)="title.set($any($event.target).value)"
            />
            @if (titleError(); as err) {
              <p class="text-destructive text-xs" role="alert">{{ err }}</p>
            }
          </div>
          <div class="grid gap-1.5">
            <label hlmLabel for="cw-desc">Description <span class="text-muted-foreground font-normal">· optional</span></label>
            <textarea
              hlmTextarea
              id="cw-desc"
              rows="3"
              class="min-h-16 resize-y"
              placeholder="What is this workstream about?"
              [value]="description()"
              (input)="description.set($any($event.target).value)"
            ></textarea>
          </div>
          @if (deltaEnabled()) {
            <div class="grid gap-1.5">
              <label hlmLabel for="cw-delta">Delta thread <span class="text-muted-foreground font-normal">· optional</span></label>
              <input
                hlmInput
                id="cw-delta"
                placeholder="https://delta.dev/t/…"
                autocomplete="off"
                [attr.aria-invalid]="deltaError() ? 'true' : null"
                [value]="deltaUrl()"
                (input)="deltaUrl.set($any($event.target).value)"
              />
              @if (deltaError(); as err) {
                <p class="text-destructive text-xs" role="alert">{{ err }}</p>
              }
            </div>
          }
          <div class="grid gap-1.5">
            <label hlmLabel for="cw-objective">Objective <span class="text-muted-foreground font-normal">· optional, markdown</span></label>
            <textarea
              hlmTextarea
              id="cw-objective"
              rows="3"
              class="min-h-16 resize-y"
              placeholder="What needs to be true when this is done?"
              [value]="objective()"
              (input)="objective.set($any($event.target).value)"
            ></textarea>
          </div>
          <div class="grid gap-3 sm:grid-cols-2">
            <div class="grid min-w-0 gap-1.5">
              <label hlmLabel>Owner team</label>
              <app-picker
                label="Owner team"
                placeholder="Select team"
                [options]="teams()"
                [value]="ownerTeamId() ? [ownerTeamId()] : []"
                (valueChange)="setOwner($event[0])"
              />
              @if (teamError(); as err) {
                <p class="text-destructive text-xs" role="alert">{{ err }}</p>
              }
            </div>
            <div class="grid min-w-0 gap-1.5">
              <label hlmLabel>Accountable</label>
              <app-picker
                label="Accountable"
                placeholder="Unassigned"
                [clearable]="true"
                [options]="users()"
                [value]="accountable() ? [accountable()] : []"
                (valueChange)="accountable.set($event[0] ?? '')"
              />
            </div>
          </div>
          <div class="grid gap-1.5">
            <label hlmLabel>Participating teams</label>
            <app-picker
              label="Participating teams"
              placeholder="None"
              [multiple]="true"
              [options]="participantOptions()"
              [value]="participating()"
              (valueChange)="participating.set($event)"
            />
          </div>
          <div class="grid gap-3 sm:grid-cols-2">
            <div class="grid min-w-0 gap-1.5">
              <label hlmLabel>Priority</label>
              <app-picker
                label="Priority"
                [searchable]="false"
                [options]="priorities"
                [value]="[priority()]"
                (valueChange)="priority.set($any($event[0] ?? 'none'))"
              />
            </div>
            <div class="grid min-w-0 gap-1.5">
              <label hlmLabel>Target date</label>
              <hlm-date-picker [date]="target()" (dateChange)="target.set($event)" align="start">
                <hlm-date-picker-trigger class="w-full [&>button]:w-full [&>button]:font-normal">Pick a date</hlm-date-picker-trigger>
              </hlm-date-picker>
            </div>
          </div>
          @if (projects().length) {
            <div class="grid gap-1.5">
              <label hlmLabel>Project</label>
              <app-picker
                label="Project"
                placeholder="No project"
                [clearable]="true"
                clearLabel="No project"
                [options]="projects()"
                [value]="projectId() ? [projectId()] : []"
                (valueChange)="setProject($event[0])"
              />
            </div>
          }
          <div class="grid gap-1.5">
            <label hlmLabel>Repositories</label>
            <app-picker
              label="Repositories"
              placeholder="None"
              [multiple]="true"
              [options]="repos()"
              [value]="repositories()"
              (valueChange)="repositories.set($event)"
            />
          </div>
        </div>

        <hlm-dialog-footer>
          <button hlmBtn variant="outline" hlmDialogClose type="button">Cancel</button>
          <button hlmBtn type="button" [disabled]="busy()" (click)="submit()">
            Create workstream
            <app-kbd keys="mod+enter" class="opacity-70" />
          </button>
        </hlm-dialog-footer>
      </hlm-dialog-content>
    </hlm-dialog>
  `,
})
export class CreateWorkstreamDialog {
  private readonly store = inject(TramaStore);
  private readonly router = inject(Router);
  private readonly notifier = inject(Notifier);

  readonly open = model(false);
  readonly defaults = input<CreateWorkstreamDefaults>({});

  protected readonly title = signal('');
  protected readonly description = signal('');
  protected readonly deltaUrl = signal('');
  protected readonly objective = signal('');
  protected readonly ownerTeamId = signal('');
  protected readonly participating = signal<string[]>([]);
  protected readonly accountable = signal('');
  protected readonly priority = signal<Priority>('none');
  protected readonly target = signal<Date | undefined>(undefined);
  protected readonly repositories = signal<string[]>([]);
  protected readonly statusOverride = signal<WorkstreamStatus | undefined>(undefined);
  protected readonly busy = signal(false);

  protected readonly teams = computed(() => teamOptions(this.store));
  protected readonly users = computed(() => userOptions(this.store));
  protected readonly projectId = signal('');
  protected readonly projects = computed(() => projectOptions(this.store));
  protected readonly repos = computed(() => repoOptionsIn(this.store, this.projectId()));
  protected readonly priorities = priorityOptions();
  protected readonly participantOptions = computed(() =>
    this.teams().filter((t) => t.value !== this.ownerTeamId()),
  );
  protected readonly deltaEnabled = computed(() => this.store.deltaThreads());
  /** Errors only show once the person has tried to create, like the other creation dialogs. */
  private readonly submitted = signal(false);
  protected readonly titleError = computed(() => (this.submitted() && !this.title().trim() ? 'Give it a title.' : null));
  protected readonly teamError = computed(() => (this.submitted() && !this.ownerTeamId() ? 'Pick the owner team.' : null));
  protected readonly deltaError = computed(() =>
    this.submitted() && this.deltaEnabled() && this.deltaUrl().trim() && !isDeltaThreadUrl(this.deltaUrl().trim())
      ? 'The Delta thread must be an https link on delta.dev.'
      : null,
  );

  constructor() {
    effect(() => {
      if (!this.open()) return;
      untracked(() => this.reset());
    });
  }

  private reset(): void {
    const d = this.defaults();
    this.title.set(d.title ?? '');
    this.description.set('');
    this.deltaUrl.set('');
    this.objective.set('');
    const mine = this.store.myTeams()[0]?.id ?? this.store.teams()[0]?.id ?? '';
    this.ownerTeamId.set(d.ownerTeamId ?? mine);
    this.participating.set([]);
    this.accountable.set(d.accountableUserId ?? this.store.me()?.id ?? '');
    this.priority.set(d.priority ?? 'none');
    this.statusOverride.set(d.statusOverride);
    this.target.set(undefined);
    this.projectId.set(this.store.getProject(d.projectId)?.id ?? '');
    this.repositories.set(d.repositoryIds ?? []);
    this.submitted.set(false);
    this.busy.set(false);
  }

  protected statusLabel(s: WorkstreamStatus): string {
    return WORKSTREAM_STATUS_META[s].label;
  }

  /** Picking a project narrows the repositories to its own (all of them when none were chosen yet). */
  protected setProject(id: string | undefined): void {
    this.projectId.set(id ?? '');
    const project = this.store.getProject(id);
    if (!project) return;
    const own = this.repositories().filter((r) => project.repositoryIds.includes(r));
    this.repositories.set(own.length ? own : [...project.repositoryIds]);
  }

  protected setOwner(id: string | undefined): void {
    if (!id) return;
    this.ownerTeamId.set(id);
    this.participating.update((p) => p.filter((x) => x !== id));
  }

  protected async submit(): Promise<void> {
    if (this.busy()) return;
    this.submitted.set(true);
    if (this.titleError() || this.teamError() || this.deltaError()) return;
    this.busy.set(true);
    const target = this.target();
    const ws = await this.store.createWorkstream({
      title: this.title().trim(),
      description: this.description().trim() || undefined,
      deltaThreadUrl: this.deltaEnabled() ? this.deltaUrl().trim() || undefined : undefined,
      objective: this.objective().trim() || undefined,
      ownerTeamId: this.ownerTeamId(),
      participatingTeamIds: this.participating(),
      accountableUserId: this.accountable() || undefined,
      priority: this.priority(),
      projectId: this.projectId() || undefined,
      repositoryIds: this.repositories().length ? this.repositories() : undefined,
      targetDate: target ? new Date(target.getFullYear(), target.getMonth(), target.getDate(), 12).toISOString() : undefined,
      statusOverride: this.statusOverride(),
    });
    this.busy.set(false);
    if (!ws) return;
    this.notifier.success(`${ws.key} created`, { description: ws.title });
    this.open.set(false);
    const slug = this.store.slug();
    if (slug) void this.router.navigate(['/', slug, 'workstreams', ws.key]);
  }
}
