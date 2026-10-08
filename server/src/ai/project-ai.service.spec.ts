import { BadGatewayException, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceContext } from '../auth/request-context.js';
import type { ProjectAiIssues, ProjectAiRisks, ProjectAiSummary, ProjectAiUpdateDraft } from '../contracts/domain.js';
import type { AiConfig } from './ai.config.js';
import type { AiService } from './ai.service.js';
import type { AiProvider } from './ai-provider.js';
import type { GrokBuildService } from './grok-build.service.js';
import type { ProjectAiFactsService } from './project-ai-facts.service.js';
import { ProjectAiService } from './project-ai.service.js';
import { factsJson, type FactsIssue, type ProjectFacts } from './project-ai.logic.js';

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const ahead = (days: number) => new Date(Date.now() + days * DAY).toISOString();

const issue = (n: number, extra: Partial<FactsIssue> = {}): FactsIssue => ({
  id: `iss_${n}`,
  key: `ENG-${n}`,
  title: `Issue ${n}`,
  status: 'todo',
  priority: 'medium',
  assigneeId: 'usr_1',
  assignee: 'Ada',
  workstreamIds: [],
  milestoneIds: [],
  updatedAt: ago(1),
  ...extra,
});

function makeFacts(extra: Partial<ProjectFacts> = {}): ProjectFacts {
  return {
    project: {
      id: 'pj_1',
      name: 'Billing revamp',
      summary: null,
      description: null,
      status: 'in_progress',
      priority: 'high',
      health: null,
      lead: 'Ada',
      startDate: ago(40),
      targetDate: ahead(60),
      createdAt: ago(40),
      lastUpdateAt: ago(2),
    },
    milestones: [],
    workstreams: [],
    issues: [issue(1), issue(2, { status: 'done' })],
    updates: [],
    decisions: [],
    inputRequests: [],
    events: [],
    candidates: [],
    ...extra,
  };
}

function setup(opts: { facts?: ProjectFacts; reply?: string | Error; configured?: boolean; canManage?: boolean; leadId?: string } = {}) {
  const complete = vi.fn(async () => {
    if (opts.reply instanceof Error) throw opts.reply;
    return opts.reply ?? '{}';
  });
  const gather = vi.fn(async () => opts.facts ?? makeFacts());
  const service = new ProjectAiService(
    { status: () => ({ configured: opts.configured ?? true, model: 'm' }) } as unknown as AiConfig,
    { status: async () => ({ connected: false }) } as unknown as GrokBuildService,
    { complete } as unknown as AiProvider,
    { run: (_u: string, action: () => Promise<unknown>) => action() } as unknown as AiService,
    { gather } as unknown as ProjectAiFactsService,
    { findOneBy: async () => ({ id: 'pj_1', workspaceId: 'ws_1', leadId: opts.leadId ?? null }) } as unknown as never,
  );
  const ctx = {
    workspace: {
      id: 'ws_1',
      name: 'Acme',
      resolved: () => ({ permissions: { manageProjects: opts.canManage === false ? 'admin' : 'member' } }),
    },
    role: 'member',
    userId: 'usr_1',
  } as unknown as WorkspaceContext;
  const run = (kind: Parameters<ProjectAiService['suggest']>[3]) =>
    service.suggest('usr_1', ctx, 'pj_1', kind, new AbortController().signal);
  return { run, complete, gather };
}

describe('project AI: update_draft', () => {
  it('returns the validated draft', async () => {
    const { run } = setup({ reply: '```json\n{"health":"at_risk","body":"## Progress\\nShipped invoices."}\n```' });
    const result = (await run('update_draft')) as ProjectAiUpdateDraft;
    expect(result).toEqual({ kind: 'update_draft', health: 'at_risk', body: '## Progress\nShipped invoices.' });
  });

  it('falls back to the computed health when the model health is unknown', async () => {
    const { run } = setup({ reply: '{"health":"great","body":"All good."}' });
    expect((await run('update_draft')) as ProjectAiUpdateDraft).toMatchObject({ health: 'on_track' });
  });

  it('rejects malformed output', async () => {
    const { run } = setup({ reply: 'sorry, I cannot do that' });
    await expect(run('update_draft')).rejects.toBeInstanceOf(BadGatewayException);
    const empty = setup({ reply: '{"health":"on_track","body":"  "}' });
    await expect(empty.run('update_draft')).rejects.toBeInstanceOf(BadGatewayException);
  });
});

