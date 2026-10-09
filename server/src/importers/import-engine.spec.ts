import { describe, expect, it } from 'vitest';
import { DEFAULT_IMPORT_OPTIONS, type ExternalProvider, type ExternalRef, type ImportMapping, type ImportOptions } from '../contracts/domain.js';
import { ProviderHttpError } from '../integrations/http-client.js';
import { ImportEngine, ImportFatalError, commentBody, emptyProgress, type EngineHooks, type EngineState, type ImportSink } from './import-engine.js';
import type { NewIssue, ResolvedPlan } from './mapping.js';
import type { Discovery, ExternalComment, ExternalIssue, ImportSourceAdapter, Page } from './types.js';

const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
const NOW = new Date('2026-10-01T00:00:00Z');

function issue(n: number, extra: Partial<ExternalIssue> = {}): ExternalIssue {
  return {
    id: `acme/api#${n}`,
    key: `#${n}`,
    url: `https://github.com/acme/api/issues/${n}`,
    title: `Issue ${n}`,
    body: null,
    state: { id: 'open', name: 'Open', type: 'open' },
    labels: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...extra,
  };
}

const DISCOVERY: Discovery = {
  provider: 'github',
  account: 'ada',
  sourceLabel: 'acme/api',
  counts: { issues: 5, open: 5, closed: 0 },
  teams: [],
  projects: [],
  labels: [],
  milestones: [],
  users: [],
  statuses: [],
  sample: [],
  warnings: [],
};

/** Pages of 2 over a fixed list of issues, cursor = start offset. Can be told to fail once at a given call. */
class FakeSource implements ImportSourceAdapter {
  readonly provider = 'github' as const;
  discoverCalls = 0;
  issueCalls = 0;
  failures: { at: number; error: Error }[] = [];
  constructor(
    readonly all: ExternalIssue[],
    readonly allComments: ExternalComment[] = [],
  ) {}
  async discover() {
    this.discoverCalls++;
    return DISCOVERY;
  }
  async issues(cursor: string | null): Promise<Page<ExternalIssue>> {
    const call = ++this.issueCalls;
    const failure = this.failures.find((f) => f.at === call);
    if (failure) throw failure.error;
    const from = Number(cursor ?? 0);
    const items = this.all.slice(from, from + 2);
    return { items, next: from + 2 < this.all.length ? String(from + 2) : null };
  }
  async comments(cursor: string | null): Promise<Page<ExternalComment>> {
    const from = Number(cursor ?? 0);
    return { items: this.allComments.slice(from, from + 2), next: from + 2 < this.allComments.length ? String(from + 2) : null };
  }
  async getIssue(): Promise<ExternalIssue> {
    throw new Error('not used');
  }
}

/** In-memory store with the same guarantees as the SQL one: one row per (workspace, provider, external id). */
class MemorySink implements ImportSink {
  readonly issues = new Map<string, NewIssue & { trama: string }>();
  readonly comments = new Map<string, string>();
  readonly refreshed: string[] = [];
  failOn = new Set<string>();
  plans = 0;
  constructor(readonly workspaceId = 'ws_1') {}
  private key(provider: ExternalProvider, id: string) {
    return `${this.workspaceId}|${provider}|${id}`;
  }
  async resolvePlan(): Promise<ResolvedPlan> {
    this.plans++;
    return { teams: {}, projects: {}, labels: {}, milestones: {}, users: {}, statuses: {} };
  }
  async existingIssues(provider: ExternalProvider, ids: string[]) {
    return new Map(ids.filter((id) => this.issues.has(this.key(provider, id))).map((id) => [id, this.issues.get(this.key(provider, id))!.trama]));
  }
  async createIssue(n: NewIssue) {
    if (this.failOn.has(n.externalRef.id)) throw new Error(`insert failed with ${TOKEN}`);
    const k = this.key(n.externalRef.provider, n.externalRef.id);
    if (this.issues.has(k)) return 'exists' as const;
    this.issues.set(k, { ...n, trama: `in_${this.issues.size + 1}` });
    return 'created' as const;
  }
  async refreshRef(provider: ExternalProvider, id: string, _ref: ExternalRef) {
    this.refreshed.push(this.key(provider, id));
  }
  async existingComments(provider: ExternalProvider, ids: string[]) {
    return new Set(ids.filter((id) => this.comments.has(this.key(provider, id))));
  }
  async createComment(provider: ExternalProvider, c: { externalId: string; body: string }) {
    const k = this.key(provider, c.externalId);
    if (this.comments.has(k)) return false;
    this.comments.set(k, c.body);
    return true;
  }
}

const MAPPING: ImportMapping = { teams: {}, projects: {}, labels: {}, users: {}, statuses: {} };

