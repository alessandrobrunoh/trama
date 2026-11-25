import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import {
  LucideBuilding2,
  LucideCircleUser,
  LucideDynamicIcon,
  LucideBox,
  LucideGauge,
  LucideLayers,
  LucideListTree,
  LucideMessageSquare,
  LucideShapes,
  LucideTag,
  LucideX,
  type LucideIcon,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { HlmKbd } from '@spartan-ng/helm/kbd';
import { HlmSpinner } from '@spartan-ng/helm/spinner';
import { HlmSwitchImports } from '@spartan-ng/helm/switch';
import { HlmTextareaImports } from '@spartan-ng/helm/textarea';
import {
  isProjectKey,
  isReservedProjectKey,
  PROJECT_KEY_MAX,
  uniqueProjectKey,
  UNASSIGNED_ISSUE_KEY_PREFIX,
  type IssueKind,
  type IssueStatus,
  type Priority,
  type ViewEntity,
  type ViewFilter,
  type ViewLayout,
} from '../../core/contracts/domain';
import {
  ISSUE_KIND_META,
  ISSUE_KINDS,
  ISSUE_STATUSES,
  ISSUE_STATUS_META,
  PRIORITIES,
  PRIORITY_META,
} from '../../core/meta';
import { Notifier } from '../../core/notify/notifier';
import { DraftStore } from '../../core/stores/draft.store';
import { TramaStore } from '../../core/stores/trama.store';
import { UiStore, type CreateKind } from '../../core/stores/ui.store';
import { Kbd } from '../../shared/kbd';
import { LabelCatalog } from '../../shared/label-catalog';
import { V3_FIELD, V3_TEXTAREA, V3DialogFoot, V3DialogHead, V3Field, V3Toggle } from '../../shared/v3';
import { issueEstimateOptions } from '../issues/issue-model';
import { isValidThreadUrl, toThreadUrl } from '../issues/issue-thread-link';
import { Picker, type PickOption } from '../../shared/picker';
import { AppSelect, FormRow, type Option } from './form-kit';
import { DraftSuggestions } from '../ai/draft-suggestions';
import type { AiIssueDraftSuggestion } from '../../core/ai/ai-api';
import { EntityChip } from '../../shared/entity-chip';

type ComposerKind = 'issue';

interface KindDef {
  kind: ComposerKind;
  label: string;
  /** One-line explanation shown under the switcher. */
  blurb: string;
  example: string;
}

/** Composer kinds. Project and view open in single-form mode. */
const SWITCHER: KindDef[] = [
  {
    kind: 'issue',
    label: 'Task',
    blurb: "A problem or request: what's wrong or needed.",
    example: 'CORA-142',
  },
];
const EXTRA: Partial<Record<CreateKind, { label: string; icon: LucideIcon }>> = {
  project: { label: 'Project', icon: LucideBox },
  view: { label: 'View', icon: LucideLayers },
};

const VIEW_LAYOUTS: readonly ViewLayout[] = ['list', 'board', 'timeline'];
const VIEW_ENTITIES: readonly ViewEntity[] = ['issue', 'project'];

const IS_MAC =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

const asStr = (v: unknown): string => (typeof v === 'string' ? v : '');
const asArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const asTags = (v: unknown): string[] =>
  (Array.isArray(v) ? asArr(v) : asStr(v).split(',')).map((t) => t.trim()).filter(Boolean);
const oneOf = <T extends string>(list: readonly T[], v: unknown): T | undefined =>
  typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : undefined;

/**
 * Global create dialog (`ui.modal() === 'create'`): a Linear-style composer for issues
 * (title · description · property chips), plus compact forms for project and view.
 *
 * Context defaults (`ui.openCreate(kind, defaults)`):
 *   issue:      status, priority, kind, assigneeId, projectId, parentId, title, body
 *   project:    name, key, summary, optional repository string (URL or owner/name)
 *   view:       name, entity, filters, sort, groupBy, layout, shared ("Save as view")
 *
 * After create we close and toast with an "Open" action instead of navigating away (Linear
 * behaviour: you stay where you were). With "Create more" on, the dialog stays open, keeps the
 * properties and clears title/description.
 */
@Component({
  selector: 'app-create-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    HlmDialogImports,
    HlmButtonImports,
    HlmInputImports,
    HlmSwitchImports,
    HlmTextareaImports,
    HlmSpinner,
    LucideDynamicIcon,
    Picker,
    AppSelect,
    FormRow,
    DraftSuggestions,
    EntityChip,
    Kbd,
    HlmKbd,
    V3DialogHead,
    V3DialogFoot,
    V3Field,
    V3Toggle,
  ],
  template: `
    <hlm-dialog [state]="open() ? 'open' : 'closed'" (closed)="onClosed()">
      <hlm-dialog-content
        *hlmDialogPortal="let ctx"
        data-variant="fullscreen"
        class="max-h-[92svh] gap-0 overflow-y-auto p-0 sm:max-w-[620px]"
        [showCloseButton]="false"
        (keydown.meta.enter)="submit($event)"
        (keydown.control.enter)="submit($event)"
        (keydown.meta.shift.enter)="submit($event, false, true)"
        (keydown.control.shift.enter)="submit($event, false, true)"
      >
        <!-- v3 · 15: kicker + Newsreader title + esc, then Body (padding 18, gap 14) and Foot -->
        <v3-dialog-head [kicker]="'NEW ' + kindLabel().toUpperCase()" (dismiss)="ui.closeModal()">
          <h2 hlmDialogTitle>Create {{ kindLabel().toLowerCase() }}</h2>
        </v3-dialog-head>
        <p hlmDialogDescription class="sr-only">
          Create a new {{ kindLabel().toLowerCase() }} in this workspace.
        </p>

        <form (submit)="submit($event)" novalidate class="flex flex-col" [class]="composer() ? '' : 'sm:min-w-md'">
          @if (restored()) {
            <div class="bg-secondary text-muted-foreground mx-[18px] mt-3.5 flex items-center gap-2 px-2.5 py-1.5 font-mono text-[10.5px]" data-testid="draft-restored">
              Restored your unsent {{ kindLabel().toLowerCase() }}.
              <button type="button" class="text-foreground ml-auto underline-offset-2 hover:underline" (click)="discardDraft()">Discard</button>
            </div>
          }
          @if (composer()) {
            <div class="flex flex-col gap-3.5 p-[18px]">
              <!-- title + description -->
              <v3-field label="TITLE" for="cr-title">
                <input
                  #titleEl
                  id="cr-title"
                  [class]="fieldClass"
                  [placeholder]="titlePlaceholder()"
                  [(ngModel)]="title"
                  name="title"
                  autocomplete="off"
                  autofocus
                  aria-label="Title"
                  [attr.aria-invalid]="!!err('title')"
                />
                @if (err('title'); as e) {
                  <p class="text-red font-mono text-[10.5px]" role="alert">{{ e }}</p>
                }
              </v3-field>
              <v3-field label="DESCRIPTION" for="cr-body">
                <textarea
                  id="cr-body"
                  [class]="textareaClass"
                  class="field-sizing-content max-h-72 min-h-[84px]"
                  rows="3"
                  [placeholder]="bodyPlaceholder()"
                  [(ngModel)]="text"
                  name="body"
                  aria-label="Description"
                ></textarea>
              </v3-field>

              <!-- quick suggestions -->
              <app-draft-suggestions
                [kind]="composer()!.kind"
                [title]="title()"
                [description]="text()"
                [disabled]="busy()"
                [current]="suggestionCurrent()"
                (titleAccepted)="title.set($event)"
                (descriptionAccepted)="text.set($event)"
                (questionPicked)="addQuestion($event)"
                (triageAccepted)="applyIssueSuggestion($event)"
                (settingsRequested)="ui.closeModal()"
              />

              <!-- property pills -->
              <div class="flex flex-wrap items-center gap-2" role="group" aria-label="Task properties">
              @switch (kind()) {
                @case ('issue') {
                  <app-picker
                    variant="pill"
                    label="Status"
                    [searchable]="false"
                    [options]="issueStatusOptions"
                    [value]="[issueStatus()]"
                    (valueChange)="setOne(issueStatus, $event)"
                  />
                  <app-picker
                    variant="pill"
                    label="Priority"
                    [searchable]="false"
                    [options]="priorityOptions"
                    [value]="[priority()]"
                    (valueChange)="setOne(priority, $event)"
                  />
                  <app-picker
                    variant="pill"
                    label="Assignee"
                    [icon]="userIcon"
                    [options]="userOptions()"
                    [value]="opt(assigneeId())"
                    [clearable]="true"
                    clearLabel="Unassigned"
                    (valueChange)="assigneeId.set($event[0] ?? '')"
                  />
                  @if (projectOptions().length) {
                    <app-picker
                      variant="pill"
                      label="Project"
                      [icon]="projectIcon"
                      [options]="projectOptions()"
                      [value]="opt(projectId())"
                      [clearable]="true"
                      clearLabel="No project"
                      (valueChange)="projectId.set($event[0] ?? '')"
                    />
                  }
                  @if (showEstimate()) {
                    <app-picker
                      variant="pill"
                      label="Estimate"
                      [icon]="estimateIcon"
                      [searchable]="false"
                      [options]="issueEstimateChoices()"
                      [value]="opt(issueEstimate())"
                      [clearable]="true"
                      clearLabel="No estimate"
                      (valueChange)="issueEstimate.set($event[0] ?? '')"
                    />
                  }
                  @if (labelOptions().length) {
                    <app-picker
                      variant="pill"
                      label="Labels"
                      [icon]="labelIcon"
                      [multiple]="true"
                      [options]="labelOptions()"
                      [value]="labelIds()"
                      (valueChange)="setLabels($event)"
                    />
                  }
                  <app-picker
                    variant="pill"
                    label="Type"
                    [icon]="typeIcon"
                    [searchable]="false"
                    [options]="issueKindOptions"
                    [value]="[issueKind()]"
                    (valueChange)="setOne(issueKind, $event)"
                  />
                }
              }
              </div>

              @if (kind() === 'issue' && parentId()) {
                <!-- Parent: the task this one hangs under -->
                <div class="bg-background border-border flex min-w-0 items-center gap-2.5 border px-3 py-2.5">
                  <svg [lucideIcon]="subtaskIcon" [size]="14" class="text-muted-foreground shrink-0" aria-hidden="true"></svg>
                  <span class="text-faint font-mono text-[10px]">PARENT</span>
                  @if (parentIssue(); as p) {
                    <span class="text-muted-foreground shrink-0 font-mono text-[11px]">{{ p.key }}</span>
                    <span class="text-foreground min-w-0 truncate text-[13px]">{{ p.title }}</span>
                  } @else {
                    <app-entity-chip class="max-w-full" type="issue" [ref]="parentId()" />
                  }
                  <span class="min-w-0 flex-1"></span>
                  <span class="text-foreground shrink-0 font-mono text-[10.5px]">→ subtask</span>
                </div>
              }

              @if (kind() === 'issue') {
                <!-- Optional Delta thread -->
                <div>
                  <div class="bg-background border-border focus-within:border-primary flex h-[34px] items-center gap-2 border px-2.5 transition-colors">
                    <svg
                      [lucideIcon]="threadIcon"
                      [size]="14"
                      class="text-delta shrink-0"
                      aria-hidden="true"
                    ></svg>
                    <input
                      class="placeholder:text-faint min-w-0 flex-1 bg-transparent font-mono text-[11.5px] outline-none"
                      placeholder="Thread link (optional), e.g. https://delta.dev/…"
                      [(ngModel)]="threadUrl"
                      name="threadUrl"
                      autocomplete="off"
                      spellcheck="false"
                      aria-label="Thread link"
                      [attr.aria-invalid]="!!err('thread')"
                    />
                  </div>
                  @if (err('thread'); as e) {
                    <p class="text-red mt-1.5 font-mono text-[10.5px]" role="alert">{{ e }}</p>
                  }
                </div>

                <label class="flex items-center gap-2.5 text-[13px]">
                  <span class="min-w-0 flex-1">Create more</span>
                  <v3-toggle [(checked)]="createMore" aria-label="Create more" />
                </label>
                <p class="text-faint font-mono text-[10.5px] leading-[15px]">
                  Start it from Delta with /trama once it exists — one thread per task or subtask.
                </p>
              }
            </div>
          } @else {
            <div class="flex flex-col gap-3 p-[18px]">
              @switch (kind()) {
                @case ('project') {
                  <app-form-row label="Name" [error]="err('title')">
                    <input
                      hlmInput
                      placeholder="Checkout redesign"
                      [ngModel]="title()"
                      (ngModelChange)="onProjectName($event)"
                      name="projectName"
                      autocomplete="off"
                      autofocus
                      aria-label="Project name"
                    />
                  </app-form-row>
                  <app-form-row label="Tag" [error]="err('key')">
                    <input
                      hlmInput
                      class="font-mono uppercase"
                      placeholder="CORA"
                      [ngModel]="projectKey()"
                      (ngModelChange)="onProjectKey($event)"
                      name="projectKey"
                      [attr.maxlength]="projectKeyMax"
                      autocomplete="off"
                      autocapitalize="characters"
                      spellcheck="false"
                      aria-label="Project tag"
                    />
                  </app-form-row>
                  <p class="text-muted-foreground -mt-1 text-xs">
                    Prefixes task keys in this project, e.g. CORA-12. Up to 4 characters; editable later.
                  </p>
                  <app-form-row label="Summary" [optional]="true">
                    <input
                      hlmInput
                      placeholder="What outcome is this project after?"
                      [(ngModel)]="text"
                      name="projectSummary"
                      autocomplete="off"
                      aria-label="Project summary"
                    />
                  </app-form-row>
                  <app-form-row label="Repository" [optional]="true">
                    <input
                      hlmInput
                      class="font-mono"
                      placeholder="owner/name or https://github.com/owner/name"
                      [(ngModel)]="repositoryText"
                      name="repository"
                      autocomplete="off"
                      aria-label="Repository"
                    />
                  </app-form-row>
                }
                @case ('view') {
                  <app-form-row label="Name" [error]="err('title')">
                    <input
                      hlmInput
                      placeholder="e.g. Blocked this week"
                      [(ngModel)]="title"
                      name="name"
                      autocomplete="off"
                      autofocus
                      aria-label="View name"
                    />
                  </app-form-row>
                  <div class="grid gap-3 sm:grid-cols-2">
                    <app-form-row label="Shows">
                      <app-select
                        [options]="viewEntityOptions"
                        [(value)]="viewEntity"
                        label="Entity"
                        [disabled]="viewPreset()"
                      />
                    </app-form-row>
                    <app-form-row label="Layout">
                      <app-select
                        [options]="viewLayoutOptions()"
                        [value]="effectiveViewLayout()"
                        (valueChange)="viewLayout.set($event)"
                        label="Layout"
                      />
                    </app-form-row>
                    <app-form-row label="Visibility">
                      <label class="flex h-8 items-center gap-2 text-sm">
                        <hlm-switch
                          [(checked)]="shared"
                          [disabled]="!canShare()"
                          aria-label="Share with the workspace"
                        />
                        {{ shared() ? 'Shared with the workspace' : 'Private to me' }}
                      </label>
                    </app-form-row>
                  </div>
                  @if (viewSummary(); as s) {
                    <p class="text-muted-foreground text-xs">Saves the current setup: {{ s }}.</p>
                  }
                }
              }
            </div>
          }

          <v3-dialog-foot [hint]="composer() ? anotherHint : ''">
            @if (composer()) {
              <button
                hlmBtn
                type="button"
                variant="ghost"
                class="max-sm:h-10"
                [disabled]="busy()"
                (click)="saveDraft($event)"
              >
                Save as draft
              </button>
            }
            <button hlmBtn type="button" variant="outline" class="max-sm:h-10" hlmDialogClose>
              Cancel <kbd hlmKbd class="h-4 max-sm:hidden">esc</kbd>
            </button>
            <button
              hlmBtn
              type="submit"
              class="max-sm:h-10"
              [attr.aria-label]="'Create ' + kindLabel().toLowerCase()"
              [disabled]="busy()"
            >
              @if (busy()) {
                <hlm-spinner />
              }
              Create
              @if (composer()) {
                <app-kbd keys="mod+enter" class="max-sm:hidden [&_kbd]:h-4" />
              }
            </button>
          </v3-dialog-foot>
        </form>
      </hlm-dialog-content>
    </hlm-dialog>
  `,
})
export class CreateDialog {
  protected readonly ui = inject(UiStore);
  private readonly store = inject(TramaStore);
  protected readonly canShare = computed(() => this.store.allowed('manageSharedViews'));
  private readonly router = inject(Router);
  private readonly notifier = inject(Notifier);
  private readonly drafts = inject(DraftStore);

