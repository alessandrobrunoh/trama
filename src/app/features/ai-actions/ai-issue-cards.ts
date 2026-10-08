// AI cards of the issue page sidebar: summary, suggested properties and a clearer description.
// Each card starts its request when it appears (the person just pressed its button), cancels it
// when closed, and only ever proposes: nothing changes until "Apply" / "Accept".
import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideCheck, LucideDynamicIcon, LucideInfo, LucideSparkles } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import { ISSUE_KIND_META, NablaStore, PRIORITY_META, formatEstimate, type Issue, type IssueKind, type Priority } from '../../core';
import { IssueKindLabel } from '../../shared/issue';
import { PriorityIcon } from '../../shared/priority-icon';
import { AiActions, type TriageChange, type TriageResult } from './ai-actions.service';
import { AiButton } from './ai-button';
import { AiResult } from './ai-result';
import type { Summary } from './parse';
import { triageIsEmpty } from './parse';
import type { AiSuggestion } from '../../core/ai/ai-api';

// ───────────────────────────── summary ─────────────────────────────

@Component({
  selector: 'app-ai-summary-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AiResult],
  template: `
    <app-ai-result title="Summary" [state]="job.state()" [error]="job.error()" (cancel)="job.cancel()" (retry)="run()" (regenerate)="run()" (closed)="closed.emit()">
      @if (job.result(); as r) {
        <p class="text-[13px] leading-relaxed">{{ r.tldr }}</p>
        @if (r.unclear.length) {
          <h4 class="text-muted-foreground mt-2.5 mb-1 text-[11px] font-medium">Unclear or missing</h4>
          <ul class="text-muted-foreground flex list-disc flex-col gap-1 pl-4 text-xs leading-snug">
            @for (u of r.unclear; track $index) {
              <li>{{ u }}</li>
            }
          </ul>
        } @else {
          <p class="text-muted-foreground mt-2 text-xs">Nothing obviously missing.</p>
        }
      }
    </app-ai-result>
  `,
})
export class AiSummaryCard implements OnInit, OnDestroy {
  private readonly ai = inject(AiActions);
  readonly issue = input.required<Issue>();
  readonly closed = output<void>();
  protected readonly job = this.ai.job<Summary>((signal) => this.ai.summarizeIssue(this.issue(), signal));

  ngOnInit(): void {
    this.run();
  }
  ngOnDestroy(): void {
    this.job.cancel();
  }
  /** Start (or restart) the request. */
  run(): void {
    this.ai.markNoted();
    void this.job.start();
  }
}

// ───────────────────────────── triage ─────────────────────────────

interface TriageRow {
  id: string;
  label: string;
  change: TriageChange;
  from: string;
  to: string;
  why: string;
  priority?: Priority;
  kind?: IssueKind;
  fromPriority?: Priority;
  fromKind?: IssueKind;
  wsTitle?: string;
}

