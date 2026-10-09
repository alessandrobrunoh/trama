import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  model,
  output,
  signal,
} from '@angular/core';
import {
  LucideCheck,
  LucideChevronDown,
  LucideDynamicIcon,
  LucidePlus,
  LucideRefreshCw,
  LucideSparkles,
  LucideX,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';
import { HlmSpinner } from '@spartan-ng/helm/spinner';
import {
  TramaStore,
  type AttentionSeverity,
  type Project,
  type ProjectAiIssueSuggestion,
  type ProjectAiRisk,
  type ProjectAiRisks,
  type ProjectAiSummary,
  type ProjectHealth,
} from '../../core';
import { AssistantStore } from '../../core/ai/assistant.store';
import { EntityChip } from '../../shared/entity-chip';
import { Markdown } from '../../shared/markdown';
import { ProjectHealthBadge } from './project-health';

const NOT_CONFIGURED =
  'AI is not configured for this workspace. Ask an administrator to connect a model in Settings › AI & assistant.';
const FAILED = 'No suggestion this time. Check the notification for details, then try again.';

/**
 * Shared AI state of the project assistants: AI configuration (so a failure can say "not configured"
 * instead of a generic error) and a per-project guard so a late answer never lands on another project.
 */
function injectAiAvailability() {
  const assistant = inject(AssistantStore);
  const notConfigured = computed(() => assistant.status() !== null && !assistant.ready());
  return { notConfigured, failure: () => (notConfigured() ? NOT_CONFIGURED : FAILED) };
}

/** "Draft with AI": asks for a status update draft (health + markdown) and emits it. Nothing is posted. */
@Component({
  selector: 'app-project-ai-draft-button',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButtonImports, HlmSpinner, LucideDynamicIcon],
  host: { class: 'inline-flex flex-col items-start gap-1' },
  template: `
    <button
      hlmBtn
      type="button"
      variant="outline"
      size="sm"
      class="gap-1.5"
      [disabled]="busy()"
      [attr.aria-busy]="busy()"
      (click)="run()"
    >
      @if (busy()) {
        <hlm-spinner class="size-3.5" aria-label="Drafting" />
        <span>Drafting…</span>
      } @else {
        <svg [lucideIcon]="sparkles" [size]="14"></svg>
        <span>Draft with AI</span>
      }
    </button>
    @if (error(); as e) {
      <p class="text-destructive max-w-xs text-xs" role="alert">{{ e }}</p>
    }
  `,
})
export class ProjectAiDraftButton {
  private readonly store = inject(TramaStore);
  private readonly ai = injectAiAvailability();

  readonly project = input.required<Project>();
  readonly draft = output<{ health: ProjectHealth; body: string }>();

  protected readonly sparkles = LucideSparkles;
  protected readonly busy = signal(false);
  protected readonly error = signal('');

  protected async run(): Promise<void> {
    if (this.busy()) return;
    const id = this.project().id;
    this.busy.set(true);
    this.error.set('');
    try {
      const result = await this.store.aiProject(id, 'update_draft');
      if (this.project().id !== id) return;
      if (!result) this.error.set(this.ai.failure());
      else this.draft.emit({ health: result.health, body: result.body });
    } finally {
      this.busy.set(false);
    }
  }
}

/** "Summarize with AI": previews a proposed summary + description; nothing changes until "Apply". */
@Component({
  selector: 'app-project-ai-summary-button',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButtonImports, HlmDialogImports, HlmSpinner, LucideDynamicIcon, Markdown],
  host: { class: 'inline-flex flex-col items-start gap-1' },
  template: `
    <button
      hlmBtn
      type="button"
      variant="outline"
      size="sm"
      class="gap-1.5"
      [disabled]="busy()"
      [attr.aria-busy]="busy()"
      (click)="run()"
    >
      @if (busy()) {
        <hlm-spinner class="size-3.5" aria-label="Summarizing" />
        <span>Summarizing…</span>
      } @else {
        <svg [lucideIcon]="sparkles" [size]="14"></svg>
        <span>Summarize with AI</span>
      }
    </button>
    @if (error(); as e) {
      <p class="text-destructive max-w-xs text-xs" role="alert">{{ e }}</p>
    }

    <hlm-dialog [state]="proposal() ? 'open' : 'closed'" (closed)="discard()">
      <hlm-dialog-content
        *hlmDialogPortal="let ctx"
        class="max-h-[90svh] overflow-y-auto sm:max-w-2xl"
      >
        @if (proposal(); as p) {
          <hlm-dialog-header>
            <h2 hlmDialogTitle>Proposed summary</h2>
            <p hlmDialogDescription>
              Review the AI suggestion. The project only changes when you apply it.
            </p>
          </hlm-dialog-header>

          <div class="flex flex-col gap-4 text-[13px]">
            <section class="grid gap-1.5" aria-labelledby="ai-sum-summary">
              <h3 id="ai-sum-summary" class="text-muted-foreground text-xs font-medium">Summary</h3>
              <p class="rounded-md border px-3 py-2">{{ p.summary }}</p>
              @if (project().summary) {
                <p class="text-meta line-clamp-2">Current: {{ project().summary }}</p>
              }
            </section>
            <section class="grid gap-1.5" aria-labelledby="ai-sum-description">
              <h3 id="ai-sum-description" class="text-muted-foreground text-xs font-medium">
                Description
              </h3>
              <div class="rounded-md border px-3 py-2">
                <app-markdown [source]="p.description" />
              </div>
              @if (project().description) {
                <p class="text-meta">
                  Replaces the current description ({{ project().description!.length }} characters).
                </p>
              }
            </section>
          </div>

          <hlm-dialog-footer>
            <button
              hlmBtn
              type="button"
              variant="outline"
              size="sm"
              [disabled]="applying()"
              (click)="discard()"
            >
              Discard
            </button>
            <button hlmBtn type="button" size="sm" [disabled]="applying()" (click)="apply()">
              {{ applying() ? 'Applying…' : 'Apply' }}
            </button>
          </hlm-dialog-footer>
        }
      </hlm-dialog-content>
    </hlm-dialog>
  `,
})
export class ProjectAiSummaryButton {
  private readonly store = inject(TramaStore);
  private readonly ai = injectAiAvailability();