describe('project AI: summary', () => {
  it('returns a single-line summary and the description', async () => {
    const { run } = setup({ reply: '{"summary":"Rebuild\\nbilling   flow","description":"## Goal\\nInvoices."}' });
    expect((await run('summary')) as ProjectAiSummary).toEqual({
      kind: 'summary',
      summary: 'Rebuild billing flow',
      description: '## Goal\nInvoices.',
    });
  });

  it('rejects an output without a summary', async () => {
    const { run } = setup({ reply: '{"summary":"","description":"x"}' });
    await expect(run('summary')).rejects.toBeInstanceOf(BadGatewayException);
  });
});

describe('project AI: issues', () => {
  const candidates = [issue(10, { status: 'backlog', assigneeId: null, assignee: null }), issue(11)];

  it('keeps only candidate ids and keys, once, with a reason', async () => {
    const { run } = setup({
      facts: makeFacts({ candidates }),
      reply: JSON.stringify({
        suggestions: [
          { issueId: 'iss_10', reason: 'Mentions invoices.' },
          { issueId: 'iss_made_up', reason: 'Invented by the model.' },
          { issueId: 'iss_10', reason: 'Duplicate.' },
          { issueId: 'ENG-11', reason: 'Same area, by key.' },
          { issueId: 'iss_1', reason: 'Already in the project.' },
          { issueId: 'iss_11', reason: '   ' },
        ],
      }),
    });
    const result = (await run('issues')) as ProjectAiIssues;
    expect(result.suggestions).toEqual([
      { issueId: 'iss_10', reason: 'Mentions invoices.' },
      { issueId: 'iss_11', reason: 'Same area, by key.' },
    ]);
  });

  it('caps the list at 10 and skips the model when there are no candidates', async () => {
    const many = Array.from({ length: 15 }, (_, i) => issue(100 + i));
    const { run } = setup({
      facts: makeFacts({ candidates: many }),
      reply: JSON.stringify({ suggestions: many.map((i) => ({ issueId: i.id, reason: 'fits' })) }),
    });
    expect(((await run('issues')) as ProjectAiIssues).suggestions).toHaveLength(10);

    const none = setup({ facts: makeFacts({ candidates: [] }) });
    expect(await none.run('issues')).toEqual({ kind: 'issues', suggestions: [] });
    expect(none.complete).not.toHaveBeenCalled();
  });

  it('rejects malformed output', async () => {
    const { run } = setup({ facts: makeFacts({ candidates }), reply: '{"suggestions":"all of them"}' });
    await expect(run('issues')).rejects.toBeInstanceOf(BadGatewayException);
  });
});

