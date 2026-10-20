import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  model,
  signal,
  untracked,
} from '@angular/core';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { HlmLabelImports } from '@spartan-ng/helm/label';
import { HlmTextareaImports } from '@spartan-ng/helm/textarea';
import {
  TramaStore,
  shortDate,
  type Release,
  type ReleasePipeline,
  type ReleasePipelineType,
} from '../../core';
import { DatePicker } from '../../shared/date-picker';
import { Picker, type PickOption } from '../../shared/picker';
import { AppSelect, type Option } from '../create/form-kit';
import { isoFromDate, PIPELINE_TYPE_LABEL } from './release-model';

const TYPE_OPTIONS: Option<ReleasePipelineType>[] = [
  { value: 'continuous', label: PIPELINE_TYPE_LABEL.continuous },
  { value: 'scheduled', label: PIPELINE_TYPE_LABEL.scheduled },
];

@Component({
  selector: 'app-release-pipeline-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    HlmButtonImports,
    HlmDialogImports,
    HlmInputImports,
    HlmLabelImports,
    AppSelect,
    Picker,
  ],
  host: { class: 'contents' },
  template: `
    <hlm-dialog [state]="open() ? 'open' : 'closed'" (closed)="open.set(false)">
      <hlm-dialog-content
        *hlmDialogPortal="let ctx"
        class="sm:max-w-md"
        (keydown.meta.enter)="submit()"
        (keydown.control.enter)="submit()"
      >
        <hlm-dialog-header>
          <h2 hlmDialogTitle>{{ pipeline() ? 'Edit pipeline' : 'New pipeline' }}</h2>
          <p hlmDialogDescription>
            Pipelines group versions. Continuous ships whenever you complete a release; scheduled
            uses target dates.
          </p>
        </hlm-dialog-header>
        <div class="grid gap-3">
          <div class="grid gap-1.5">
            <label hlmLabel for="rpl-name">Name</label>
            <input
              hlmInput
              id="rpl-name"
              maxlength="200"
              autocomplete="off"
              placeholder="Production"
              [value]="name()"
              (input)="name.set($any($event.target).value)"
            />
          </div>
          <div class="grid gap-3 sm:grid-cols-2">
            <div class="grid min-w-0 gap-1.5">
              <label hlmLabel>Type</label>
              <app-select [options]="typeOptions" [(value)]="type" size="sm" />
            </div>
            <div class="grid min-w-0 gap-1.5">
              <label hlmLabel>Team</label>
              <app-picker
                label="Team"
                placeholder="Optional"
                [clearable]="true"
                clearLabel="No team"
                [options]="teamOptions()"
                [value]="teamId() ? [teamId()] : []"
                (valueChange)="teamId.set($event[0] ?? '')"
              />
            </div>
          </div>
          @if (type() === 'scheduled') {
            <label class="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                class="mt-0.5"
                [checked]="moveNext()"
                (change)="moveNext.set($any($event.target).checked)"
              />
              <span> Move leftover open issues to the next draft when a release is completed </span>
            </label>
          }
        </div>
        <hlm-dialog-footer>
          <button hlmBtn variant="outline" hlmDialogClose type="button">Cancel</button>
          <button hlmBtn type="button" [disabled]="busy() || !name().trim()" (click)="submit()">
            {{ pipeline() ? 'Save' : 'Create pipeline' }}
          </button>
        </hlm-dialog-footer>
      </hlm-dialog-content>
    </hlm-dialog>
  `,
})
export class ReleasePipelineDialog {
  private readonly store = inject(TramaStore);
  readonly open = model(false);
  readonly pipeline = input<ReleasePipeline>();
  readonly created = model<ReleasePipeline | undefined>(undefined);

  protected readonly typeOptions = TYPE_OPTIONS;
  protected readonly name = signal('');
  protected readonly type = signal<string>('continuous');
  protected readonly teamId = signal('');
  protected readonly moveNext = signal(false);
  protected readonly busy = signal(false);
  protected readonly teamOptions = computed<PickOption[]>(() =>
    this.store.teams().map((t) => ({ value: t.id, label: t.name, kind: 'team', hint: t.key })),
  );

  constructor() {
    effect(() => {
      if (!this.open()) return;
      const p = this.pipeline();
      untracked(() => {
        this.name.set(p?.name ?? '');
        this.type.set(p?.type ?? 'continuous');
        this.teamId.set(p?.teamId ?? '');
        this.moveNext.set(p?.moveOpenIssuesToNext ?? false);
        this.busy.set(false);
      });
    });
  }

