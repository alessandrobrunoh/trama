import type {
  ExternalProvider,
  ExternalRef,
  ImportErrorEntry,
  ImportMapping,
  ImportOptions,
  ImportPhase,
  ImportProgress,
} from '../contracts/domain.js';
import { ProviderHttpError } from '../integrations/http-client.js';
import { externalRefOf, redactSecrets, toNewIssue, type NewIssue, type ResolvedPlan } from './mapping.js';
import type { Discovery, ExternalComment, ExternalIssue, ImportSourceAdapter } from './types.js';

export const MAX_STORED_ERRORS = 100;
const MAX_RATE_WAITS_IN_A_ROW = 30;
const TRANSIENT_RETRIES = 3;

/** What the engine needs from persistence. Every method is scoped to one workspace by its implementation. */
export interface ImportSink {
  /** Creates (idempotently) what the mapping asks to create and returns Trama ids per external id. */
  resolvePlan(discovery: Discovery, mapping: ImportMapping): Promise<ResolvedPlan>;
  /** external issue id -> Trama issue id, for the ids that were already imported or linked. */
  existingIssues(provider: ExternalProvider, ids: string[]): Promise<Map<string, string>>;
  /** `exists` when another run (or a link) got there first. */
  createIssue(issue: NewIssue): Promise<'created' | 'exists'>;
  /** Refreshes the mirrored external status of an issue that was already imported. */
  refreshRef(provider: ExternalProvider, id: string, ref: ExternalRef): Promise<void>;
  /** Comment ids (external) already imported. */
  existingComments(provider: ExternalProvider, ids: string[]): Promise<Set<string>>;
  createComment(provider: ExternalProvider, comment: { externalId: string; issueId: string; body: string; createdAt: Date }): Promise<boolean>;
}

export interface EngineState {
  phase: ImportPhase;
  cursor: string | null;
  plan?: ResolvedPlan;
  progress: ImportProgress;
  errors: ImportErrorEntry[];
}

export interface EngineHooks {
  /** Persist progress, cursor and the heartbeat. Called after every page. */
  checkpoint(state: EngineState): Promise<void>;
  /** Right after the source was described, before anything is written (label, totals). */
  onDiscovery?(discovery: Discovery): Promise<void>;
  isCanceled(): Promise<boolean>;
  /** Sleep through a rate limit. `release` hands the job back to the queue (the wait is too long to hold on). */
  wait(until: Date): Promise<'resume' | 'release'>;
  sleep(ms: number): Promise<void>;
  now(): Date;
}

export type EngineOutcome = 'completed' | 'canceled' | 'released';

/** The provider told us no (bad credential, missing repository…): retrying cannot help. */
export class ImportFatalError extends Error {}

export function emptyProgress(): ImportProgress {
  return { phase: 'setup', processed: 0, created: 0, skipped: 0, failed: 0, comments: 0 };
}

/**
 * The import loop, free of Nest and TypeORM: pages in, issues out, with a checkpoint after each page.
 * It is resumable (state carries phase + cursor + plan) and idempotent (the sink refuses a second copy
 * of an external id), so a crash or a re-run never duplicates.
 */
export class ImportEngine {
  constructor(
    private readonly provider: ExternalProvider,
    private readonly source: ImportSourceAdapter,
    private readonly sink: ImportSink,
    private readonly mapping: ImportMapping,
    private readonly options: ImportOptions,
    private readonly hooks: EngineHooks,
    /** Strings to scrub from anything stored: the token. */
    private readonly secrets: readonly string[] = [],
  ) {}

  async run(state: EngineState): Promise<EngineOutcome> {
    try {
      if (await this.hooks.isCanceled()) return 'canceled';
      if (!state.plan) {
        state.phase = 'setup';
        const discovery = await this.call(() => this.source.discover());
        await this.hooks.onDiscovery?.(discovery);
        state.plan = await this.sink.resolvePlan(discovery, this.mapping);
        state.progress.total = discovery.counts.issues ?? undefined;
        state.phase = 'issues';
        state.cursor = null;
        await this.save(state);
      }
      while (state.phase === 'issues') {
        if (await this.hooks.isCanceled()) return 'canceled';
        const page = await this.call(() => this.source.issues(state.cursor, this.options));
        await this.issuePage(state, page.items);
        state.cursor = page.next;
        if (!page.next) {
          state.phase = this.options.includeComments ? 'comments' : 'done';
          state.cursor = null;
        }
        await this.save(state);
      }
      while (state.phase === 'comments') {
        if (await this.hooks.isCanceled()) return 'canceled';
        const page = await this.call(() => this.source.comments(state.cursor));
        await this.commentPage(state, page.items);
        state.cursor = page.next;
        if (!page.next) {
          state.phase = 'done';
          state.cursor = null;
        }
        await this.save(state);
      }
      return 'completed';
    } catch (e) {
      if (e instanceof ReleaseSignal) return 'released';
      throw e;
    }
  }