  private readonly titleEl = viewChild<ElementRef<HTMLInputElement>>('titleEl');

  private readonly labelCatalog = inject(LabelCatalog);

  protected readonly userIcon = LucideCircleUser;
  protected readonly typeIcon = LucideShapes;
  protected readonly projectIcon = LucideBox;
  protected readonly estimateIcon = LucideGauge;
  protected readonly labelIcon = LucideTag;
  protected readonly threadIcon = LucideMessageSquare;
  protected readonly subtaskIcon = LucideListTree;
  protected readonly fieldClass = V3_FIELD;
  protected readonly textareaClass = V3_TEXTAREA;
  /** Foot hint: the platform's modifier glyphs, "⇧⌘↵ create & add another". */
  protected readonly anotherHint = `${IS_MAC ? '⇧⌘↵' : 'Shift+Ctrl+Enter'} create & add another`;
  protected readonly parentIssue = computed(() => this.store.getIssue(this.parentId()));

  protected readonly open = computed(() => this.ui.modal() === 'create');
  protected readonly kind = signal<CreateKind>('issue');
  protected readonly composer = computed(() => SWITCHER.find((k) => k.kind === this.kind()));
  protected readonly kindLabel = computed(
    () => this.composer()?.label ?? EXTRA[this.kind()]?.label ?? this.kind().replace('-', ' '),
  );
  protected readonly extraIcon = computed(() => EXTRA[this.kind()]?.icon ?? LucideBuilding2);

