// Workstream AI dialogs: "Draft status update" and "Break down into issues", plus the host that
// the workstream page mounts once. Menus, buttons and the command palette ask for a dialog with
// `AiActions.request('update' | 'breakdown', ws.id)`; the host consumes the request.
// Both dialogs only propose: the person edits, then copies / posts / creates (with Undo).
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, model, signal, untracked } from '@angular/core';
import { LucideCopy, LucideDynamicIcon, LucidePencil, LucideEye } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { HlmTextareaImports } from '@spartan-ng/helm/textarea';
import { Clipboard, TramaStore, formatEstimate, type Workstream } from '../../core';
import { IssueKindLabel } from '../../shared/issue';
import { Markdown } from '../../shared/markdown';
import { PriorityIcon } from '../../shared/priority-icon';
import { AiActions } from './ai-actions.service';
import { AiResult } from './ai-result';
import type { ProposedIssue } from './parse';

// ───────────────────────────── status update ─────────────────────────────

@Component({
  selector: 'app-ai-update-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmDialogImports, HlmButtonImports, HlmTextareaImports, AiResult, Markdown, LucideDynamicIcon],
  template: `
    <hlm-dialog [state]="open() ? 'open' : 'closed'" (closed)="open.set(false)">
      <hlm-dialog-content *hlmDialogPortal="let ctx" class="max-h-[92svh] overflow-y-auto sm:max-w-xl">
        <hlm-dialog-header>
          <h2 hlmDialogTitle>Draft status update</h2>
          <p hlmDialogDescription>
            A short update for {{ ws().key }}, drafted from its issues, milestones, questions and recent activity. Read it and edit it before you share it.
          </p>
        </hlm-dialog-header>

        <app-ai-result bare title="Status update" [state]="job.state()" [error]="job.error()" [autofocus]="false" [closeOnEscape]="false" (cancel)="job.cancel()" (retry)="generate()" (regenerate)="generate()">
          <div class="mb-1.5 flex items-center justify-between">
            <span class="text-muted-foreground text-xs">{{ editing() ? 'Markdown' : 'Preview' }}</span>
            <button hlmBtn variant="ghost" size="xs" type="button" class="text-muted-foreground" (click)="editing.set(!editing())">
              <svg [lucideIcon]="editing() ? eye : pencil" [size]="12"></svg>{{ editing() ? 'Preview' : 'Edit' }}
            </button>
          </div>
          @if (editing()) {
            <textarea hlmTextarea rows="12" class="min-h-48 w-full resize-y font-mono text-xs" aria-label="Status update, markdown" [value]="draft()" (input)="draft.set($any($event.target).value)"></textarea>
          } @else {
            <div class="bg-muted/40 border-border max-h-80 overflow-y-auto rounded-md border px-3 py-2.5">
              <app-markdown [source]="draft()" />
            </div>
          }
        </app-ai-result>

        <hlm-dialog-footer>
          <button hlmBtn variant="outline" hlmDialogClose type="button">Close</button>
          <button hlmBtn variant="secondary" type="button" [disabled]="!draft().trim() || job.state() === 'loading'" (click)="copy()">
            <svg [lucideIcon]="copyIcon" [size]="14"></svg>Copy
          </button>
          <button hlmBtn type="button" [disabled]="!canPost() || busy() || !draft().trim() || job.state() === 'loading'" (click)="post()">Post as comment</button>
        </hlm-dialog-footer>
      </hlm-dialog-content>
    </hlm-dialog>
  `,
})
export class AiUpdateDialog {
  private readonly ai = inject(AiActions);
  private readonly clipboard = inject(Clipboard);
  readonly ws = input.required<Workstream>();
  readonly open = model(false);

  protected readonly copyIcon = LucideCopy;
  protected readonly pencil = LucidePencil;
  protected readonly eye = LucideEye;
  protected readonly draft = signal('');
  protected readonly editing = signal(false);
  protected readonly busy = signal(false);
  protected readonly job = this.ai.job<string>((signal) => this.ai.workstreamUpdate(this.ws(), signal));
  protected readonly canPost = computed(() => this.ai.canEditWorkstream(this.ws()));

  constructor() {
    effect(() => {
      const open = this.open();
      untracked(() => {
        if (open) void this.generate();
        else this.job.reset();
      });
    });
  }

  protected async generate(): Promise<void> {
    this.ai.markNoted();
    this.editing.set(false);
    await this.job.start();
    const text = this.job.result();
    if (this.job.state() === 'done' && text) this.draft.set(text);
  }

  protected copy(): void {
    void this.clipboard.copy(this.draft().trim(), 'Update copied');
  }

  protected async post(): Promise<void> {
    this.busy.set(true);
    const ok = await this.ai.postUpdate(this.ws(), this.draft());
    this.busy.set(false);
    if (ok) this.open.set(false);
  }
}

// ───────────────────────────── break down ─────────────────────────────

interface Row extends ProposedIssue {
  id: number;
  checked: boolean;
}