@Component({
  selector: 'app-ai-triage-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AiResult, HlmButtonImports, HlmTooltip, LucideDynamicIcon, PriorityIcon, IssueKindLabel, RouterLink],
  template: `
    <app-ai-result title="Suggested properties" [state]="job.state()" [error]="job.error()" (cancel)="job.cancel()" (retry)="run()" (regenerate)="run()" (closed)="closed.emit()">
      @if (rows().length) {
        <p class="text-muted-foreground mb-1 text-[11px] leading-snug">A starting point based on this text and similar finished issues, not a verdict.</p>
        <ul class="flex flex-col">
          @for (r of rows(); track r.id) {
            <li class="border-border flex flex-col gap-0.5 border-t py-1.5 first:border-t-0">
              <div class="flex items-center gap-1.5">
                <span class="text-muted-foreground w-[3.75rem] shrink-0 text-[11px]">{{ r.label }}</span>
                <span class="flex min-w-0 flex-1 flex-wrap items-center gap-x-1 gap-y-0.5 text-[13px]">
                  <span class="text-muted-foreground inline-flex items-center gap-1">
                    @if (r.fromPriority) {
                      <app-priority-icon [priority]="r.fromPriority" />
                    } @else if (r.fromKind) {
                      <app-issue-kind [kind]="r.fromKind" />
                    }
                    {{ r.from }}
                  </span>
                  <span class="text-muted-foreground" aria-hidden="true">→</span>
                  <span class="inline-flex min-w-0 items-center gap-1 font-medium">
                    @if (r.priority) {
                      <app-priority-icon [priority]="r.priority" />
                    } @else if (r.kind) {
                      <app-issue-kind [kind]="r.kind" />
                    }
                    <span class="truncate">{{ r.to }}</span>
                  </span>
                </span>
                @if (applied().has(r.id)) {
                  <span class="text-status-shipped inline-flex items-center gap-1 text-[11px]"><svg [lucideIcon]="check" [size]="12"></svg>Applied</span>
                } @else {
                  <button hlmBtn variant="outline" size="xs" type="button" [disabled]="!canEdit() || busy()" [hlmTooltip]="canEdit() ? 'Apply this suggestion' : 'You cannot edit this issue'" (click)="apply([r])">Apply</button>
                }
              </div>
              @if (r.wsTitle) {
                <p class="text-muted-foreground truncate pl-[3.75rem] text-[11px]">{{ r.wsTitle }}</p>
              }
              @if (r.why) {
                <p class="text-muted-foreground pl-[3.75rem] text-[11px] leading-snug">{{ r.why }}</p>
              }
            </li>
          }
        </ul>
        @if (pending().length > 1) {
          <button hlmBtn size="xs" variant="secondary" type="button" class="mt-1.5 w-full" [disabled]="!canEdit() || busy()" (click)="apply(pending())">Apply all ({{ pending().length }})</button>
        }
        @if (similarText(); as s) {
          <p class="text-muted-foreground mt-2 text-[11px] leading-snug">
            Compared with
            @for (x of s; track x.key; let last = $last) {
              <a class="hover:text-foreground underline-offset-2 hover:underline" [routerLink]="['/', slug(), 'issues', x.key]">{{ x.key }}</a>
              <span>{{ x.note }}{{ last ? '' : ', ' }}</span>
            }
          </p>
        }
      } @else if (job.result(); as r) {
        <p class="text-muted-foreground text-[13px] leading-snug">
          {{ empty(r) ? 'No confident suggestions: the text does not say enough yet.' : 'Nothing to change: the properties already match what the text suggests.' }}
        </p>
      }
    </app-ai-result>
  `,
})
export class AiTriageCard implements OnInit, OnDestroy {
  private readonly ai = inject(AiActions);
  private readonly store = inject(NablaStore);
  readonly issue = input.required<Issue>();
  readonly closed = output<void>();
  protected readonly check = LucideCheck;
  protected readonly job = this.ai.job<TriageResult>((signal) => this.ai.triageIssue(this.issue(), signal));
  /** The issue as it was when the answer arrived: rows compare against it, so applied rows stay visible. */
  private readonly baseline = signal<Issue | null>(null);
  protected readonly applied = signal<ReadonlySet<string>>(new Set());
  protected readonly busy = signal(false);
  protected readonly slug = computed(() => this.store.slug() ?? '');
  protected readonly canEdit = computed(() => this.ai.canEditIssue(this.issue()));