  // ── form state (shared across kinds; reset on open, carried over on switch) ──
  protected readonly title = signal('');
  protected readonly text = signal('');
  protected readonly text2 = signal('');
  protected readonly tags = signal('');
  protected readonly priority = signal<string>('none');
  // issue
  protected readonly issueStatus = signal<string>('backlog');
  protected readonly issueKind = signal<string>('bug');
  /** Story points as a string ('' = none). */
  protected readonly issueEstimate = signal('');
  /** The workspace turned estimates off: do not offer the chip. */
  protected readonly showEstimate = computed(() => this.store.estimateScale() !== 'none');
  protected readonly issueEstimateChoices = computed<PickOption[]>(() =>
    issueEstimateOptions(undefined, this.store.estimateScale()),
  );
  protected readonly assigneeId = signal('');
  /** Workspace label ids. */
  protected readonly labelIds = signal<string[]>([]);
  protected readonly labelOptions = computed<PickOption[]>(() => {
    const { suggested, rest } = this.labelCatalog.arrange(new Set(this.labelIds()), false, 'issue');
    return [...suggested, ...rest].map((l) => ({
      value: l.id,
      label: l.name,
      kind: 'label' as const,
      color: l.color,
    }));
  });
  /** Optional git repository: a URL or `owner/name`, not a registry id. */
  protected readonly repositoryText = signal('');
  protected readonly projectId = signal('');
  protected readonly projectKey = signal('');
  protected readonly projectKeyMax = PROJECT_KEY_MAX;
  /** Parent issue supplied by the opening context; not persisted in the generic issue draft. */
  protected readonly parentId = signal('');
  /** Optional link to the Delta thread working on the task. */
  protected readonly threadUrl = signal('');
  private projectKeyTouched = false;
  protected readonly viewEntity = signal<string>('issue');
  protected readonly viewLayout = signal<string>('list');
  protected readonly shared = signal(true);
  private viewExtras: {
    filters?: ViewFilter[];
    sort?: { field: string; direction: 'asc' | 'desc' };
    groupBy?: string;
    layout?: ViewLayout;
  } = {};
  protected readonly viewPreset = signal(false);
  protected readonly viewSummary = signal('');