function harness(opts: { options?: Partial<ImportOptions>; cancelAfterPages?: number; waits?: ('resume' | 'release')[] } = {}) {
  const checkpoints: EngineState[] = [];
  const waited: Date[] = [];
  let pages = 0;
  const hooks: EngineHooks = {
    now: () => NOW,
    sleep: async () => undefined,
    checkpoint: async (s) => {
      pages++;
      checkpoints.push(JSON.parse(JSON.stringify(s)) as EngineState);
    },
    isCanceled: async () => opts.cancelAfterPages !== undefined && pages >= opts.cancelAfterPages,
    wait: async (until) => {
      waited.push(until);
      return opts.waits?.shift() ?? 'resume';
    },
  };
  const options: ImportOptions = { ...DEFAULT_IMPORT_OPTIONS, ...opts.options };
  const state = (): EngineState => ({ phase: 'setup', cursor: null, progress: emptyProgress(), errors: [] });
  const engine = (source: ImportSourceAdapter, sink: ImportSink) => new ImportEngine('github', source, sink, MAPPING, options, hooks, [TOKEN]);
  return { hooks, checkpoints, waited, state, engine };
}

describe('ImportEngine', () => {
  it('imports every page, checkpointing after each one', async () => {
    const h = harness();
    const sink = new MemorySink();
    const state = h.state();
    expect(await h.engine(new FakeSource([1, 2, 3, 4, 5].map((n) => issue(n))), sink).run(state)).toBe('completed');
    expect(sink.issues.size).toBe(5);
    expect(state.progress).toMatchObject({ phase: 'done', processed: 5, created: 5, skipped: 0, failed: 0, total: 5 });
    // setup + 3 pages
    expect(h.checkpoints.map((c) => [c.phase, c.cursor])).toEqual([['issues', null], ['issues', '2'], ['issues', '4'], ['done', null]]);
  });

  it('is idempotent: a second run creates nothing and only refreshes the mirrored status', async () => {
    const h = harness();
    const sink = new MemorySink();
    const source = new FakeSource([1, 2, 3].map((n) => issue(n)));
    await h.engine(source, sink).run(h.state());
    const second = h.state();
    await h.engine(source, sink).run(second);
    expect(sink.issues.size).toBe(3);
    expect(second.progress).toMatchObject({ created: 0, skipped: 3, processed: 3 });
    expect(sink.refreshed).toHaveLength(3);
  });

  it('treats a row another run created in between as already imported', async () => {
    const h = harness();
    const sink = new MemorySink();
    const original = sink.existingIssues.bind(sink);
    // the page check says "new", but the insert finds the unique index taken
    sink.existingIssues = async () => new Map();
    await sink.createIssue({ externalRef: { provider: 'github', id: 'acme/api#1' } } as NewIssue);
    const state = h.state();
    await h.engine(new FakeSource([issue(1)]), sink).run(state);
    sink.existingIssues = original;
    expect(sink.issues.size).toBe(1);
    expect(state.progress).toMatchObject({ created: 0, skipped: 1 });
  });

  it('resumes from the stored cursor and plan without reading the source description again', async () => {
    const h = harness();
    const sink = new MemorySink();
    const source = new FakeSource([1, 2, 3, 4, 5].map((n) => issue(n)));
    const crash = new Error('process died');
    source.failures = [{ at: 3, error: crash }];
    const state = h.state();
    // transient failures are retried; make the third call fail for good by exhausting retries
    source.failures = [3, 4, 5, 6].map((at) => ({ at, error: crash }));
    await expect(h.engine(source, sink).run(state)).rejects.toBeInstanceOf(ImportFatalError);
    expect(sink.issues.size).toBe(4);
    const saved = h.checkpoints[h.checkpoints.length - 1];
    expect(saved).toMatchObject({ phase: 'issues', cursor: '4' });

    const resumed: EngineState = { ...saved };
    source.failures = [];
    const before = source.discoverCalls;
    expect(await h.engine(source, sink).run(resumed)).toBe('completed');
    expect(source.discoverCalls).toBe(before); // the plan was saved: no second discovery
    expect(sink.issues.size).toBe(5);
    expect(resumed.progress.created).toBe(5);
  });

  it('stops at the next page when cancelled and keeps what was imported', async () => {
    const h = harness({ cancelAfterPages: 2 });
    const sink = new MemorySink();
    const state = h.state();
    expect(await h.engine(new FakeSource([1, 2, 3, 4, 5].map((n) => issue(n))), sink).run(state)).toBe('canceled');
    expect(sink.issues.size).toBe(2);
    expect(state.phase).toBe('issues');
  });

  it('waits out a rate limit and retries the same page', async () => {
    const h = harness();
    const source = new FakeSource([issue(1), issue(2)]);
    const until = new Date(Date.now() + 60_000);
    source.failures = [{ at: 1, error: new ProviderHttpError(403, 'Rate limited', until) }];
    const sink = new MemorySink();
    expect(await h.engine(source, sink).run(h.state())).toBe('completed');
    expect(h.waited).toEqual([until]);
    expect(source.issueCalls).toBe(2);
    expect(sink.issues.size).toBe(2);
  });

  it('hands the job back when the rate limit window is too long to wait for', async () => {
    const h = harness({ waits: ['release'] });
    const source = new FakeSource([issue(1)]);
    source.failures = [{ at: 1, error: new ProviderHttpError(429, 'Rate limited', new Date(Date.now() + 3_600_000)) }];
    const state = h.state();
    expect(await h.engine(source, new MemorySink()).run(state)).toBe('released');
    // the plan was saved before the page was requested, so the resume continues at the issues
    expect(h.checkpoints[h.checkpoints.length - 1]).toMatchObject({ phase: 'issues', cursor: null });
  });

  it('fails the job on a rejected credential, without retrying', async () => {
    const h = harness();
    const source = new FakeSource([issue(1)]);
    source.failures = [{ at: 1, error: new ProviderHttpError(401, `Bad credentials for ${TOKEN}`) }];
    const err = await h.engine(source, new MemorySink()).run(h.state()).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(ImportFatalError);
    expect((err as Error).message).not.toContain(TOKEN);
    expect(source.issueCalls).toBe(1);
  });

  it('records a failing issue, redacts the token, and carries on with the rest', async () => {
    const h = harness();
    const sink = new MemorySink();
    sink.failOn.add('acme/api#2');
    const state = h.state();
    await h.engine(new FakeSource([issue(1), issue(2), issue(3)]), sink).run(state);
    expect(sink.issues.size).toBe(2);
    expect(state.progress).toMatchObject({ created: 2, failed: 1 });
    expect(state.errors).toHaveLength(1);
    expect(state.errors[0].ref).toBe('#2');
    expect(JSON.stringify(state.errors)).not.toContain(TOKEN);
    expect(state.errors[0].message).toContain('[redacted]');
  });

  it('caps the stored error list but still counts every failure', async () => {
    const h = harness();
    const sink = new MemorySink();
    const many = Array.from({ length: 130 }, (_, i) => issue(i + 1));
    many.forEach((i) => sink.failOn.add(i.id));
    const state = h.state();
    await h.engine(new FakeSource(many), sink).run(state);
    expect(state.progress.failed).toBe(130);
    expect(state.errors).toHaveLength(100);
  });

  it('imports comments once, only for issues that were imported, written by the importer', async () => {
    const h = harness({ options: { includeComments: true } });
    const sink = new MemorySink();
    const comments: ExternalComment[] = [
      { id: 'c1', issueId: 'acme/api#1', author: { id: 'ada', login: 'ada' }, body: 'first', createdAt: '2026-01-02T00:00:00Z' },
      { id: 'c2', issueId: 'acme/api#99', body: 'on a pull request', createdAt: '2026-01-02T00:00:00Z' },
      { id: 'c3', issueId: 'acme/api#2', author: { id: 'x', name: 'Xavier' }, body: 'third', createdAt: '2026-01-03T00:00:00Z' },
    ];
    const source = new FakeSource([issue(1), issue(2)], comments);
    const first = h.state();
    await h.engine(source, sink).run(first);
    expect(first.progress.comments).toBe(2);
    expect([...sink.comments.values()]).toEqual([commentBody('github', comments[0]), commentBody('github', comments[2])]);

    const second = h.state();
    await h.engine(source, sink).run(second);
    expect(second.progress.comments).toBe(0);
    expect(sink.comments.size).toBe(2);
  });

  it('keeps two workspaces apart: the same external issue is imported once in each', async () => {
    const h = harness();
    const a = new MemorySink('ws_a');
    const b = new MemorySink('ws_b');
    const source = new FakeSource([issue(1)]);
    await h.engine(source, a).run(h.state());
    const state = h.state();
    await h.engine(source, b).run(state);
    expect(a.issues.size).toBe(1);
    expect(b.issues.size).toBe(1);
    expect(state.progress.created).toBe(1);
  });
});

describe('commentBody', () => {
  it('names the original author and day, and says where it came from', () => {
    expect(commentBody('github', { author: { id: 'a', login: 'ada' }, body: 'hi', createdAt: '2026-05-06T10:00:00Z' })).toBe('_Imported from GitHub: @ada wrote on 2026-05-06_\n\nhi');
    expect(commentBody('linear', { author: { id: 'a', name: 'Ada L' }, body: 'hi', createdAt: 'nope' })).toBe('_Imported from Linear: Ada L wrote_\n\nhi');
  });
});
