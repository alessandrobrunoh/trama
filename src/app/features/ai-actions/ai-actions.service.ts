// AI actions: the assistant woven into the product (summarise, triage, improve, status update,
// break down, standup digest). It composes prompts for the existing /ai/chat and /ai/suggestions
// endpoints and never changes anything by itself: every result is a proposal a person applies.
//
// Server rules we respect: browser session only, ONE active request per user, at most 10 requests
// per minute (HTTP 429 otherwise). So requests are serialised here (single flight), counted
// locally to stop before the server does, and never retried automatically. Every call starts from
// a click or a keystroke; nothing runs in the background (only the cheap status GET is cached).
import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { ApiError } from '../../core/api/api-error';
import { AiApi, type AiSuggestion, type ChatContext } from '../../core/ai/ai-api';
import {
  Notifier,
  NablaStore,
  type CreateIssueInput,
  type ID,
  type Issue,
  type IssueKind,
  type Priority,
  type Workstream,
} from '../../core';
import { MilestoneInfo } from '../milestones/milestone-stats';
import { KIND_LIST, PRIORITY_LIST, breakdownInputs, digestData, issuePromptData, triageInputs, workstreamPromptData } from './ai-data';
import { AiFormatError, parseBreakdown, titleKey, parseMarkdown, parseSummary, parseTriage, type ProposedIssue, type Summary, type Triage } from './parse';
import { breakdownPrompt, digestPrompt, summarizePrompt, triagePrompt, updatePrompt, type PromptCandidate, type PromptSimilar } from './prompts';

/** Requests the server allows per user and minute. */
export const RATE_LIMIT = 10;
const WINDOW_MS = 60_000;
const NOTED_KEY = 'nabla.ai.noted';

function readNoted(): boolean {
  try {
    return localStorage.getItem(NOTED_KEY) === '1';
  } catch {
    return false;
  }
}

export type AiFailureKind = 'busy' | 'rate' | 'setup' | 'format' | 'timeout' | 'network' | 'other';

/** An error whose message is fine to show to people as is. */
export class AiFailure extends Error {
  override readonly name = 'AiFailure';
  constructor(
    message: string,
    readonly kind: AiFailureKind,
  ) {
    super(message);
  }
  /** Worth offering a Retry button (the person decides, nothing retries on its own). */
  get retryable(): boolean {
    return this.kind !== 'setup';
  }
}

export const SETUP_MESSAGE = "AI isn't set up — enable it in Settings → AI & assistant";
const BUSY_MESSAGE = 'AI is busy — try again in a moment';
const RATE_MESSAGE = `AI is limited to ${RATE_LIMIT} requests a minute — try again in a moment`;

export type AiRequestKind = 'summarize' | 'triage' | 'improve' | 'update' | 'breakdown';
interface AiRequest {
  kind: AiRequestKind;
  target: ID;
  n: number;
  at: number;
}

export type TriageChange =
  | { type: 'priority'; value: Priority }
  | { type: 'estimate'; value: number }
  | { type: 'kind'; value: IssueKind }
  | { type: 'workstream'; value: string };

export interface TriageResult {
  triage: Triage;
  similar: PromptSimilar[];
  candidates: PromptCandidate[];
}

export type JobState = 'idle' | 'loading' | 'done' | 'error';

/** The life cycle of one AI request as signals; a component owns one per result panel. */
export class AiJob<T> {
  readonly state = signal<JobState>('idle');
  readonly result = signal<T | null>(null);
  readonly error = signal<AiFailure | null>(null);
  private seq = 0;
  private controller: AbortController | null = null;

  constructor(
    private readonly ai: AiActions,
    private readonly fn: (signal: AbortSignal) => Promise<T>,
  ) {}

  async start(): Promise<void> {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const run = ++this.seq;
    this.state.set('loading');
    this.error.set(null);
    try {
      const value = await this.ai.run(this.fn, controller.signal);
      if (run !== this.seq) return;
      this.result.set(value);
      this.state.set('done');
    } catch (e) {
      if (run !== this.seq) return;
      if (controller.signal.aborted) {
        this.state.set(this.result() ? 'done' : 'idle');
        return;
      }
      this.error.set(e instanceof AiFailure ? e : this.ai.explain(e));
      this.state.set('error');
    } finally {
      if (this.controller === controller) this.controller = null;
    }
  }