  readonly project = input.required<Project>();

  protected readonly sparkles = LucideSparkles;
  protected readonly busy = signal(false);
  protected readonly applying = signal(false);
  protected readonly error = signal('');
  protected readonly proposal = signal<ProjectAiSummary | null>(null);

  protected async run(): Promise<void> {
    if (this.busy()) return;
    const id = this.project().id;
    this.busy.set(true);
    this.error.set('');
    try {
      const result = await this.store.aiProject(id, 'summary');
      if (this.project().id !== id) return;
      if (result) this.proposal.set(result);
      else this.error.set(this.ai.failure());
    } finally {
      this.busy.set(false);
    }
  }

  protected discard(): void {
    this.proposal.set(null);
  }

  protected async apply(): Promise<void> {
    const p = this.proposal();
    if (!p || this.applying()) return;
    this.applying.set(true);
    try {
      const ok = await this.store.updateProject(this.project().id, {
        summary: p.summary,
        description: p.description,
      });
      if (ok) this.proposal.set(null);
    } finally {
      this.applying.set(false);
    }
  }
}

/** Collapsible card used by the two assistants below: header toggle, optional action, error + body slots. */
@Component({
  selector: 'app-project-ai-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmSpinner, LucideDynamicIcon],
  host: { class: 'bg-card block rounded-lg border' },
  template: `
    <div class="flex items-center gap-1 pe-2">
      <button
        type="button"
        class="hover:bg-hover focus-visible:ring-ring flex h-10 min-w-0 flex-1 items-center gap-2 rounded-lg px-3 text-start text-sm font-medium outline-none focus-visible:ring-2"
        [attr.aria-expanded]="open()"
        [attr.aria-controls]="bodyId"
        (click)="open.set(!open())"
      >
        <svg
          [lucideIcon]="chevron"
          [size]="14"
          class="text-muted-foreground shrink-0 transition-transform"
          [class.-rotate-90]="!open()"
        ></svg>
        <svg [lucideIcon]="sparkles" [size]="14" class="text-muted-foreground shrink-0"></svg>
        <span class="truncate">{{ title() }}</span>
        @if (busy()) {
          <hlm-spinner class="size-3.5 shrink-0" [attr.aria-label]="busyLabel()" />
        }
      </button>
      <ng-content select="[cardActions]" />
    </div>
    @if (open()) {
      <div [id]="bodyId" class="border-t px-3 py-3" [attr.aria-busy]="busy()">
        <ng-content />
      </div>
    }
  `,
})
export class ProjectAiCard {
  private static next = 0;
  protected readonly bodyId = `project-ai-card-${ProjectAiCard.next++}`;
  readonly title = input.required<string>();
  readonly busy = input(false);
  readonly busyLabel = input('Loading');
  readonly open = model(false);
  protected readonly chevron = LucideChevronDown;
  protected readonly sparkles = LucideSparkles;
}

