import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceContext } from '../auth/request-context.js';
import { AiService } from './ai.service.js';
import type { AiProvider, AiToolCall, AiToolTurn, AiTurnMessage } from './ai-provider.js';
import type { AssistantToolsService, McpSession } from './assistant-tools.service.js';

const ctx = { workspace: { id: 'ws_1', name: 'Acme' }, userId: 'usr_1' } as unknown as WorkspaceContext;
const page = { resolve: async () => '{}' } as never;
const dto = { messages: [{ role: 'user' as const, content: 'do it' }] };
const call = (name: string, args: object = {}, id = name): AiToolCall => ({ id, name, arguments: JSON.stringify(args) });

function setup(turns: AiToolTurn[], opts: { callResult?: { text: string; isError: boolean } } = {}) {
  const seen: AiTurnMessage[][] = [];
  const queue = [...turns];
  const provider = {
    supportsTools: async () => true,
    completeWithTools: async (messages: AiTurnMessage[], tools: unknown[]) => {
      seen.push(structuredClone(messages));
      if (!tools.length) return { content: 'summary', toolCalls: [] }; // the closing turn offers no tools
      return queue.shift() ?? { content: 'done', toolCalls: [] };
    },
    complete: async () => 'summary',
  } as unknown as AiProvider;
  const tools = vi.fn(async (_name: string, _args: object) => opts.callResult ?? { text: '{"ok":true}', isError: false });
  const session: McpSession = {
    tools: [
      { name: 'list_issues', description: '', parameters: {}, readOnly: true },
      { name: 'create_issue', description: '', parameters: {}, readOnly: false },
      { name: 'delete_issue', description: '', parameters: {}, readOnly: false },
    ],
    call: (name, args) => tools(name, args),
  };
  const assistantTools = {
    enabled: () => true,
    withSession: async (_u: string, _c: unknown, _s: AbortSignal, action: (s: McpSession) => Promise<unknown>) => action(session),
  } as unknown as AssistantToolsService;
  return { service: new AiService(provider, page, assistantTools), tools, seen };
}

const run = (s: AiService, userId = 'usr_1') => s.chat(userId, ctx, dto as never, new AbortController().signal);

describe('assistant tool loop', () => {
  it('executes tool calls, feeds results back and appends the actions taken', async () => {
    const { service, tools, seen } = setup([
      { content: '', toolCalls: [call('list_issues'), call('create_issue', { kind: 'bug', title: 'x' })] },
      { content: 'Created it.', toolCalls: [] },
    ]);
    const res = await run(service);
    expect(tools).toHaveBeenCalledTimes(2);
    expect(res.content).toBe('Created it.');
    expect(res.activity?.steps).toEqual([
      { kind: 'read', label: 'Looked at issues' },
      { kind: 'write', label: 'Created issue', ok: true },
    ]);
    const last = seen[1].at(-1)!;
    expect(last).toMatchObject({ role: 'tool', toolCallId: 'create_issue' });
  });

  it('answers unknown tools and malformed arguments without calling the server', async () => {
    const { service, tools, seen } = setup([
      { content: '', toolCalls: [call('rm_rf'), { id: 'bad', name: 'create_issue', arguments: '{nope' }] },
      { content: 'ok', toolCalls: [] },
    ]);
    await run(service);
    expect(tools).not.toHaveBeenCalled();
    const results = seen[1].filter((m) => m.role === 'tool').map((m) => m.content);
    expect(results[0]).toMatch(/Unknown tool/);
    expect(results[1]).toMatch(/not valid JSON/);
  });

  it('caps changes per reply at 10 and stops spending on writes', async () => {
    const many = Array.from({ length: 14 }, (_, i) => call('create_issue', { kind: 'bug', title: `n${i}` }, `c${i}`));
    const { service, tools, seen } = setup([
      { content: '', toolCalls: many },
      { content: 'Stopped.', toolCalls: [] },
    ]);
    const res = await run(service);
    expect(tools).toHaveBeenCalledTimes(10);
    const results = seen[1].filter((m) => m.role === 'tool').map((m) => m.content);
    expect(results.slice(10).every((r) => /Change limit reached/.test(r))).toBe(true);
    expect(res.activity?.steps).toEqual([{ kind: 'write', label: 'Created issue', ok: true, count: 10 }]);
  });

  it('stops after the step budget and returns a plain summary', async () => {
    const forever = Array.from({ length: 14 }, () => ({ content: '', toolCalls: [call('list_issues')] }));
    const { service, seen } = setup(forever);
    const res = await run(service);
    expect(seen).toHaveLength(13); // 12 tool steps + the closing turn
    expect(seen.at(-1)!.at(-1)).toMatchObject({ role: 'system' });
    expect(res.content).toBe('summary');
    expect(res.activity?.steps[0]).toMatchObject({ kind: 'read', label: 'Looked at issues', count: 12 });
  });

  it('reports failed writes as failed', async () => {
    const { service } = setup(
      [{ content: '', toolCalls: [call('delete_issue', { idOrKey: 'BUG-1' })] }, { content: 'Could not.', toolCalls: [] }],
      { callResult: { text: 'HTTP 403: nope', isError: true } },
    );
    const res = await run(service);
    expect(res.content).toBe('Could not.');
    expect(res.activity?.steps).toEqual([{ kind: 'write', label: 'Deleted issue', ok: false, detail: 'HTTP 403: nope' }]);
  });

  it('enforces a daily write budget per user', async () => {
    const { service, tools } = setup([]);
    const spend = (service as unknown as { spendWrite(u: string): boolean }).spendWrite.bind(service);
    let granted = 0;
    while (spend('usr_budget')) granted++;
    expect(granted).toBe(200);
    expect(spend('usr_other')).toBe(true); // budgets are per user
    expect(tools).not.toHaveBeenCalled();
  });
});