  protected readonly rows = computed<TriageRow[]>(() => {
    const res = this.job.result();
    const base = this.baseline();
    if (!res || !base) return [];
    const t = res.triage;
    const out: TriageRow[] = [];
    if (t.priority && t.priority.value !== base.priority) {
      out.push({
        id: 'priority',
        label: 'Priority',
        change: { type: 'priority', value: t.priority.value },
        from: PRIORITY_META[base.priority].label,
        to: PRIORITY_META[t.priority.value].label,
        why: t.priority.why,
        priority: t.priority.value,
        fromPriority: base.priority,
      });
    }
    if (t.estimate && t.estimate.value !== (base.estimate ?? null)) {
      const scale = this.store.estimateScale();
      out.push({
        id: 'estimate',
        label: 'Estimate',
        change: { type: 'estimate', value: t.estimate.value },
        from: base.estimate === undefined || base.estimate === null ? 'None' : formatEstimate(base.estimate, scale),
        to: formatEstimate(t.estimate.value, scale),
        why: t.estimate.why,
      });
    }
    if (t.kind && t.kind.value !== base.kind) {
      out.push({
        id: 'kind',
        label: 'Type',
        change: { type: 'kind', value: t.kind.value },
        from: ISSUE_KIND_META[base.kind].label,
        to: ISSUE_KIND_META[t.kind.value].label,
        why: t.kind.why,
        kind: t.kind.value,
        fromKind: base.kind,
      });
    }
    for (const w of t.workstreams) {
      const ws = this.store.getWorkstream(w.key);
      if (!ws || base.workstreamIds.includes(ws.id)) continue;
      out.push({ id: `ws:${ws.key}`, label: 'Workstream', change: { type: 'workstream', value: ws.key }, from: 'Not linked', to: ws.key, why: w.why, wsTitle: ws.title });
    }
    return out;
  });
  protected readonly pending = computed(() => this.rows().filter((r) => !this.applied().has(r.id)));
  protected readonly similarText = computed(() => {
    const list = this.job.result()?.similar ?? [];
    if (!list.length) return null;
    const scale = this.store.estimateScale();
    return list.map((s) => {
      const bits = [s.estimate !== null && s.estimate !== undefined ? `${formatEstimate(s.estimate, scale)}${/^[\d.]+$/.test(formatEstimate(s.estimate, scale)) ? ' pts' : ''}` : '', s.cycleDays !== null && s.cycleDays !== undefined ? `${s.cycleDays}d` : ''].filter(Boolean);
      return { key: s.key, note: bits.length ? ` (${bits.join(', ')})` : '' };
    });
  });

  constructor() {
    // a new answer starts a clean slate
    effect(() => {
      if (this.job.state() === 'done') untracked(() => this.applied.set(new Set()));
    });
  }

  ngOnInit(): void {
    this.run();
  }
  ngOnDestroy(): void {
    this.job.cancel();
  }
  run(): void {
    this.ai.markNoted();
    this.baseline.set(this.issue());
    void this.job.start();
  }

  protected empty(r: TriageResult): boolean {
    return triageIsEmpty(r.triage);
  }

  protected async apply(rows: readonly TriageRow[]): Promise<void> {
    if (this.busy() || !rows.length) return;
    this.busy.set(true);
    const n = await this.ai.applyTriage(this.issue(), rows.map((r) => r.change));
    if (n > 0) this.applied.update((s) => new Set([...s, ...rows.map((r) => r.id)]));
    this.busy.set(false);
  }
}

// ───────────────────────────── improve description ─────────────────────────────