  /** Forget the result and go back to idle (cancels a running request). */
  reset(): void {
    this.cancel();
    this.result.set(null);
    this.error.set(null);
    this.state.set('idle');
  }

  /** Stop waiting. The result already on screen (if any) stays. */
  cancel(): void {
    this.seq++;
    this.controller?.abort();
    this.controller = null;
    if (this.state() === 'loading') this.state.set(this.result() ? 'done' : 'idle');
  }
}

@Injectable({ providedIn: 'root' })
export class AiActions {
  private readonly api = inject(AiApi);
  private readonly store = inject(NablaStore);
  private readonly info = inject(MilestoneInfo);
  private readonly notify = inject(Notifier);

  // ───────────────────────────── availability ─────────────────────────────

  private readonly _available = signal(false);
  private readonly _checked = signal(false);
  private checkedAt = 0;
  private knownSlug: string | null = null;
  private checking: Promise<void> | null = null;
  private checkingSlug: string | null = null;
  /** True when a provider is configured or a SuperGrok account is connected. Cached per workspace. */
  readonly available = this._available.asReadonly();
  /** The status answered at least once for this workspace (so "unavailable" is a fact, not a guess). */
  readonly checked = this._checked.asReadonly();
  readonly settingsLink = computed(() => ['/', this.store.slug() ?? '', 'settings', 'ai']);

  /** One request at a time. */
  readonly busy = signal(false);
  private pending = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly controllers = new Set<AbortController>();
  private readonly starts: number[] = [];

  // ───────────────────────────── cross-component requests ─────────────────────────────

  /** A pending "open this AI action" request (menu, palette) that the owning page consumes. */
  readonly pendingRequest = signal<AiRequest | null>(null);
  private seq = 0;

  constructor() {
    effect(() => {
      const slug = this.store.slug();
      const ready = this.store.ready();
      untracked(() => {
        if (slug !== this.knownSlug) {
          // another workspace: forget the answer and stop whatever was running
          this.knownSlug = slug;
          this.cancel();
          this._available.set(false);
          this._checked.set(false);
          this.checkedAt = 0;
        }
        if (slug && ready && !this._checked()) void this.refresh();
      });
    });
  }

  /** Ask the server whether AI is configured (once per workspace; `touch()` re-checks after a pause). */
  refresh(): Promise<void> {
    const slug = this.store.slug();
    if (!slug) return Promise.resolve();
    if (this.checking && this.checkingSlug === slug) return this.checking;
    this.checkedAt = Date.now();
    this.checkingSlug = slug;
    this.checking = this.api
      .status(slug)
      .then((s) => {
        if (this.store.slug() !== slug) return;
        this._available.set(s.suggestions.configured || s.supergrok.connected);
        this._checked.set(true);
      })
      .catch(() => {
        if (this.store.slug() === slug) {
          this._available.set(false);
          this._checked.set(true);
        }
      })
      .finally(() => {
        if (this.checkingSlug === slug) this.checking = null;
      });
    return this.checking;
  }

  /** Called when AI UI appears: if AI looked unavailable a while ago, ask again (people enable it in Settings). */
  touch(): void {
    if (!this._available() && this.store.ready() && Date.now() - this.checkedAt > 20_000) void this.refresh();
  }

  request(kind: AiRequestKind, target: ID): void {
    this.pendingRequest.set({ kind, target, n: ++this.seq, at: Date.now() });
  }

  /** True (and clears the request) when the pending request is `kind` for `target` and still fresh. */
  consume(kind: AiRequestKind, target: ID): boolean {
    const r = this.pendingRequest();
    if (!r || r.kind !== kind || r.target !== target || Date.now() - r.at > 4000) return false;
    queueMicrotask(() => {
      if (this.pendingRequest()?.n === r.n) this.pendingRequest.set(null);
    });
    return true;
  }

