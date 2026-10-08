import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import {
  LucideBuilding2,
  LucideDynamicIcon,
  LucideFolderGit2,
  LucideInbox,
  LucideLayers,
  LucideScale,
  LucideTerminal,
  LucideUsers,
  LucideWorkflow,
  type LucideIcon,
} from '@lucide/angular';
import { toast } from '@spartan-ng/brain/sonner';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDatePickerImports } from '@spartan-ng/helm/date-picker';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { HlmSpinner } from '@spartan-ng/helm/spinner';
import { HlmSwitchImports } from '@spartan-ng/helm/switch';
import { HlmTextareaImports } from '@spartan-ng/helm/textarea';
import { HlmToggleGroupImports } from '@spartan-ng/helm/toggle-group';
import type { ExecutionProvider, GitProvider, IssueKind, Priority, ViewEntity } from '../../core/contracts/domain';
import { ISSUE_KIND_META, ISSUE_KINDS, PRIORITIES, PRIORITY_META, PROVIDER_META, PROVIDERS } from '../../core/meta';
import { NablaStore } from '../../core/stores/nabla.store';
import { UiStore, type CreateKind } from '../../core/stores/ui.store';
import { Kbd } from '../../shared/kbd';
import { AppMultiSelect, AppSelect, FormRow, type Option } from './form-kit';

interface KindDef {
  kind: CreateKind;
  label: string;
  icon: LucideIcon;
}

/** The four entities shown in the switcher. Other kinds (team, view, …) open the dialog in single-form mode. */
const SWITCHER: KindDef[] = [
  { kind: 'workstream', label: 'Workstream', icon: LucideWorkflow },
  { kind: 'issue', label: 'Issue', icon: LucideInbox },
  { kind: 'decision', label: 'Decision', icon: LucideScale },
];
const EXTRA: Partial<Record<CreateKind, KindDef>> = {
  team: { kind: 'team', label: 'Team', icon: LucideUsers },
  repository: { kind: 'repository', label: 'Project', icon: LucideFolderGit2 },
  view: { kind: 'view', label: 'View', icon: LucideLayers },
};

const NONE = '';
const asStr = (v: unknown): string => (typeof v === 'string' ? v : '');
const asArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/**
 * Global create dialog (`ui.modal() === 'create'`). Entity switcher for workstream / issue / execution /
 * decision with context defaults from `ui.createDefaults()`, plus compact forms for team / repository / view.
 * On success: toast with a link, navigate to the new entity.
 */