  protected readonly createMore = signal(false);
  protected readonly busy = signal(false);
  private readonly submitted = signal(false);
  private readonly draftAttempt = signal(false);

  // ── options ──
  protected readonly priorityOptions: PickOption[] = PRIORITIES.map((p) => ({
    value: p,
    label: PRIORITY_META[p].label,
    kind: 'priority',
  }));
  protected get issueStatusOptions(): PickOption[] {
    return this.store.settings().statuses.issue.map((s) => ({
      value: s.id,
      label: s.name,
      kind: 'status' as const,
      statusEntity: 'issue' as const,
    }));
  }
  protected readonly issueKindOptions: PickOption[] = ISSUE_KINDS.map((k) => ({
    value: k,
    label: ISSUE_KIND_META[k].label,
    kind: 'kind' as const,
  }));
  protected readonly viewEntityOptions: Option[] = [
    { value: 'issue', label: 'Tasks' },
    { value: 'project', label: 'Projects' },
  ];
  /** Timeline views use project dates. */
  protected readonly viewLayoutOptions = computed<Option[]>(() => {
    const dated = this.viewEntity() === 'project';
    return [
      { value: 'list', label: 'List' },
      { value: 'board', label: 'Board' },
      ...(dated ? [{ value: 'timeline', label: 'Timeline' }] : []),
    ];
  });
  protected readonly effectiveViewLayout = computed(() =>
    this.viewLayoutOptions().some((o) => o.value === this.viewLayout()) ? this.viewLayout() : 'list',
  );