  protected async submit(): Promise<void> {
    const name = this.name().trim();
    if (!name || this.busy()) return;
    this.busy.set(true);
    const type = this.type() === 'scheduled' ? 'scheduled' : 'continuous';
    const teamId = this.teamId() || undefined;
    const moveOpenIssuesToNext = type === 'scheduled' ? this.moveNext() : false;
    const existing = this.pipeline();
    if (existing) {
      const ok = await this.store.updateReleasePipeline(existing.id, {
        name,
        type,
        teamId: teamId ?? null,
        moveOpenIssuesToNext,
      });
      this.busy.set(false);
      if (ok) this.open.set(false);
      return;
    }
    const created = await this.store.createReleasePipeline({
      name,
      type,
      teamId,
      moveOpenIssuesToNext,
    });
    this.busy.set(false);
    if (created) {
      this.created.set(created);
      this.open.set(false);
    }
  }
}

@Component({
  selector: 'app-release-form-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    HlmButtonImports,
    HlmDialogImports,
    HlmInputImports,
    HlmLabelImports,
    HlmTextareaImports,
    DatePicker,
  ],
  host: { class: 'contents' },
  template: `
    <hlm-dialog [state]="open() ? 'open' : 'closed'" (closed)="open.set(false)">
      <hlm-dialog-content
        *hlmDialogPortal="let ctx"
        class="sm:max-w-md"
        (keydown.meta.enter)="submit()"
        (keydown.control.enter)="submit()"
      >
        <hlm-dialog-header>
          <h2 hlmDialogTitle>{{ release() ? 'Edit release' : 'New release' }}</h2>
          <p hlmDialogDescription>
            A version (or SHA) in this pipeline. Issues join it from their Release property.
          </p>
        </hlm-dialog-header>
        <div class="grid gap-3">
          <div class="grid gap-1.5">
            <label hlmLabel for="rel-name">Version</label>
            <input
              hlmInput
              id="rel-name"
              maxlength="200"
              autocomplete="off"
              placeholder="v1.4.0"
              [value]="name()"
              (input)="name.set($any($event.target).value)"
            />
          </div>
          @if (scheduled()) {
            <div class="grid gap-1.5">
              <label hlmLabel>Target date</label>
              <app-date-picker
                label="Target date"
                triggerClass="h-8 gap-1.5 border border-border-strong px-2 text-sm"
                [value]="targetIso()"
                (dateChange)="setDate($event)"
              >
                <span [class.text-muted-foreground]="!targetIso()">
                  {{ targetIso() ? dateLabel() : 'No date' }}
                </span>
              </app-date-picker>
            </div>
          }
          <div class="grid gap-1.5">
            <label hlmLabel for="rel-notes"
              >Notes <span class="text-muted-foreground font-normal">(markdown)</span></label
            >
            <textarea
              hlmTextarea
              id="rel-notes"
              rows="5"
              maxlength="100000"
              placeholder="What shipped in this version…"
              [value]="notes()"
              (input)="notes.set($any($event.target).value)"
            ></textarea>
          </div>
        </div>
        <hlm-dialog-footer>
          <button hlmBtn variant="outline" hlmDialogClose type="button">Cancel</button>
          <button hlmBtn type="button" [disabled]="busy() || !name().trim()" (click)="submit()">
            {{ release() ? 'Save' : 'Create release' }}
          </button>
        </hlm-dialog-footer>
      </hlm-dialog-content>
    </hlm-dialog>
  `,
})
export class ReleaseFormDialog {
  private readonly store = inject(TramaStore);
  readonly open = model(false);
  readonly pipeline = input<ReleasePipeline>();
  readonly release = input<Release>();
  readonly created = model<Release | undefined>(undefined);

  protected readonly name = signal('');
  protected readonly notes = signal('');
  protected readonly targetIso = signal<string | undefined>(undefined);
  protected readonly busy = signal(false);
  protected readonly scheduled = computed(() => this.pipeline()?.type === 'scheduled');
  protected readonly dateLabel = computed(() =>
    this.targetIso() ? shortDate(this.targetIso()) : '',
  );

  constructor() {
    effect(() => {
      if (!this.open()) return;
      const r = this.release();
      untracked(() => {
        this.name.set(r?.name ?? '');
        this.notes.set(r?.notes ?? '');
        this.targetIso.set(r?.targetAt);
        this.busy.set(false);
      });
    });
  }

  protected setDate(date: Date | null): void {
    this.targetIso.set(date ? isoFromDate(date) : undefined);
  }

  protected async submit(): Promise<void> {
    const name = this.name().trim();
    const pipeline = this.pipeline();
    if (!name || this.busy() || !pipeline) return;
    this.busy.set(true);
    const notes = this.notes().trim();
    const targetAt = this.scheduled() ? this.targetIso() : undefined;
    const existing = this.release();
    if (existing) {
      const ok = await this.store.updateRelease(existing.id, {
        name,
        notes: notes || null,
        targetAt: this.scheduled() ? (targetAt ?? null) : undefined,
      });
      this.busy.set(false);
      if (ok) this.open.set(false);
      return;
    }
    const created = await this.store.createRelease({
      pipelineId: pipeline.id,
      name,
      notes: notes || undefined,
      targetAt,
    });
    this.busy.set(false);
    if (created) {
      this.created.set(created);
      this.open.set(false);
    }
  }
}