@Component({
  selector: 'app-create-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    HlmDialogImports,
    HlmButtonImports,
    HlmInputImports,
    HlmTextareaImports,
    HlmToggleGroupImports,
    HlmDatePickerImports,
    HlmSwitchImports,
    HlmSpinner,
    LucideDynamicIcon,
    Kbd,
    AppSelect,
    AppMultiSelect,
    FormRow,
  ],
  template: `
    <hlm-dialog [state]="open() ? 'open' : 'closed'" (closed)="onClosed()">
      <hlm-dialog-content *hlmDialogPortal="let ctx" class="max-h-[92svh] gap-3 overflow-y-auto p-4 sm:max-w-xl" [showCloseButton]="false">
        <hlm-dialog-header class="gap-2">
          <h2 hlmDialogTitle class="sr-only">New {{ kindLabel() }}</h2>
          <p hlmDialogDescription class="sr-only">Create a new {{ kindLabel().toLowerCase() }} in this workspace.</p>
          @if (showSwitcher()) {
            <div class="-mx-1 overflow-x-auto px-1 scrollbar-none">
              <hlm-toggle-group
                type="single"
                variant="outline"
                size="sm"
                [value]="kind()"
                (valueChange)="onSwitch($event)"
                class="w-max"
                aria-label="What to create"
              >
                @for (k of switcher; track k.kind) {
                  <button hlmToggleGroupItem [value]="k.kind" [attr.aria-label]="k.label" class="gap-1.5 px-2.5 text-[13px]">
                    <svg [lucideIcon]="k.icon" [size]="14"></svg>
                    {{ k.label }}
                  </button>
                }
              </hlm-toggle-group>
            </div>
          } @else {
            <div class="flex items-center gap-2 text-sm font-medium">
              <svg [lucideIcon]="extraIcon()" [size]="15" class="text-muted-foreground"></svg>
              New {{ kindLabel().toLowerCase() }}
            </div>
          }
        </hlm-dialog-header>

        <form (submit)="submit($event)" (keydown.control.enter)="submit($event)" (keydown.meta.enter)="submit($event)" novalidate class="flex flex-col gap-3">
          @switch (kind()) {
            @case ('workstream') {
              <app-form-row for="cr-title" [error]="err('title')">
                <input hlmInput id="cr-title" class="text-base font-medium md:text-base" placeholder="Workstream title, e.g. Stabilize authentication" [(ngModel)]="title" name="title" autocomplete="off" autofocus />
              </app-form-row>
              <app-form-row>
                <textarea hlmTextarea rows="3" class="min-h-16" placeholder="Description" [(ngModel)]="text" name="description"></textarea>
              </app-form-row>
              <app-form-row [error]="err('delta')">
                <input hlmInput placeholder="Delta thread, e.g. https://delta.dev/t/…" [(ngModel)]="deltaUrl" name="delta" autocomplete="off" />
              </app-form-row>
              <div class="grid gap-3 sm:grid-cols-2">
                <app-form-row label="Owner team" [error]="err('team')">
                  <app-select [options]="teamOptions()" [(value)]="ownerTeamId" placeholder="Choose a team" label="Owner team" [invalid]="!!err('team')" />
                </app-form-row>
                <app-form-row label="Priority">
                  <app-select [options]="priorityOptions" [(value)]="priority" placeholder="Priority" label="Priority" />
                </app-form-row>
                <app-form-row label="Accountable" [optional]="true">
                  <app-select [options]="userOptions()" [(value)]="accountableId" placeholder="Nobody yet" label="Accountable" />
                </app-form-row>
                <app-form-row label="Target date" [optional]="true">
                  <hlm-date-picker [(date)]="targetDate" align="start">
                    <hlm-date-picker-trigger variant="outline" class="w-full justify-start font-normal">Pick a date</hlm-date-picker-trigger>
                  </hlm-date-picker>
                </app-form-row>
              </div>
              @if (repoOptions().length) {
                <app-form-row label="Projects" [optional]="true">
                  <app-multi-select [options]="repoOptions()" [(value)]="repositoryIds" placeholder="None selected" label="Projects" />
                </app-form-row>
              }
            }

            @case ('issue') {
              <app-form-row for="cr-title" [error]="err('title')">
                <input hlmInput id="cr-title" class="text-base font-medium md:text-base" placeholder="What happened, or what is needed?" [(ngModel)]="title" name="title" autocomplete="off" autofocus />
              </app-form-row>
              <app-form-row>
                <textarea hlmTextarea rows="4" class="min-h-20" placeholder="Details, steps to reproduce, links" [(ngModel)]="text" name="body"></textarea>
              </app-form-row>
              <div class="grid gap-3 sm:grid-cols-3">
                <app-form-row label="Type">
                  <app-select [options]="issueKindOptions" [(value)]="issueKind" label="Type" />
                </app-form-row>
                <app-form-row label="Priority">
                  <app-select [options]="priorityOptions" [(value)]="priority" label="Priority" />
                </app-form-row>
                <app-form-row label="Team" [optional]="true">
                  <app-select [options]="teamOptionsOptional()" [(value)]="teamId" placeholder="No team" label="Team" />
                </app-form-row>
              </div>
            }

            @case ('decision') {
              <app-form-row for="cr-title" [error]="err('title')">
                <input hlmInput id="cr-title" class="text-base font-medium md:text-base" placeholder="Decision title, e.g. Use opaque session tokens" [(ngModel)]="title" name="title" autocomplete="off" autofocus />
              </app-form-row>
              <app-form-row [error]="err('statement')">
                <textarea hlmTextarea rows="3" class="min-h-16" placeholder="What was decided?" [(ngModel)]="text" name="statement"></textarea>
              </app-form-row>
              <app-form-row>
                <textarea hlmTextarea rows="2" class="min-h-12" placeholder="Rationale: why (optional)" [(ngModel)]="text2" name="rationale"></textarea>
              </app-form-row>
              <div class="grid gap-3 sm:grid-cols-2">
                <app-form-row label="Status">
                  <app-select [options]="decisionStatusOptions" [(value)]="decisionStatus" label="Status" />
                </app-form-row>
                <app-form-row label="Origin workstream" [optional]="true">
                  <app-select [options]="workstreamOptionsOptional()" [(value)]="workstreamId" placeholder="None" label="Origin workstream" />
                </app-form-row>
                <app-form-row label="Tags" [optional]="true" class="sm:col-span-2" hint="Comma separated, e.g. security, api">
                  <input hlmInput placeholder="security, api" [(ngModel)]="tags" name="tags" autocomplete="off" aria-label="Tags" />
                </app-form-row>
              </div>
            }

            @case ('team') {
              <div class="grid gap-3 sm:grid-cols-[1fr_8rem]">
                <app-form-row label="Name" [error]="err('title')">
                  <input hlmInput placeholder="Platform" [ngModel]="title()" (ngModelChange)="onTeamName($event)" name="name" autocomplete="off" autofocus aria-label="Team name" />
                </app-form-row>
                <app-form-row label="Key" [error]="err('key')">
                  <input hlmInput class="font-mono uppercase" placeholder="PLAT" [(ngModel)]="teamKey" name="key" maxlength="8" autocomplete="off" aria-label="Team key" />
                </app-form-row>
              </div>
              <app-form-row label="Description" [optional]="true">
                <textarea hlmTextarea rows="2" [(ngModel)]="text" name="description" placeholder="What does this team own?"></textarea>
              </app-form-row>
              <p class="text-muted-foreground text-xs">The key prefixes workstream ids (PLAT-12) and cannot be changed later.</p>
            }

            @case ('repository') {
              <div class="grid gap-3 sm:grid-cols-[9rem_1fr]">
                <app-form-row label="Provider">
                  <app-select [options]="gitProviderOptions" [(value)]="gitProvider" label="Provider" />
                </app-form-row>
                <app-form-row label="Project" [error]="err('title')">
                  <input hlmInput class="font-mono" placeholder="acme/api" [(ngModel)]="title" name="fullName" autocomplete="off" autofocus aria-label="Project name" />
                </app-form-row>
              </div>
              <app-form-row label="Default branch" [optional]="true">
                <input hlmInput class="font-mono" placeholder="main" [(ngModel)]="text" name="branch" autocomplete="off" aria-label="Default branch" />
              </app-form-row>
            }

            @case ('view') {
              <app-form-row label="Name" [error]="err('title')">
                <input hlmInput placeholder="e.g. Blocked this week" [(ngModel)]="title" name="name" autocomplete="off" autofocus aria-label="View name" />
              </app-form-row>
              <div class="grid gap-3 sm:grid-cols-2">
                <app-form-row label="Shows">
                  <app-select [options]="viewEntityOptions" [(value)]="viewEntity" label="Entity" />
                </app-form-row>
                <app-form-row label="Visibility">
                  <label class="flex h-8 items-center gap-2 text-sm">
                    <hlm-switch [(checked)]="shared" aria-label="Share with the workspace" />
                    {{ shared() ? 'Shared with the workspace' : 'Private to me' }}
                  </label>
                </app-form-row>
              </div>
            }
          }

          <hlm-dialog-footer class="mt-1 flex-row items-center justify-between gap-2 sm:justify-between">
            <span class="text-muted-foreground flex items-center gap-1 text-xs max-sm:hidden">
              <app-kbd keys="mod+enter" /> to create
            </span>
            <span class="flex items-center gap-2 max-sm:w-full max-sm:justify-end">
              <button hlmBtn type="button" variant="ghost" hlmDialogClose>Cancel</button>
              <button hlmBtn type="submit" [disabled]="busy()">
                @if (busy()) {
                  <hlm-spinner />
                }
                Create {{ kindLabel().toLowerCase() }}
              </button>
            </span>
          </hlm-dialog-footer>
        </form>
      </hlm-dialog-content>
    </hlm-dialog>
  `,
})
export class CreateDialog {
  protected readonly ui = inject(UiStore);
  private readonly store = inject(NablaStore);
  private readonly router = inject(Router);