describe('project AI: risks', () => {
  const lateFacts = () =>
    makeFacts({
      project: { ...makeFacts().project, targetDate: ago(3) },
      workstreams: [
        {
          id: 'wk_1',
          key: 'BIL-1',
          title: 'Invoices',
          status: 'blocked',
          objective: '',
          targetDate: null,
          openInputRequests: 0,
          oldestInputRequestAt: null,
        },
      ],
    });

  it('works without any model call when there is nothing to report', async () => {
    const { run, complete } = setup();
    expect(await run('risks')).toEqual({ kind: 'risks', health: 'on_track', risks: [] });
    expect(complete).not.toHaveBeenCalled();
  });

  it('computes signals first and lets the model only reword them', async () => {
    const { run, complete } = setup({
      facts: lateFacts(),
      reply: JSON.stringify({
        risks: [
          { ref: 'S2', title: 'Invoices stuck', detail: 'BIL-1 is blocked.' },
          { ref: 'S99', title: 'Invented risk', detail: 'No such signal.' },
        ],
      }),
    });
    const result = (await run('risks')) as ProjectAiRisks;
    expect(complete).toHaveBeenCalledTimes(1);
    expect(result.health).toBe('off_track'); // two high signals
    expect(result.risks).toHaveLength(2);
    expect(result.risks.find((r) => r.workstreamId === 'wk_1')).toMatchObject({
      title: 'Invoices stuck',
      detail: 'BIL-1 is blocked.',
      severity: 'high',
    });
    expect(result.risks.some((r) => r.title === 'Invented risk')).toBe(false);
    expect(result.risks.some((r) => /target date/i.test(r.title))).toBe(true);
  });

  it('falls back to the deterministic result when the AI is off', async () => {
    const { run, complete } = setup({ facts: lateFacts(), configured: false });
    const result = (await run('risks')) as ProjectAiRisks;
    expect(complete).not.toHaveBeenCalled();
    expect(result.risks.map((r) => r.severity)).toEqual(['high', 'high']);
    expect(result.risks.every((r) => r.title && r.detail)).toBe(true);
  });

  it('falls back when the model fails or answers garbage', async () => {
    const failing = setup({ facts: lateFacts(), reply: new Error('provider down') });
    const garbage = setup({ facts: lateFacts(), reply: 'not json' });
    const a = (await failing.run('risks')) as ProjectAiRisks;
    const b = (await garbage.run('risks')) as ProjectAiRisks;
    expect(a.risks).toHaveLength(2);
    expect(b).toEqual(a);
  });

  it('flags late milestones, stale issues and missing updates', async () => {
    const facts = makeFacts({
      milestones: [{ id: 'ms_1', name: 'Beta', targetDate: ago(20) }],
      issues: [
        issue(1, { milestoneIds: ['ms_1'] }),
        issue(2, { status: 'in_progress', updatedAt: ago(40) }),
        issue(3, { priority: 'urgent', assigneeId: null, assignee: null }),
      ],
      project: { ...makeFacts().project, lastUpdateAt: ago(35) },
    });
    const { run } = setup({ facts, configured: false });
    const { risks } = (await run('risks')) as ProjectAiRisks;
    const titles = risks.map((r) => r.title);
    expect(titles).toContain('Milestone "Beta" is late');
    expect(titles).toContain('ENG-2 looks stalled');
    expect(titles).toContain('ENG-3 has no assignee');
    expect(titles).toContain('No recent project update');
    expect(risks.find((r) => r.title === 'ENG-2 looks stalled')?.issueId).toBe('iss_2');
  });
});

describe('project AI: access and configuration', () => {
  it('does not call the model for non-risk kinds when AI is not configured', async () => {
    const { run, complete, gather } = setup({ configured: false });
    await expect(run('summary')).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(complete).not.toHaveBeenCalled();
    expect(gather).not.toHaveBeenCalled();
  });

  it('requires manageProjects or being the project lead', async () => {
    await expect(setup({ canManage: false }).run('summary')).rejects.toBeInstanceOf(ForbiddenException);
    const lead = setup({ canManage: false, leadId: 'usr_1', reply: '{"summary":"s","description":"d"}' });
    await expect(lead.run('summary')).resolves.toMatchObject({ kind: 'summary' });
  });
});

describe('project AI: prompt size', () => {
  it('caps the facts JSON', () => {
    const issues = Array.from({ length: 400 }, (_, i) => issue(i, { title: 'x'.repeat(200) }));
    const events = Array.from({ length: 25 }, (_, i) => ({ at: ago(i), type: 'issue.updated', summary: 'y'.repeat(200) }));
    const facts = makeFacts({
      issues,
      events,
      candidates: issues,
      project: { ...makeFacts().project, description: 'd'.repeat(50_000) },
    });
    expect(factsJson(facts, {}, 24_000).length).toBeLessThanOrEqual(24_000);
    expect(() => JSON.parse(factsJson(facts, {}, 24_000))).not.toThrow();
  });
});