  protected readonly userOptions = computed<PickOption[]>(() =>
    this.store
      .users()
      .map((u) => ({ value: u.id, label: u.name, kind: 'user', search: `${u.name} ${u.email}` })),
  );
  protected readonly projectOptions = computed<PickOption[]>(() =>
    this.store
      .projects()
      .filter((p) => p.status !== 'completed' && p.status !== 'canceled')
      .map((p) => ({ value: p.id, label: p.name, hint: p.key, kind: 'plain' })),
  );
  /** Name of the chosen project, shown next to "New task" in the header. */
  protected readonly projectName = computed(
    () => this.store.getProject(this.projectId())?.name ?? '',
  );
  protected readonly titlePlaceholder = computed(() => 'Task title');
  protected readonly bodyPlaceholder = computed(
    () => 'Add a description, steps to reproduce, links… Markdown supported.',
  );

  /** True while the form shows text restored from an unsent draft. */
  protected readonly restored = signal(false);

  constructor() {
    // Reset the form from the context defaults each time the dialog opens.
    effect(() => {
      if (!this.open()) return;
      const kind = this.ui.createKind();
      const defaults = this.ui.createDefaults();
      untracked(() => {
        this.reset(kind, defaults);
        this.restoreDraft(kind, defaults);
        // The dialog portal focuses its first control (the close button): start in the title.
        this.focusTitle(80);
      });
    });
    // Keep what is typed, so closing the dialog or navigating away does not lose it.
    effect(() => {
      if (!this.open() || !this.composer()) return;
      const draft = {
        title: this.title(),
        text: this.text(),
        text2: this.text2(),
        priority: this.priority(),
        issueKind: this.issueKind(),
        assigneeId: this.assigneeId(),
        projectId: this.projectId(),
        tags: this.tags(),
        threadUrl: this.threadUrl(),
      };
      const kind = this.kind();
      untracked(() => {
        // Nothing to keep until there is a title or a description.
        const hasText = !!(draft.title.trim() || draft.text.trim());
        this.drafts.set(this.draftKey(kind), hasText ? draft : null);
      });
    });
  }