  protected readonly switcher = SWITCHER;
  protected readonly open = computed(() => this.ui.modal() === 'create');
  protected readonly kind = signal<CreateKind>('workstream');
  protected readonly showSwitcher = computed(() => SWITCHER.some((k) => k.kind === this.kind()));
  protected readonly kindLabel = computed(
    () => SWITCHER.find((k) => k.kind === this.kind())?.label ?? EXTRA[this.kind()]?.label ?? this.kind().replace('-', ' '),
  );
  protected readonly extraIcon = computed(() => EXTRA[this.kind()]?.icon ?? LucideBuilding2);

  // ── form state (shared across kinds; reset on open / switch) ──
  protected readonly title = signal('');
  protected readonly text = signal('');
  protected readonly deltaUrl = signal('');
  protected readonly text2 = signal('');
  protected readonly tags = signal('');
  protected readonly priority = signal<string>('none');
  protected readonly ownerTeamId = signal('');
  protected readonly accountableId = signal('');
  protected readonly targetDate = signal<Date | undefined>(undefined);
  protected readonly repositoryIds = signal<string[]>([]);
  protected readonly issueKind = signal<string>('bug');
  protected readonly teamId = signal('');
  protected readonly workstreamId = signal('');
  protected readonly parentId = signal('');
  protected readonly performer = signal('');
  protected readonly provider = signal<string>('human');
  protected readonly decisionStatus = signal<string>('proposed');
  protected readonly teamKey = signal('');
  private teamKeyTouched = false;
  protected readonly gitProvider = signal<string>('github');
  protected readonly viewEntity = signal<string>('workstream');
  protected readonly shared = signal(true);