@Component({
  selector: 'app-ai-improve-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AiResult, HlmButtonImports],
  template: `
    <app-ai-result title="Clearer description" [state]="job.state()" [error]="job.error()" (cancel)="job.cancel()" (retry)="run()" (regenerate)="run()" (closed)="closed.emit()">
      @if (job.result(); as s) {
        @if (!titleChanged() && !bodyChanged()) {
          <p class="text-muted-foreground text-[13px]">No changes suggested: the text already reads clearly.</p>
        } @else {
          @if (titleChanged()) {
            <label class="flex items-start gap-2 py-1">
              <input type="checkbox" class="accent-primary mt-1" [checked]="useTitle()" (change)="useTitle.set($any($event.target).checked)" />
              <span class="min-w-0 flex-1">
                <span class="text-muted-foreground block text-[11px]">Title</span>
                <span class="text-muted-foreground block text-xs line-through decoration-1">{{ issue().title }}</span>
                <span class="block text-[13px] leading-snug font-medium">{{ s.title }}</span>
              </span>
            </label>
          }
          @if (bodyChanged()) {
            <label class="flex items-start gap-2 py-1">
              <input type="checkbox" class="accent-primary mt-1" [checked]="useBody()" (change)="useBody.set($any($event.target).checked)" />
              <span class="min-w-0 flex-1">
                <span class="text-muted-foreground block text-[11px]">Description</span>
                @if (issue().body) {
                  <span class="text-muted-foreground bg-muted/50 mb-1 block max-h-20 overflow-y-auto rounded-md px-2 py-1 text-xs whitespace-pre-wrap">{{ issue().body }}</span>
                } @else {
                  <span class="text-muted-foreground mb-1 block text-xs">(empty)</span>
                }
                <span class="bg-accent/60 block max-h-44 overflow-y-auto rounded-md px-2 py-1.5 text-[13px] leading-snug whitespace-pre-wrap">{{ s.description }}</span>
              </span>
            </label>
          }
        }
        @if (s.questions.length) {
          <h4 class="text-muted-foreground mt-2 mb-1 text-[11px] font-medium">Worth clarifying</h4>
          <ul class="text-muted-foreground flex list-disc flex-col gap-1 pl-4 text-xs leading-snug">
            @for (q of s.questions; track $index) {
              <li>{{ q }}</li>
            }
          </ul>
        }
        <div class="mt-2.5 flex items-center gap-1.5">
          @if (titleChanged() || bodyChanged()) {
            <button hlmBtn size="xs" type="button" [disabled]="busy() || !canEdit() || (!useTitle() && !useBody())" (click)="accept(s)">Accept</button>
          }
          <button hlmBtn size="xs" variant="ghost" type="button" class="text-muted-foreground" (click)="closed.emit()">Discard</button>
        </div>
      }
    </app-ai-result>
  `,
})
export class AiImproveCard implements OnInit, OnDestroy {
  private readonly ai = inject(AiActions);
  readonly issue = input.required<Issue>();
  readonly closed = output<void>();
  protected readonly job = this.ai.job<AiSuggestion>((signal) => this.ai.improveIssue(this.issue(), signal));
  protected readonly useTitle = signal(true);
  protected readonly useBody = signal(true);
  protected readonly busy = signal(false);
  protected readonly canEdit = computed(() => this.ai.canEditIssue(this.issue()));
  protected readonly titleChanged = computed(() => {
    const s = this.job.result();
    return !!s && s.title.trim() !== this.issue().title.trim();
  });
  protected readonly bodyChanged = computed(() => {
    const s = this.job.result();
    return !!s && s.description.trim() !== (this.issue().body ?? '').trim() && s.description.trim().length > 0;
  });

  ngOnInit(): void {
    this.run();
  }
  ngOnDestroy(): void {
    this.job.cancel();
  }
  run(): void {
    this.ai.markNoted();
    this.useTitle.set(true);
    this.useBody.set(true);
    void this.job.start();
  }

  protected async accept(s: AiSuggestion): Promise<void> {
    this.busy.set(true);
    const ok = await this.ai.applyImprovement(this.issue(), {
      title: this.titleChanged() && this.useTitle() ? s.title : undefined,
      description: this.bodyChanged() && this.useBody() ? s.description : undefined,
    });
    this.busy.set(false);
    if (ok) this.closed.emit();
  }
}

// ───────────────────────────── section ─────────────────────────────

type CardKind = 'summarize' | 'triage' | 'improve';

/**
 * "AI" block at the top of the issue sidebar: three quiet buttons and their result cards.
 * Other places (header menu, command palette) ask for an action with `AiActions.request(...)`.
 */