  private draftKey(kind: CreateKind): string {
    return `create:${kind}`;
  }

  /** Bring back the unsent text of this kind, unless the dialog was opened with its own prefill. */
  private restoreDraft(kind: CreateKind, d: Record<string, unknown>): void {
    this.restored.set(false);
    if (!SWITCHER.some((k) => k.kind === kind)) return;
    if (asStr(d['title']) || asStr(d['name']) || asStr(d['body']) || asStr(d['description']) || asStr(d['statement'])) return;
    const draft = this.drafts.get<Record<string, unknown>>(this.draftKey(kind));
    if (!draft || !(asStr(draft['title']).trim() || asStr(draft['text']).trim())) return;
    this.title.set(asStr(draft['title']));
    this.text.set(asStr(draft['text']));
    this.text2.set(asStr(draft['text2']));
    this.priority.set(oneOf(PRIORITIES, draft['priority']) ?? this.priority());
    this.issueKind.set(oneOf(ISSUE_KINDS, draft['issueKind']) ?? this.issueKind());
    if (this.store.userById().has(asStr(draft['assigneeId']))) this.assigneeId.set(asStr(draft['assigneeId']));
    if (this.store.getProject(asStr(draft['projectId']))) this.projectId.set(asStr(draft['projectId']));
    this.tags.set(asStr(draft['tags']));
    this.threadUrl.set(asStr(draft['threadUrl']));
    this.restored.set(true);
  }

  /** Throw the restored text away and start from the context defaults. */
  protected discardDraft(): void {
    this.drafts.set(this.draftKey(this.kind()), null);
    this.reset(this.kind(), this.ui.createDefaults());
    this.restored.set(false);
    this.focusTitle();
  }