  protected readonly busy = signal(false);
  private readonly submitted = signal(false);

  // ── options ──
  protected readonly priorityOptions: Option[] = PRIORITIES.map((p) => ({ value: p, label: PRIORITY_META[p].label }));
  protected readonly issueKindOptions: Option[] = ISSUE_KINDS.map((k) => ({ value: k, label: ISSUE_KIND_META[k].label, hint: ISSUE_KIND_META[k].prefix }));
  protected readonly providerOptions: Option[] = PROVIDERS.map((p) => ({ value: p, label: PROVIDER_META[p].label }));
  protected readonly decisionStatusOptions: Option[] = [
    { value: 'proposed', label: 'Proposed' },
    { value: 'accepted', label: 'Accepted' },
  ];
  protected readonly gitProviderOptions: Option[] = [
    { value: 'github', label: 'GitHub' },
    { value: 'gitlab', label: 'GitLab' },
  ];
  protected readonly viewEntityOptions: Option[] = [
    { value: 'workstream', label: 'Workstreams' },
    { value: 'issue', label: 'Issues' },
    { value: 'decision', label: 'Decisions' },
  ];

  protected readonly teamOptions = computed<Option[]>(() => this.store.teams().map((t) => ({ value: t.id, label: t.name, hint: t.key })));
  protected readonly teamOptionsOptional = computed<Option[]>(() => [{ value: NONE, label: 'No team' }, ...this.teamOptions()]);
  protected readonly userOptions = computed<Option[]>(() => [
    { value: NONE, label: 'Nobody yet' },
    ...this.store.users().map((u) => ({ value: u.id, label: u.name })),
  ]);
  protected readonly repoOptions = computed<Option[]>(() => this.store.repositories().map((r) => ({ value: r.id, label: r.fullName })));
  protected readonly workstreamOptions = computed<Option[]>(() =>
    this.store.workstreams().map((w) => ({ value: w.id, label: w.title, hint: w.key })),
  );
  protected readonly workstreamOptionsOptional = computed<Option[]>(() => [{ value: NONE, label: 'None' }, ...this.workstreamOptions()]);
  protected readonly actorOptions = computed<Option[]>(() => [
    { value: NONE, label: 'Me' },
    ...this.store.users().map((u) => ({ value: 'user:' + u.id, label: u.name, hint: 'person' })),
    ...this.store.agents().map((a) => ({ value: 'agent:' + a.id, label: a.name, hint: 'agent' })),
    ...this.store.teams().map((t) => ({ value: 'team:' + t.id, label: t.name, hint: 'team' })),
  ]);
  constructor() {
    // Reset the form from the context defaults each time the dialog opens.
    effect(() => {
      if (!this.open()) return;
      const kind = this.ui.createKind();
      const defaults = this.ui.createDefaults();
      untracked(() => this.reset(kind, defaults));
    });
  }