/** "Suggested issues": existing issues the AI thinks belong to this project; adding one is explicit. */
@Component({
  selector: 'app-project-issue-suggestions',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ProjectAiCard, EntityChip, HlmButtonImports, LucideDynamicIcon],
  host: { class: 'block' },
  template: `
    <app-project-ai-card
      title="Suggested issues"
      busyLabel="Finding issues"
      [busy]="busy()"
      [open]="open()"
      (openChange)="toggle($event)"
    >
      @if (loaded()) {
        <button
          cardActions
          hlmBtn
          type="button"
          variant="ghost"
          size="sm"
          class="text-muted-foreground gap-1.5"
          [disabled]="busy()"
          (click)="load()"
        >
          <svg [lucideIcon]="refresh" [size]="13"></svg>Refresh
        </button>
      }
      @if (error(); as e) {
        <div class="flex flex-wrap items-center gap-2">
          <p class="text-destructive text-xs" role="alert">{{ e }}</p>
          <button hlmBtn type="button" variant="outline" size="sm" (click)="load()">
            Try again
          </button>
        </div>
      } @else if (busy() && !loaded()) {
        <p class="text-meta">Looking through open issues that are not in this project…</p>
      } @else if (loaded()) {
        @if (rows().length) {
          <ul class="flex flex-col divide-y" aria-label="Suggested issues">
            @for (r of rows(); track r.issueId) {
              <li class="flex flex-wrap items-start gap-x-3 gap-y-1.5 py-2 first:pt-0 last:pb-0">
                <div class="flex min-w-0 flex-1 basis-60 flex-col gap-1">
                  <app-entity-chip type="issue" [ref]="r.issueId" />
                  <p class="text-meta text-xs">{{ r.reason }}</p>
                </div>
                <div class="flex shrink-0 items-center gap-1.5">
                  @if (added().has(r.issueId)) {
                    <span
                      class="text-status-shipped inline-flex h-7 items-center gap-1 px-2 text-xs"
                      ><svg [lucideIcon]="check" [size]="13"></svg>Added</span
                    >
                  } @else {
                    <button
                      hlmBtn
                      type="button"
                      variant="outline"
                      size="sm"
                      class="gap-1"
                      [disabled]="adding() === r.issueId"
                      (click)="add(r)"
                    >
                      <svg [lucideIcon]="plus" [size]="13"></svg>Add to project
                    </button>
                    <button
                      hlmBtn
                      type="button"
                      variant="ghost"
                      size="sm"
                      class="text-muted-foreground gap-1"
                      (click)="dismiss(r.issueId)"
                    >
                      <svg [lucideIcon]="x" [size]="13"></svg>Dismiss
                    </button>
                  }
                </div>
              </li>
            }
          </ul>
        } @else {
          <p class="text-meta">
            No more suggestions. Issues in this project's workstreams are already counted.
          </p>
        }
      } @else {
        <p class="text-meta">
          Open this card to ask the assistant which existing issues belong here.
        </p>
      }
    </app-project-ai-card>
  `,
})
export class ProjectIssueSuggestions {
  private readonly store = inject(TramaStore);
  private readonly ai = injectAiAvailability();

  readonly project = input.required<Project>();

  protected readonly refresh = LucideRefreshCw;
  protected readonly check = LucideCheck;
  protected readonly plus = LucidePlus;
  protected readonly x = LucideX;
  protected readonly open = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly adding = signal<string | null>(null);
  /** Suggestions together with the project they were computed for. */
  private readonly result = signal<{
    projectId: string;
    items: readonly ProjectAiIssueSuggestion[];
  } | null>(null);
  private readonly dismissed = signal<ReadonlySet<string>>(new Set());
  protected readonly added = signal<ReadonlySet<string>>(new Set());

  protected readonly loaded = computed(() => this.result()?.projectId === this.project().id);
  protected readonly rows = computed(() => {
    const r = this.result();
    if (!r || r.projectId !== this.project().id) return [];
    return r.items.filter(
      (s) => !this.dismissed().has(s.issueId) && this.store.getIssue(s.issueId),
    );
  });

  protected toggle(open: boolean): void {
    this.open.set(open);
    if (open && !this.loaded() && !this.busy()) void this.load();
  }

  protected async load(): Promise<void> {
    if (this.busy()) return;
    const id = this.project().id;
    this.busy.set(true);
    this.error.set('');
    try {
      const result = await this.store.aiProject(id, 'issues');
      if (this.project().id !== id) return;
      if (result) {
        this.result.set({ projectId: id, items: result.suggestions });
        this.dismissed.set(new Set());
        this.added.set(new Set());
      } else {
        this.error.set(this.ai.failure());
      }
    } finally {
      this.busy.set(false);
    }
  }

  protected dismiss(issueId: string): void {
    this.dismissed.update((s) => new Set(s).add(issueId));
  }

  protected async add(s: ProjectAiIssueSuggestion): Promise<void> {
    if (this.adding()) return;
    this.adding.set(s.issueId);
    try {
      const ok = await this.store.updateIssue(s.issueId, { projectId: this.project().id });
      if (ok) this.added.update((set) => new Set(set).add(s.issueId));
    } finally {
      this.adding.set(null);
    }
  }
}