  /** Has the person already used an AI action (so the one-line privacy note can retire)? */
  readonly noted = signal(readNoted());
  markNoted(): void {
    if (this.noted()) return;
    this.noted.set(true);
    try {
      localStorage.setItem(NOTED_KEY, '1');
    } catch {
      // private mode: the note simply shows again next time
    }
  }

  job<T>(fn: (signal: AbortSignal) => Promise<T>): AiJob<T> {
    return new AiJob(this, fn);
  }

  // ───────────────────────────── single-flight queue ─────────────────────────────

  /**
   * Run `task` after every earlier task has finished. Rejects with an `AiFailure` (friendly text)
   * or an AbortError when cancelled. Never retries.
   */
  run<T>(task: (signal: AbortSignal) => Promise<T>, outer?: AbortSignal): Promise<T> {
    const controller = new AbortController();
    outer?.addEventListener('abort', () => controller.abort(), { once: true });
    if (outer?.aborted) controller.abort();
    this.controllers.add(controller);
    this.pending++;
    this.busy.set(true);

    const exec = async (): Promise<T> => {
      try {
        controller.signal.throwIfAborted();
        if (this._checked() && !this._available()) throw new AiFailure(SETUP_MESSAGE, 'setup');
        const wait = this.waitSeconds();
        if (wait > 0) throw new AiFailure(`AI is limited to ${RATE_LIMIT} requests a minute — try again in ${wait}s`, 'rate');
        this.starts.push(Date.now());
        return await task(controller.signal);
      } catch (e) {
        throw controller.signal.aborted ? new DOMException('Cancelled', 'AbortError') : this.explain(e);
      } finally {
        this.controllers.delete(controller);
        if (--this.pending <= 0) {
          this.pending = 0;
          this.busy.set(false);
        }
      }
    };
    const p = this.tail.then(exec, exec);
    this.tail = p.catch(() => undefined);
    return p;
  }

  /** Abort the running request and everything queued behind it. */
  cancel(): void {
    for (const c of this.controllers) c.abort();
  }

  /** Seconds until the local counter has room again (0 = go). */
  private waitSeconds(): number {
    const now = Date.now();
    while (this.starts.length && now - this.starts[0] >= WINDOW_MS) this.starts.shift();
    if (this.starts.length < RATE_LIMIT) return 0;
    return Math.max(1, Math.ceil((WINDOW_MS - (now - this.starts[0])) / 1000));
  }

  /** Friendly message for anything a request can throw. */
  explain(e: unknown): AiFailure {
    if (e instanceof AiFailure) return e;
    if (e instanceof AiFormatError) return new AiFailure(e.message, 'format');
    if (e instanceof ApiError) {
      const msg = e.message ?? '';
      if (e.status === 429) return new AiFailure(/already running/i.test(msg) ? BUSY_MESSAGE : RATE_MESSAGE, /already running/i.test(msg) ? 'busy' : 'rate');
      if (e.status === 0) return new AiFailure('Cannot reach the server — check your connection and try again', 'network');
      if (e.status === 504 || /timed out/i.test(msg)) return new AiFailure('The AI took too long to answer — try again', 'timeout');
      if (e.status === 403 && /browser session/i.test(msg)) return new AiFailure('AI is only available in the browser, not with API tokens', 'other');
      if (e.status === 502 && /configuration|invalid response|empty response/i.test(msg)) return new AiFailure(SETUP_MESSAGE, 'setup');
      if (e.status === 502 && /unexpected format|valid suggestion/i.test(msg)) return new AiFailure('AI returned an unexpected format — try again', 'format');
      if (e.status >= 400 && e.status < 500 && msg) return new AiFailure(msg, 'other');
      if (msg && msg.length < 200) return new AiFailure(msg, 'other');
    }
    return new AiFailure('Something went wrong asking the AI — try again', 'other');
  }

  private get locale(): string | undefined {
    return typeof navigator === 'undefined' ? undefined : navigator.language;
  }

  private chat(prompt: string, context: ChatContext | undefined, signal: AbortSignal): Promise<string> {
    const slug = this.store.slug();
    if (!slug) throw new AiFailure('Open a workspace first', 'other');
    return this.api.chat(slug, [{ role: 'user', content: prompt }], context, signal).then((r) => r.content);
  }