  private reset(kind: CreateKind, d: Record<string, unknown>): void {
    this.kind.set(kind);
    this.title.set('');
    this.text.set('');
    this.deltaUrl.set('');
    this.text2.set('');
    this.tags.set('');
    this.priority.set('none');
    this.accountableId.set(NONE);
    this.targetDate.set(undefined);
    this.performer.set(NONE);
    this.provider.set('human');
    this.decisionStatus.set('proposed');
    this.teamKey.set('');
    this.teamKeyTouched = false;
    this.gitProvider.set('github');
    this.viewEntity.set('workstream');
    this.shared.set(true);
    this.submitted.set(false);
    this.busy.set(false);
    this.issueKind.set(asStr(d['kind']) || 'bug');
    this.teamId.set(asStr(d['teamId']) || asStr(d['ownerTeamId']) || NONE);
    const myTeam = this.store.myTeams()[0]?.id ?? this.store.teams()[0]?.id ?? '';
    this.ownerTeamId.set(asStr(d['ownerTeamId']) || myTeam);
    this.repositoryIds.set(asArr(d['repositoryIds']).filter((id) => this.store.repositoryById().has(id)));
    this.workstreamId.set(asStr(d['workstreamId']) || NONE);
  }

  protected onSwitch(v: unknown): void {
    const next = asStr(v) as CreateKind;
    if (!next || next === this.kind()) return;
    // Carry over what the user already typed.
    this.kind.set(next);
    this.submitted.set(false);
    this.ui.createKind.set(next);
    if (next === 'decision' && this.workstreamId() === (this.store.workstreams()[0]?.id ?? '') && !this.ui.createDefaults()['workstreamId']) {
      this.workstreamId.set(NONE);
    }
  }

  protected onClosed(): void {
    if (this.ui.modal() === 'create') this.ui.closeModal();
  }

