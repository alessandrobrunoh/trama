import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiConfig } from './ai.config.js';
import { ChatCompletionsProvider } from './ai-provider.js';
import type { GrokBuildService } from './grok-build.service.js';

const grok = { status: async () => ({ connected: false }) } as unknown as GrokBuildService;

function sse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}
const data = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;

describe('ChatCompletionsProvider.completeWithTools', () => {
  beforeEach(() => {
    process.env.AI_API_URL = 'https://ai.example/v1';
    process.env.AI_API_KEY = 'k';
    process.env.AI_MODEL = 'm';
  });
  afterEach(() => vi.unstubAllGlobals());

  const provider = () => new ChatCompletionsProvider(new AiConfig(), grok);
  const run = (onText?: (d: string) => void) =>
    provider().completeWithTools([{ role: 'user', content: 'hi' }], [{ name: 't', description: '', parameters: {} }], new AbortController().signal, 'u', onText);

  it('streams text deltas and reassembles tool calls split across chunks and lines', async () => {
    const lines = [
      data({ choices: [{ delta: { content: 'Look' } }] }),
      // a line cut in the middle between two network chunks
      `data: {"choices":[{"delta":{"content":"ing"}}]}`,
      `\n\n`,
      data({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'list_', arguments: '{"a"' } }] } }] }),
      data({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'issues', arguments: ':1}' } }] }, finish_reason: 'tool_calls' }] }),
      'data: [DONE]\n\n',
    ];
    const fetchMock = vi.fn(async () => sse(lines));
    vi.stubGlobal('fetch', fetchMock);
    const deltas: string[] = [];
    const turn = await run((d) => deltas.push(d));
    expect(deltas.join('')).toBe('Looking');
    expect(turn.content).toBe('Looking');
    expect(turn.toolCalls).toEqual([{ id: 'c1', name: 'list_issues', arguments: '{"a":1}' }]);
    const sent = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body);
    expect(sent.stream).toBe(true);
    expect(sent.tools).toHaveLength(1);
  });

  it('without a listener it uses a plain request and parses the same shape', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ choices: [{ message: { content: 'x', tool_calls: [{ id: 'c', function: { name: 'n', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const turn = await run();
    expect(turn.toolCalls).toEqual([{ id: 'c', name: 'n', arguments: '{}' }]);
    expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body).stream).toBe(false);
  });

  it('rejects a truncated stream, empty replies and provider errors with safe messages', async () => {
    vi.stubGlobal('fetch', async () => sse([data({ choices: [{ delta: { content: 'cut' }, finish_reason: 'length' }] })]));
    await expect(run((d) => d)).rejects.toThrow(/cut short/);
    vi.stubGlobal('fetch', async () => sse([data({ choices: [{ delta: {} }] })]));
    await expect(run((d) => d)).rejects.toThrow(/invalid response/);
    vi.stubGlobal('fetch', async () => new Response('secret upstream body', { status: 429 }));
    await expect(run((d) => d)).rejects.toThrow(/busy or its usage limit/);
    vi.stubGlobal('fetch', async () => new Response('secret upstream body', { status: 500 }));
    await expect(run()).rejects.not.toThrow(/secret/);
  });
});