@Component({
  selector: 'app-ai-breakdown-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmDialogImports, HlmButtonImports, HlmInputImports, AiResult, IssueKindLabel, PriorityIcon],
  template: `
    <hlm-dialog [state]="open() ? 'open' : 'closed'" (closed)="open.set(false)">
      <hlm-dialog-content *hlmDialogPortal="let ctx" class="max-h-[92svh] overflow-y-auto sm:max-w-xl">
        <hlm-dialog-header>
          <h2 hlmDialogTitle>Break down into issues</h2>
          <p hlmDialogDescription>
            Proposed issues for {{ ws().key }}, based on its objective, description and the issues it already has. Untick what you do not need and rename as you like.
          </p>
        </hlm-dialog-header>

        <app-ai-result bare title="Proposed issues" [state]="job.state()" [error]="job.error()" [autofocus]="false" [closeOnEscape]="false" (cancel)="job.cancel()" (retry)="generate()" (regenerate)="generate()">
          @if (rows().length) {
            <ul class="border-border-strong bg-card divide-border divide-y overflow-hidden rounded-lg border">
              @for (r of rows(); track r.id; let n = $index) {
                <li class="flex items-start gap-2 px-2.5 py-2">
                  <input type="checkbox" class="accent-primary mt-2" [checked]="r.checked" [attr.aria-label]="'Include: ' + r.title" (change)="toggle(r.id, $any($event.target).checked)" />
                  <div class="min-w-0 flex-1">
                    <input
                      hlmInput
                      class="h-7 w-full border-transparent bg-transparent px-1.5 text-[13px] font-medium shadow-none focus-visible:border-input"
                      [attr.aria-label]="'Title of proposed issue ' + (n + 1)"
                      maxlength="300"
                      [value]="r.title"
                      (input)="rename(r.id, $any($event.target).value)"
                    />
                    <div class="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-0.5 px-1.5 text-[11px]">
                      <app-issue-kind [kind]="r.kind" [size]="12" showLabel />
                      @if (r.priority !== 'none') {
                        <app-priority-icon [priority]="r.priority" showLabel />
                      }
                      @if (r.estimate !== null && showEstimate()) {
                        <span class="tabular-nums">Estimate {{ estimate(r.estimate) }}</span>
                      }
                    </div>
                    @if (r.description) {
                      <p class="text-muted-foreground px-1.5 pt-0.5 text-xs leading-snug">{{ r.description }}</p>
                    }
                  </div>
                </li>
              }
            </ul>
          } @else {
            <p class="text-muted-foreground text-[13px]">Nothing new to suggest: the existing issues already cover the objective. Add detail to the objective or description and try again.</p>
          }
        </app-ai-result>

        <hlm-dialog-footer>
          <button hlmBtn variant="outline" hlmDialogClose type="button">Cancel</button>
          <button hlmBtn type="button" [disabled]="!canCreate() || busy() || !selected().length || job.state() !== 'done'" (click)="create()">
            Create {{ selected().length }} {{ selected().length === 1 ? 'issue' : 'issues' }}
          </button>
        </hlm-dialog-footer>
      </hlm-dialog-content>
    </hlm-dialog>
  `,
})
export class AiBreakdownDialog {
  private readonly ai = inject(AiActions);
  private readonly store = inject(TramaStore);
  readonly ws = input.required<Workstream>();
  readonly open = model(false);

  protected readonly job = this.ai.job<ProposedIssue[]>((signal) => this.ai.breakDownWorkstream(this.ws(), signal));
  protected readonly rows = signal<Row[]>([]);
  protected readonly busy = signal(false);
  protected readonly showEstimate = computed(() => this.store.estimateScale() !== 'none');
  protected readonly canCreate = computed(() => this.ai.canEditWorkstream(this.ws()));
  protected readonly selected = computed(() => this.rows().filter((r) => r.checked && r.title.trim()));
  private nextId = 1;

  constructor() {
    effect(() => {
      const open = this.open();
      untracked(() => {
        if (open) void this.generate();
        else {
          this.job.reset();
          this.rows.set([]);
        }
      });
    });
  }

  protected estimate(n: number): string {
    return formatEstimate(n, this.store.estimateScale());
  }

  protected async generate(): Promise<void> {
    this.ai.markNoted();
    await this.job.start();
    const list = this.job.result();
    if (this.job.state() === 'done' && list) this.rows.set(list.map((p) => ({ ...p, id: this.nextId++, checked: true })));
  }

  protected toggle(id: number, checked: boolean): void {
    this.rows.update((rows) => rows.map((r) => (r.id === id ? { ...r, checked } : r)));
  }

  protected rename(id: number, title: string): void {
    this.rows.update((rows) => rows.map((r) => (r.id === id ? { ...r, title } : r)));
  }

  protected async create(): Promise<void> {
    this.busy.set(true);
    const proposals = this.selected().map(({ id: _id, checked: _c, ...p }) => ({ ...p, title: p.title.trim() }));
    const n = await this.ai.createIssues(this.ws(), proposals);
    this.busy.set(false);
    if (n > 0) this.open.set(false);
  }
}

// ───────────────────────────── host ─────────────────────────────

/** Mount once on the workstream page; opens the dialogs when something calls `AiActions.request(...)`. */
@Component({
  selector: 'app-ai-ws-actions',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AiUpdateDialog, AiBreakdownDialog],
  host: { class: 'contents' },
  template: `
    @if (ai.available()) {
      <app-ai-update-dialog [ws]="ws()" [(open)]="updateOpen" />
      <app-ai-breakdown-dialog [ws]="ws()" [(open)]="breakdownOpen" />
    }
  `,
})
export class AiWsActions {
  protected readonly ai = inject(AiActions);
  readonly ws = input.required<Workstream>();
  protected readonly updateOpen = signal(false);
  protected readonly breakdownOpen = signal(false);

  constructor() {
    this.ai.touch();
    effect(() => {
      if (!this.ai.pendingRequest()) return;
      untracked(() => {
        if (!this.ai.available()) return;
        const id = this.ws().id;
        if (this.ai.consume('update', id)) this.updateOpen.set(true);
        else if (this.ai.consume('breakdown', id) && this.ai.canEditWorkstream(this.ws())) this.breakdownOpen.set(true);
      });
    });
  }
}