  protected onTeamName(v: string): void {
    this.title.set(v);
    if (!this.teamKeyTouched) {
      const initials = v
        .trim()
        .split(/\s+/)
        .map((w) => w[0] ?? '')
        .join('');
      this.teamKey.set((v.trim().split(/\s+/).length > 1 ? initials : v.trim().slice(0, 4)).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8));
    }
  }

  protected err(field: 'title' | 'team' | 'workstream' | 'statement' | 'key' | 'delta'): string | null {
    if (!this.submitted()) return null;
    switch (field) {
      case 'title':
        return this.title().trim() ? null : 'Required.';
      case 'delta':
        return /^https:\/\/([a-z0-9-]+\.)*delta\.dev(\/|$)/i.test(this.deltaUrl().trim()) ? null : 'Use an https link on delta.dev.';
      case 'team':
        return this.ownerTeamId() ? null : 'Pick the owning team.';
      case 'workstream':
        return this.workstreamId() ? null : 'Pick a workstream.';
      case 'statement':
        return this.text().trim() ? null : 'Say what was decided.';
      case 'key':
        return /^[A-Z][A-Z0-9]{1,7}$/.test(this.teamKey().toUpperCase()) ? null : '2 to 8 letters or digits, starting with a letter.';
    }
  }

  private valid(): boolean {
    const k = this.kind();
    const needs: Parameters<CreateDialog['err']>[0][] = ['title'];
    if (k === 'workstream') needs.push('team', 'delta');
    if (k === 'decision') needs.push('statement');
    if (k === 'team') needs.push('key');
    return needs.every((f) => !this.err(f));
  }

  protected async submit(ev: Event): Promise<void> {
    ev.preventDefault();
    if (this.busy()) return;
    this.submitted.set(true);
    if (!this.valid()) return;
    this.busy.set(true);
    try {
      const slug = this.store.slug();
      if (!slug) return;
      const title = this.title().trim();
      let done: { label: string; path: string[] } | undefined;
      switch (this.kind()) {
        case 'workstream': {
          const w = await this.store.createWorkstream({
            title,
            description: this.text().trim() || undefined,
            deltaThreadUrl: this.deltaUrl().trim(),
            ownerTeamId: this.ownerTeamId(),
            priority: this.priority() as Priority,
            accountableUserId: this.accountableId() || undefined,
            repositoryIds: this.repositoryIds().length ? this.repositoryIds() : undefined,
            targetDate: this.targetDate()?.toISOString(),
          });
          if (w) done = { label: `${w.key} created`, path: ['workstreams', w.key] };
          break;
        }
        case 'issue': {
          const i = await this.store.createIssue({
            kind: this.issueKind() as IssueKind,
            title,
            body: this.text().trim() || undefined,
            priority: this.priority() as Priority,
            teamId: this.teamId() || undefined,
          });
          if (i) done = { label: `${i.key} created`, path: ['issues', i.key] };
          break;
        }
        case 'decision': {
          const d = await this.store.proposeDecision({
            title,
            statement: this.text().trim(),
            rationale: this.text2().trim() || undefined,
            status: this.decisionStatus() as 'proposed' | 'accepted',
            originWorkstreamId: this.workstreamId() || undefined,
            tags: this.tags()
              .split(',')
              .map((t) => t.trim())
              .filter(Boolean),
          });
          if (d) done = { label: `${d.key} recorded`, path: ['decisions', d.key] };
          break;
        }
        case 'team': {
          const t = await this.store.createTeam({
            name: title,
            key: this.teamKey().toUpperCase(),
            description: this.text().trim() || undefined,
          });
          if (t) done = { label: `Team ${t.name} created`, path: ['teams', t.key] };
          break;
        }
        case 'repository': {
          const r = await this.store.createRepository({
            provider: this.gitProvider() as GitProvider,
            fullName: title,
            defaultBranch: this.text().trim() || undefined,
          });
          if (r) done = { label: `${r.fullName} added`, path: ['projects', r.id] };
          break;
        }
        case 'view': {
          const v = await this.store.createView({ name: title, entity: this.viewEntity() as ViewEntity, shared: this.shared() });
          if (v) done = { label: `View ${v.name} created`, path: ['views', v.id] };
          break;
        }
        default:
          return;
      }
      if (!done) return; // the store already toasted the failure; keep the form open
      this.ui.closeModal();
      const commands = ['/', slug, ...done.path];
      toast.success(done.label, { action: { label: 'Open', onClick: () => void this.router.navigate(commands) } });
      await this.router.navigate(commands);
    } finally {
      this.busy.set(false);
    }
  }
}