  private reset(kind: CreateKind, d: Record<string, unknown>): void {
    this.kind.set(kind);
    this.title.set(asStr(d['title']) || asStr(d['name']));
    this.text.set(asStr(d['body']) || asStr(d['description']) || asStr(d['statement']));
    this.text2.set(asStr(d['rationale']));
    this.tags.set(asTags(d['tags']).join(', '));
    this.priority.set(oneOf(PRIORITIES, d['priority']) ?? 'none');

    this.issueStatus.set(oneOf(ISSUE_STATUSES, d['status']) ?? 'backlog');
    this.issueKind.set(oneOf(ISSUE_KINDS, d['kind']) ?? 'bug');
    this.issueEstimate.set(
      typeof d['estimate'] === 'number' && d['estimate'] >= 0 ? String(d['estimate']) : '',
    );
    this.assigneeId.set(
      this.store.userById().has(asStr(d['assigneeId'])) ? asStr(d['assigneeId']) : '',
    );
    this.projectId.set(this.store.getProject(asStr(d['projectId']))?.id ?? '');
    this.labelIds.set(
      asArr(d['labels'])
        .filter((id) => this.labelCatalog.byId().has(id))
        .slice(0, this.labelCatalog.maxPerRecord),
    );
    this.parentId.set(asStr(d['parentId']));
    this.repositoryText.set(asStr(d['repository']));

    this.projectKeyTouched = false;
    this.projectKey.set(
      kind === 'project'
        ? uniqueProjectKey(
            asStr(d['name']) || asStr(d['title']),
            this.store.projects().map((project) => project.key),
          )
        : '',
    );
    this.threadUrl.set(asStr(d['threadUrl']));
    const entity = oneOf(VIEW_ENTITIES, d['entity']);
    this.viewEntity.set(entity ?? 'issue');
    this.viewLayout.set(oneOf(VIEW_LAYOUTS, d['layout']) ?? 'list');
    this.shared.set(this.canShare() && (typeof d['shared'] === 'boolean' ? d['shared'] : true));
    this.viewExtras = {
      filters: Array.isArray(d['filters']) ? (d['filters'] as ViewFilter[]) : undefined,
      sort:
        d['sort'] &&
        typeof d['sort'] === 'object' &&
        typeof (d['sort'] as { field?: unknown }).field === 'string'
          ? (d['sort'] as { field: string; direction: 'asc' | 'desc' })
          : undefined,
      groupBy: asStr(d['groupBy']) || undefined,
      layout: oneOf(VIEW_LAYOUTS, d['layout']),
    };
    this.viewPreset.set(
      !!entity &&
        (!!this.viewExtras.filters || !!this.viewExtras.sort || !!this.viewExtras.groupBy),
    );
    this.viewSummary.set(this.describeViewExtras());

    this.submitted.set(false);
    this.draftAttempt.set(false);
    this.busy.set(false);
  }

  private describeViewExtras(): string {
    const x = this.viewExtras;
    const bits: string[] = [];
    if (x.filters?.length)
      bits.push(`${x.filters.length} filter${x.filters.length === 1 ? '' : 's'}`);
    if (x.sort) bits.push(`sorted by ${x.sort.field} ${x.sort.direction}`);
    if (x.groupBy) bits.push(`grouped by ${x.groupBy}`);
    if (x.layout) bits.push(`${x.layout} layout`);
    return bits.join(' · ');
  }

  /** What the draft already has, so quick suggestions skip no-ops. */
  protected readonly suggestionCurrent = computed(() => ({
    priority: this.priority(),
    kind: this.issueKind(),
    estimate: this.issueEstimate() === '' ? undefined : Number(this.issueEstimate()),
    assigneeId: this.assigneeId(),
  }));

  protected addQuestion(question: string): void {
    this.text.update((t) => `${t.trimEnd()}${t.trim() ? '\n\n' : ''}${question}\n`);
  }

  protected opt(v: string): string[] {
    return v ? [v] : [];
  }

  protected setLabels(ids: string[]): void {
    this.labelIds.set(ids.slice(0, this.labelCatalog.maxPerRecord));
  }

  protected setOne(sig: { set: (v: string) => void }, values: string[]): void {
    if (values[0]) sig.set(values[0]);
  }

  protected onClosed(): void {
    if (this.ui.modal() === 'create') this.ui.closeModal();
  }

  protected onProjectName(v: string): void {
    this.title.set(v);
    if (!this.projectKeyTouched)
      this.projectKey.set(
        uniqueProjectKey(
          v,
          this.store.projects().map((project) => project.key),
        ),
      );
  }

  protected onProjectKey(v: string): void {
    this.projectKeyTouched = true;
    this.projectKey.set(v.toUpperCase());
  }

  protected err(field: 'title' | 'key' | 'thread'): string | null {
    if (!this.submitted()) return null;
    const k = this.kind();
    switch (field) {
      case 'thread': {
        const raw = this.threadUrl().trim();
        return k !== 'issue' || !raw || isValidThreadUrl(toThreadUrl(raw))
          ? null
          : 'Use a full http(s) link, for example https://delta.dev/…';
      }
      case 'title':
        return this.title().trim() ? null : k === 'issue' ? 'Give it a title.' : 'Required.';
      case 'key':
        if (k === 'project') {
          const key = this.projectKey().trim().toUpperCase();
          if (!isProjectKey(key)) return 'Use 1 to 4 letters or digits, starting with a letter.';
          if (isReservedProjectKey(key))
            return key === UNASSIGNED_ISSUE_KEY_PREFIX
              ? `${UNASSIGNED_ISSUE_KEY_PREFIX} is reserved for tasks without a project.`
              : `${key} is reserved.`;
          if (this.store.projects().some((project) => project.key === key))
            return `The tag ${key} is already used.`;
        }
        return null;
    }
  }

