import { ChangeDetectionStrategy, Component, computed, effect, inject, input, model, signal, untracked } from '@angular/core';
import { Router } from '@angular/router';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDatePickerImports } from '@spartan-ng/helm/date-picker';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { HlmLabelImports } from '@spartan-ng/helm/label';
import { HlmTextareaImports } from '@spartan-ng/helm/textarea';
import { NablaStore, type Priority } from '../../core';
import { Kbd } from '../../shared/kbd';
import { Picker } from './picker';
import { priorityOptions, repoOptions, teamOptions, userOptions } from './ws-model';

export interface CreateWorkstreamDefaults {
  ownerTeamId?: string;
  repositoryIds?: string[];
  title?: string;
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
          <p hlmDialogDescription>An outcome the team has decided to pursue. Executions and artifacts attach to it.</p>
        </hlm-dialog-header>

        <div class="grid gap-3">
          <div class="grid gap-1.5">
            <label hlmLabel for="cw-title">Title</label>
            <input
              hlmInput
              id="cw-title"
              placeholder="Stabilize authentication before v2"
              autocomplete="off"
              [value]="title()"
              (input)="title.set($any($event.target).value)"
            />
          </div>
          <div class="grid gap-1.5">
            <label hlmLabel for="cw-desc">Description</label>
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
          <div class="grid gap-1.5">
            <label hlmLabel for="cw-delta">Delta thread</label>
            <input
              hlmInput
              id="cw-delta"
              placeholder="https://delta.dev/t/…"
              autocomplete="off"
              [value]="deltaUrl()"
              (input)="deltaUrl.set($any($event.target).value)"
            />
          </div>
          <div class="grid gap-1.5">
            <label hlmLabel for="cw-objective">Objective <span class="text-muted-foreground font-normal">(markdown)</span></label>
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
          <div class="grid gap-1.5">
            <label hlmLabel>Projects</label>
            <app-picker
              label="Projects"
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
          <button hlmBtn type="button" [disabled]="!canSubmit() || busy()" (click)="submit()">
            Create workstream
            <app-kbd keys="mod+enter" class="opacity-70" />
          </button>
        </hlm-dialog-footer>
      </hlm-dialog-content>
    </hlm-dialog>
  `,
})
export class CreateWorkstreamDialog {
  private readonly store = inject(NablaStore);
  private readonly router = inject(Router);

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
  protected readonly busy = signal(false);

  protected readonly teams = computed(() => teamOptions(this.store));
  protected readonly users = computed(() => userOptions(this.store));
  protected readonly repos = computed(() => repoOptions(this.store));
  protected readonly priorities = priorityOptions();
  protected readonly participantOptions = computed(() =>
    this.teams().filter((t) => t.value !== this.ownerTeamId()),
  );
  protected readonly canSubmit = computed(
    () => this.title().trim().length > 0 && !!this.ownerTeamId() && /^https:\/\/([a-z0-9-]+\.)*delta\.dev(\/|$)/i.test(this.deltaUrl().trim()),
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
    this.accountable.set(this.store.me()?.id ?? '');
    this.priority.set('none');
    this.target.set(undefined);
    this.repositories.set(d.repositoryIds ?? []);
    this.busy.set(false);
  }

  protected setOwner(id: string | undefined): void {
    if (!id) return;
    this.ownerTeamId.set(id);
    this.participating.update((p) => p.filter((x) => x !== id));
  }

  protected async submit(): Promise<void> {
    if (!this.canSubmit() || this.busy()) return;
    this.busy.set(true);
    const target = this.target();
    const ws = await this.store.createWorkstream({
      title: this.title().trim(),
      description: this.description().trim() || undefined,
      deltaThreadUrl: this.deltaUrl().trim(),
      objective: this.objective().trim() || undefined,
      ownerTeamId: this.ownerTeamId(),
      participatingTeamIds: this.participating(),
      accountableUserId: this.accountable() || undefined,
      priority: this.priority(),
      repositoryIds: this.repositories(),
      targetDate: target ? new Date(target.getFullYear(), target.getMonth(), target.getDate(), 12).toISOString() : undefined,
    });
    this.busy.set(false);
    if (!ws) return;
    this.open.set(false);
    const slug = this.store.slug();
    if (slug) void this.router.navigate(['/', slug, 'workstreams', ws.key]);
  }
}