@Component({
  selector: 'app-ai-issue-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AiButton, AiSummaryCard, AiTriageCard, AiImproveCard, HlmTooltip, LucideDynamicIcon, RouterLink],
  host: { class: 'block' },
  template: `
    @if (ai.available()) {
      <section aria-label="AI" class="flex flex-col gap-2">
        <div class="flex items-center gap-1.5 px-0.5">
          <svg [lucideIcon]="sparkles" [size]="13" [strokeWidth]="1.75" class="text-entity-workstream"></svg>
          <h3 class="text-muted-foreground text-xs font-medium">AI</h3>
          <svg
            [lucideIcon]="info"
            [size]="12"
            class="text-muted-foreground/70"
            tabindex="0"
            role="img"
            aria-label="Sends this item's text to your configured AI provider."
            hlmTooltip="Sends this item's text to your configured AI provider."
          ></svg>
        </div>
        <div class="flex flex-wrap gap-1.5">
          <app-ai-button label="Summarize" variant="outline" size="xs" tooltip="TL;DR and what is unclear" (pressed)="show('summarize')" />
          <app-ai-button
            label="Suggest properties"
            variant="outline"
            size="xs"
            tooltip="Priority, estimate, type and workstreams"
            [disabled]="!canEdit()"
            disabledReason="You cannot edit this issue"
            (pressed)="show('triage')"
          />
          <app-ai-button
            label="Improve description"
            variant="outline"
            size="xs"
            tooltip="A clearer title and description"
            [disabled]="!canEdit()"
            disabledReason="You cannot edit this issue"
            (pressed)="show('improve')"
          />
        </div>
        @if (!ai.noted()) {
          <p class="text-muted-foreground px-0.5 text-[11px] leading-snug">Sends this item's text to your configured AI provider.</p>
        }
        @if (open().summarize) {
          <app-ai-summary-card [issue]="issue()" (closed)="hide('summarize')" />
        }
        @if (open().triage) {
          <app-ai-triage-card [issue]="issue()" (closed)="hide('triage')" />
        }
        @if (open().improve) {
          <app-ai-improve-card [issue]="issue()" (closed)="hide('improve')" />
        }
      </section>
    } @else if (ai.checked()) {
      <p class="text-muted-foreground flex items-center gap-1.5 px-0.5 text-xs">
        <svg [lucideIcon]="sparkles" [size]="13" [strokeWidth]="1.75" class="opacity-60"></svg>
        <a class="hover:text-foreground underline-offset-2 hover:underline" [routerLink]="ai.settingsLink()">Enable AI</a>
        <span>to summarize and triage issues.</span>
      </p>
    }
  `,
})
export class AiIssueSection {
  protected readonly ai = inject(AiActions);
  readonly issue = input.required<Issue>();
  protected readonly sparkles = LucideSparkles;
  protected readonly info = LucideInfo;
  protected readonly canEdit = computed(() => this.ai.canEditIssue(this.issue()));
  protected readonly open = signal<Record<CardKind, boolean>>({ summarize: false, triage: false, improve: false });

  private readonly summary = viewChild(AiSummaryCard);
  private readonly triage = viewChild(AiTriageCard);
  private readonly improve = viewChild(AiImproveCard);

  constructor() {
    this.ai.touch();
    // another issue: drop the cards of the previous one
    let last: string | undefined;
    effect(() => {
      const id = this.issue().id;
      if (last !== undefined && last !== id) untracked(() => this.open.set({ summarize: false, triage: false, improve: false }));
      last = id;
    });
    // requests from the header menu and the command palette
    effect(() => {
      if (!this.ai.pendingRequest()) return;
      untracked(() => {
        const id = this.issue().id;
        if (this.ai.consume('summarize', id)) this.show('summarize');
        else if (this.ai.consume('triage', id) && this.canEdit()) this.show('triage');
        else if (this.ai.consume('improve', id) && this.canEdit()) this.show('improve');
      });
    });
  }

  /** Open the card (it starts by itself); when already open, ask again. */
  protected show(kind: CardKind): void {
    if (this.open()[kind]) {
      (kind === 'summarize' ? this.summary() : kind === 'triage' ? this.triage() : this.improve())?.run();
      return;
    }
    this.open.update((o) => ({ ...o, [kind]: true }));
  }

  protected hide(kind: CardKind): void {
    this.open.update((o) => ({ ...o, [kind]: false }));
  }
}