  private valid(): boolean {
    return (['title', 'key', 'thread'] as const).every((f) => !this.err(f));
  }

  private focusTitle(delay = 0): void {
    setTimeout(() => this.titleEl()?.nativeElement.focus(), delay);
  }

  protected applyIssueSuggestion(suggestion: AiIssueDraftSuggestion): void {
    switch (suggestion.field) {
      case 'priority':
        this.priority.set(suggestion.value);
        break;
      case 'kind':
        this.issueKind.set(suggestion.value);
        break;
      case 'estimate':
        this.issueEstimate.set(String(suggestion.value));
        break;
      case 'assigneeId':
        this.assigneeId.set(suggestion.value);
        break;
    }
  }

  protected saveDraft(ev: Event): void {
    this.draftAttempt.set(true);
    void this.submit(ev, true);
  }

  /** `another`: keep the dialog open for the next task (⇧⌘↵), whatever "Create more" says. */
  protected async submit(ev: Event, asDraft = false, another = false): Promise<void> {
    ev.preventDefault();
    ev.stopPropagation();
    if (this.busy()) return;
    if (asDraft) {
      if (!this.title().trim() || this.err('thread')) {
        this.submitted.set(true);
        return;
      }
    } else {
      this.draftAttempt.set(false);
      this.submitted.set(true);
      if (!this.valid()) return;
    }
    this.busy.set(true);
    try {
      const slug = this.store.slug();
      if (!slug) return;
      const title = this.title().trim();
      let done: { label: string; path: string[] } | undefined;
      switch (this.kind()) {
        case 'issue': {
          const status = asDraft ? 'draft' : (this.issueStatus() as IssueStatus);
          const i = await this.store.createIssue({
            kind: this.issueKind() as IssueKind,
            title,
            body: this.text().trim() || undefined,
            priority: this.priority() as Priority,
            status,
            assigneeId: this.assigneeId() || undefined,
            estimate: this.issueEstimate() === '' ? undefined : Number(this.issueEstimate()),
            projectId: this.projectId() || undefined,
            labels: this.labelIds().length ? this.labelIds() : undefined,
            parentId: this.parentId() || undefined,
            threadUrl: this.threadUrl().trim() ? toThreadUrl(this.threadUrl()) : undefined,
          });
          if (i) {
            done ={ label: `${i.key} created`, path: ['tasks', i.key] };
          }
          break;
        }
        case 'project': {
          const p = await this.store.createProject({
            name: title,
            key: this.projectKey().trim().toUpperCase(),
            summary: this.text().trim() || undefined,
            repository: this.repositoryText().trim() || undefined,
          });
          if (p) {
            done = { label: `Project ${p.name} created`, path: ['projects', p.id] };
          }
          break;
        }
        case 'view': {
          const v = await this.store.createView({
            name: title,
            entity: this.viewEntity() as ViewEntity,
            shared: this.shared() && this.canShare(),
            ...this.viewExtras,
            layout: this.effectiveViewLayout() as ViewLayout,
          });
          if (v) done = { label: `View ${v.name} saved`, path: ['views', v.id] };
          break;
        }
        default:
          return;
      }
      if (!done) return; // the store already toasted the failure; keep the form open
      if (asDraft && this.kind() === 'issue') done.label = `${done.path[1]} saved as draft`;
      const commands = ['/', slug, ...done.path];
      // Linear behaviour: stay where you are, offer "Open" in the toast.
      // Views and projects are destinations of their own, so those still navigate.
      const navigate = this.kind() === 'view' || this.kind() === 'project';
      this.notifier.success(done.label, {
        description: navigate ? undefined : title,
        action: navigate
          ? undefined
          : { label: 'Open', run: () => void this.router.navigate(commands) },
      });
      this.drafts.set(this.draftKey(this.kind()), null);
      if ((this.createMore() || another) && this.composer()) {
        this.title.set('');
        this.text.set('');
        this.text2.set('');
        this.threadUrl.set('');
        this.submitted.set(false);
        this.draftAttempt.set(false);
        this.focusTitle();
        return;
      }
      this.ui.closeModal();
      if (navigate) await this.router.navigate(commands);
    } finally {
      this.busy.set(false);
    }
  }
}