const SEVERITY_ORDER: Record<AttentionSeverity, number> = { high: 0, medium: 1, low: 2 };
const SEVERITY_STYLE: Record<AttentionSeverity, { label: string; classes: string }> = {
  high: {
    label: 'High',
    classes: 'text-status-blocked bg-status-blocked/10 border-status-blocked/25',
  },
  medium: {
    label: 'Medium',
    classes: 'text-status-needs-input bg-status-needs-input/10 border-status-needs-input/25',
  },
  low: { label: 'Low', classes: 'text-muted-foreground bg-muted border-border' },
};

/** "Risks & health": proposed health and the risks found for the project (read-only; health is set by posting an update). */
@Component({
  selector: 'app-project-risks-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ProjectAiCard, ProjectHealthBadge, EntityChip, HlmButtonImports, LucideDynamicIcon],
  host: { class: 'block' },
  template: `
    <app-project-ai-card
      title="Risks & health"
      busyLabel="Checking risks"
      [busy]="busy()"
      [open]="open()"
      (openChange)="toggle($event)"
    >
      @if (loaded()) {
        <button
          cardActions
          hlmBtn
          type="button"
          variant="ghost"
          size="sm"
          class="text-muted-foreground gap-1.5"
          [disabled]="busy()"
          (click)="load()"
        >
          <svg [lucideIcon]="refresh" [size]="13"></svg>Refresh
        </button>
      }
      @if (error(); as e) {
        <div class="flex flex-wrap items-center gap-2">
          <p class="text-destructive text-xs" role="alert">{{ e }}</p>
          <button hlmBtn type="button" variant="outline" size="sm" (click)="load()">
            Try again
          </button>
        </div>
      } @else if (busy() && !data()) {
        <p class="text-meta">Checking dates, blockers and open questions…</p>
      } @else if (data(); as d) {
        <div class="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1">
          <span class="text-muted-foreground text-xs">Proposed health</span>
          <app-project-health [health]="d.health" [compact]="true" />
          @if (d.health !== project().health) {
            <span class="text-meta text-xs">
              {{
                project().health
                  ? 'Current is different. Post an update to change it.'
                  : 'No update posted yet.'
              }}
            </span>
          }
        </div>
        @if (risks().length) {
          <ul class="flex flex-col divide-y" aria-label="Risks">
            @for (r of risks(); track $index) {
              <li class="flex flex-col gap-1 py-2 first:pt-0 last:pb-0">
                <div class="flex items-center gap-2">
                  <span
                    class="inline-flex h-5 shrink-0 items-center rounded-full border px-2 text-[11px] font-medium"
                    [class]="severity[r.severity].classes"
                  >
                    {{ severity[r.severity].label }}<span class="sr-only"> severity</span>
                  </span>
                  <span class="min-w-0 text-sm font-medium">{{ r.title }}</span>
                </div>
                <p class="text-meta text-xs">{{ r.detail }}</p>
                @if (r.issueId || r.workstreamId) {
                  <div class="flex flex-wrap items-center gap-1.5">
                    @if (r.workstreamId) {
                      <app-entity-chip type="workstream" [ref]="r.workstreamId" />
                    }
                    @if (r.issueId) {
                      <app-entity-chip type="issue" [ref]="r.issueId" />
                    }
                  </div>
                }
              </li>
            }
          </ul>
        } @else {
          <p class="text-meta">No risks found. Nothing is blocked, late or waiting on someone.</p>
        }
      } @else {
        <p class="text-meta">Open this card to check the project for risks.</p>
      }
    </app-project-ai-card>
  `,
})
export class ProjectRisksCard {
  private readonly store = inject(TramaStore);
  private readonly ai = injectAiAvailability();

  readonly project = input.required<Project>();

  protected readonly refresh = LucideRefreshCw;
  protected readonly severity = SEVERITY_STYLE;
  protected readonly open = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  private readonly result = signal<{ projectId: string; value: ProjectAiRisks } | null>(null);

  protected readonly data = computed(() => {
    const r = this.result();
    return r && r.projectId === this.project().id ? r.value : null;
  });
  protected readonly loaded = computed(() => this.data() !== null);
  protected readonly risks = computed<readonly ProjectAiRisk[]>(() =>
    [...(this.data()?.risks ?? [])].sort(
      (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
    ),
  );

  protected toggle(open: boolean): void {
    this.open.set(open);
    if (open && !this.loaded() && !this.busy()) void this.load();
  }

  protected async load(): Promise<void> {
    if (this.busy()) return;
    const id = this.project().id;
    this.busy.set(true);
    this.error.set('');
    try {
      const result = await this.store.aiProject(id, 'risks');
      if (this.project().id !== id) return;
      if (result) this.result.set({ projectId: id, value: result });
      else this.error.set(this.ai.failure());
    } finally {
      this.busy.set(false);
    }
  }
}