  private async save(state: EngineState) {
    state.progress.phase = state.phase;
    await this.hooks.checkpoint(state);
  }

  private fail(state: EngineState, ref: string, e: unknown) {
    state.progress.failed++;
    if (state.errors.length < MAX_STORED_ERRORS)
      state.errors.push({ ref, message: redactSecrets(e instanceof Error ? e.message : String(e), this.secrets).slice(0, 300) });
  }

  private async issuePage(state: EngineState, items: ExternalIssue[]) {
    const plan = state.plan!;
    const existing = await this.sink.existingIssues(this.provider, items.map((i) => i.id));
    for (const ext of items) {
      state.progress.processed++;
      try {
        if (existing.has(ext.id)) {
          state.progress.skipped++;
          await this.sink.refreshRef(this.provider, ext.id, externalRefOf(this.provider, ext, 'import', this.hooks.now()));
          continue;
        }
        const result = await this.sink.createIssue(toNewIssue(this.provider, ext, plan, this.options, this.hooks.now()));
        if (result === 'created') state.progress.created++;
        else state.progress.skipped++;
      } catch (e) {
        this.fail(state, ext.key, e);
      }
    }
  }

  private async commentPage(state: EngineState, items: ExternalComment[]) {
    if (!items.length) return;
    const issues = await this.sink.existingIssues(this.provider, [...new Set(items.map((c) => c.issueId))]);
    const done = await this.sink.existingComments(this.provider, items.map((c) => c.id));
    for (const c of items) {
      const issueId = issues.get(c.issueId);
      // A comment on an issue that was not imported (a pull request, a closed issue left out) has nowhere to go.
      if (!issueId || done.has(c.id)) continue;
      try {
        const created = await this.sink.createComment(this.provider, {
          externalId: c.id,
          issueId,
          body: commentBody(this.provider, c),
          createdAt: new Date(Number.isNaN(Date.parse(c.createdAt)) ? this.hooks.now() : c.createdAt),
        });
        if (created) state.progress.comments++;
      } catch (e) {
        this.fail(state, `comment ${c.id}`, e);
      }
    }
  }

  /** Runs one provider call, waiting out rate limits and retrying transient failures. */
  private async call<T>(fn: () => Promise<T>): Promise<T> {
    let waits = 0;
    let retries = 0;
    for (;;) {
      try {
        return await fn();
      } catch (e) {
        if (e instanceof ProviderHttpError) {
          if (e.rateLimitedUntil) {
            if (++waits > MAX_RATE_WAITS_IN_A_ROW) throw new ImportFatalError('Still rate limited after waiting repeatedly');
            if ((await this.hooks.wait(e.rateLimitedUntil)) === 'release') throw new ReleaseSignal();
            continue;
          }
          if (e.status < 500 && e.status !== 408) throw new ImportFatalError(redactSecrets(e.message, this.secrets));
        }
        if (e instanceof ImportFatalError || e instanceof ReleaseSignal) throw e;
        if (++retries > TRANSIENT_RETRIES) throw new ImportFatalError(redactSecrets(`${(e as Error).message ?? e} (gave up after ${TRANSIENT_RETRIES} retries)`, this.secrets));
        await this.hooks.sleep(1000 * 2 ** (retries - 1));
      }
    }
  }
}

class ReleaseSignal extends Error {}

/** Imported comments are written by the person who ran the import; the original author and date are in the text. */
export function commentBody(provider: ExternalProvider, c: Pick<ExternalComment, 'author' | 'body' | 'createdAt'>): string {
  const who = c.author?.login ? `@${c.author.login}` : (c.author?.name ?? 'someone');
  const day = Number.isNaN(Date.parse(c.createdAt)) ? '' : ` on ${c.createdAt.slice(0, 10)}`;
  const from = provider === 'github' ? 'GitHub' : 'Linear';
  return `_Imported from ${from}: ${who} wrote${day}_\n\n${c.body}`.slice(0, 20_000);
}