  // ───────────────────────────── tasks ─────────────────────────────

  /** TL;DR plus what is unclear. */
  async summarizeIssue(issue: Issue, signal: AbortSignal): Promise<Summary> {
    const prompt = summarizePrompt(issuePromptData(this.store, issue), this.locale);
    return parseSummary(await this.chat(prompt, { kind: 'issue', id: issue.id, label: issue.key }, signal));
  }

  /** Suggested priority, estimate, type and workstreams (proposals only). */
  async triageIssue(issue: Issue, signal: AbortSignal): Promise<TriageResult> {
    const inputs = triageInputs(this.store, issue);
    const prompt = triagePrompt(
      {
        issue: issuePromptData(this.store, issue),
        estimates: inputs.estimates,
        candidates: inputs.candidates,
        similar: inputs.similar,
        kinds: KIND_LIST,
        priorities: PRIORITY_LIST,
      },
      this.locale,
    );
    const reply = await this.chat(prompt, { kind: 'issue', id: issue.id, label: issue.key }, signal);
    const triage = parseTriage(reply, {
      estimates: inputs.estimates?.map((e) => e.value) ?? [],
      candidateKeys: inputs.candidates.map((c) => c.key),
    });
    return { triage, similar: inputs.similar, candidates: inputs.candidates };
  }

  /** Clearer title and description via the suggestions endpoint. */
  async improveIssue(issue: Issue, signal: AbortSignal): Promise<AiSuggestion> {
    const slug = this.store.slug();
    if (!slug) throw new AiFailure('Open a workspace first', 'other');
    return this.api.suggest(slug, { kind: 'issue', title: issue.title.slice(0, 300), description: (issue.body ?? '').slice(0, 12000) }, signal);
  }

  /** Markdown stakeholder update drafted from the workstream's real data. */
  async workstreamUpdate(ws: Workstream, signal: AbortSignal): Promise<string> {
    const prompt = updatePrompt(workstreamPromptData(this.store, this.info, ws), this.locale);
    return parseMarkdown(await this.chat(prompt, { kind: 'workstream', id: ws.id, label: ws.key }, signal));
  }

  /** 3-7 proposed issues for the workstream (not duplicates of existing titles). */
  async breakDownWorkstream(ws: Workstream, signal: AbortSignal): Promise<ProposedIssue[]> {
    const inputs = breakdownInputs(this.store, ws);
    const reply = await this.chat(breakdownPrompt(inputs, this.locale), { kind: 'workstream', id: ws.id, label: ws.key }, signal);
    return parseBreakdown(reply, { estimates: inputs.estimates?.map((e) => e.value) ?? [], existingTitles: inputs.existingTitles });
  }

  /** Workspace standup digest (markdown). */
  async standupDigest(signal: AbortSignal): Promise<string> {
    const prompt = digestPrompt(digestData(this.store, this.info), this.locale);
    return parseMarkdown(await this.chat(prompt, { kind: 'page', label: 'Standup digest' }, signal));
  }

  // ───────────────────────────── applying (always by a person, with Undo) ─────────────────────────────

  canEditIssue(issue: Issue): boolean {
    return this.store.canEditTeamWork(issue.teamId);
  }

  canEditWorkstream(ws: Workstream): boolean {
    return this.store.canEditTeamWork(ws.ownerTeamId);
  }

  /** Apply the chosen triage suggestions. Returns how many changed. */
  async applyTriage(issue: Issue, changes: readonly TriageChange[]): Promise<number> {
    if (!this.canEditIssue(issue) || !changes.length) return 0;
    const patch: { priority?: Priority; estimate?: number; kind?: IssueKind } = {};
    const workstreamKeys: string[] = [];
    for (const c of changes) {
      if (c.type === 'workstream') workstreamKeys.push(c.value);
      else if (c.type === 'priority') patch.priority = c.value;
      else if (c.type === 'estimate') patch.estimate = c.value;
      else patch.kind = c.value;
    }
    const before = { priority: issue.priority, estimate: issue.estimate ?? null, kind: issue.kind, workstreamIds: [...issue.workstreamIds], status: issue.status };

    let ok = true;
    if (Object.keys(patch).length) ok = (await this.store.updateIssue(issue.id, patch)) && ok;
    const ids = workstreamKeys.flatMap((k) => {
      const w = this.store.getWorkstream(k);
      return w && !before.workstreamIds.includes(w.id) ? [w.id] : [];
    });
    // keep the issue's status: linking would otherwise move backlog/todo issues to in progress
    if (ids.length) ok = !!(await this.store.linkIssue(issue.id, { workstreamIds: ids, status: before.status })) && ok;
    if (!ok) return 0;

    const n = (Object.keys(patch).length ? Object.keys(patch).length : 0) + ids.length;
    this.notify.success(`Applied ${n} suggestion${n === 1 ? '' : 's'} to ${issue.key}`, {
      action: {
        label: 'Undo',
        run: () => {
          const revert: { priority?: Priority; estimate?: number | null; workstreamIds?: ID[]; kind?: IssueKind } = {};
          if (patch.priority !== undefined) revert.priority = before.priority;
          if (patch.estimate !== undefined) revert.estimate = before.estimate;
          if (patch.kind !== undefined) revert.kind = before.kind;
          if (ids.length) revert.workstreamIds = before.workstreamIds;
          void this.store.updateIssue(issue.id, revert);
        },
      },
    });
    return n;
  }

  /** Replace title / description with the accepted suggestion. */
  async applyImprovement(issue: Issue, next: { title?: string; description?: string }): Promise<boolean> {
    if (!this.canEditIssue(issue)) return false;
    const before = { title: issue.title, body: issue.body ?? null };
    const patch: { title?: string; body?: string | null } = {};
    if (next.title && next.title !== issue.title) patch.title = next.title;
    if (next.description !== undefined && next.description !== (issue.body ?? '')) patch.body = next.description || null;
    if (!Object.keys(patch).length) return true;
    if (!(await this.store.updateIssue(issue.id, patch))) return false;
    this.notify.success(`Updated ${issue.key}`, { action: { label: 'Undo', run: () => void this.store.updateIssue(issue.id, before) } });
    return true;
  }

  /** Post the (reviewed) update as a comment on the workstream. */
  async postUpdate(ws: Workstream, markdown: string): Promise<boolean> {
    if (!this.canEditWorkstream(ws) || !markdown.trim()) return false;
    const c = await this.store.addComment({ type: 'workstream', id: ws.id }, markdown.trim());
    if (c) this.notify.success(`Update posted on ${ws.key}`);
    return !!c;
  }

  /** Create the chosen issues, link them to the workstream, skip duplicates of existing titles. */
  async createIssues(ws: Workstream, proposals: readonly ProposedIssue[]): Promise<number> {
    if (!this.canEditWorkstream(ws)) return 0;
    const scaleOn = this.store.estimateScale() !== 'none';
    const seen = new Set((this.store.issuesByWorkstream().get(ws.id) ?? []).map((i) => titleKey(i.title)));
    const created: Issue[] = [];
    for (const p of proposals) {
      const title = p.title.trim();
      const key = titleKey(title);
      if (!title || !key || seen.has(key)) continue;
      seen.add(key);
      const input: CreateIssueInput = {
        kind: p.kind,
        title,
        body: p.description || undefined,
        priority: p.priority,
        teamId: ws.ownerTeamId,
        status: 'todo',
        ...(scaleOn && p.estimate !== null ? { estimate: p.estimate } : {}),
      };
      const issue = await this.store.createIssue(input);
      if (!issue) continue;
      await this.store.linkIssue(issue.id, { workstreamIds: [ws.id], status: issue.status });
      created.push(issue);
    }
    if (!created.length) return 0;
    const canUndo = this.store.allowed('deleteIssues');
    this.notify.success(`Created ${created.length} issue${created.length === 1 ? '' : 's'} in ${ws.key}`, {
      action: canUndo
        ? {
            label: 'Undo',
            run: () => {
              for (const i of created) void this.store.deleteIssue(i.id);
            },
          }
        : undefined,
    });
    return created.length;
  }
}
