import {
  BadGatewayException,
  GatewayTimeoutException,
  HttpException,
  Injectable,
} from '@nestjs/common';
import { AiConfig } from './ai.config.js';
import { GrokBuildService } from './grok-build.service.js';

export interface AiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AiToolDef {
  name: string;
  description: string;
  /** JSON Schema of the arguments. */
  parameters: Record<string, unknown>;
}

export interface AiToolCall {
  id: string;
  name: string;
  /** Raw JSON string, exactly as the model produced it. */
  arguments: string;
}

/** Conversation items of a tool-calling turn (OpenAI Chat Completions shape). */
export type AiTurnMessage =
  | AiMessage
  | { role: 'assistant'; content: string | null; toolCalls: AiToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

export interface AiToolTurn {
  content: string;
  toolCalls: AiToolCall[];
}

export abstract class AiProvider {
  abstract complete(
    messages: AiMessage[],
    signal: AbortSignal,
    userId?: string,
  ): Promise<string>;

  /** False when the user's chat runs through a client that cannot call tools (Grok Build CLI). */
  abstract supportsTools(userId?: string): Promise<boolean>;

  /** One model turn that may answer with text, with tool calls, or (rarely) both. */
  abstract completeWithTools(
    messages: AiTurnMessage[],
    tools: AiToolDef[],
    signal: AbortSignal,
    userId?: string,
    /** Called with text as the model writes it; when given, the turn is streamed. */
    onText?: (delta: string) => void,
  ): Promise<AiToolTurn>;
}

export function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

@Injectable()
export class ChatCompletionsProvider extends AiProvider {
  constructor(
    private readonly config: AiConfig,
    private readonly grok: GrokBuildService,
  ) {
    super();
  }

  async complete(
    messages: AiMessage[],
    signal: AbortSignal,
    userId?: string,
  ): Promise<string> {
    if (userId && (await this.grok.status(userId)).connected)
      return this.grok.complete(userId, messages, signal);
    const body = await this.post({ messages, max_tokens: 1200 }, signal);
    const choice = this.firstChoice(body);
    const content = record(choice?.['message'])?.['content'];
    if (choice?.['finish_reason'] === 'length')
      throw new BadGatewayException(
        'The AI response was cut short. Try a smaller request.',
      );
    if (
      typeof content !== 'string' ||
      !content.trim() ||
      content.length > 16000
    ) {
      throw new BadGatewayException(
        'The AI provider returned an invalid response.',
      );
    }
    return content.trim();
  }

  async supportsTools(userId?: string): Promise<boolean> {
    return !(userId && (await this.grok.status(userId)).connected);
  }

  async completeWithTools(
    messages: AiTurnMessage[],
    tools: AiToolDef[],
    signal: AbortSignal,
    _userId?: string,
    onText?: (delta: string) => void,
  ): Promise<AiToolTurn> {
    const payload: Record<string, unknown> = {
      messages: messages.map(toWireMessage),
      ...(tools.length
        ? {
            tools: tools.map((t) => ({
              type: 'function',
              function: {
                name: t.name,
                description: t.description,
                parameters: t.parameters,
              },
            })),
            tool_choice: 'auto',
          }
        : {}),
      max_tokens: 2000,
    };
    let content = '';
    let finish: unknown;
    const calls = new Map<number, AiToolCall>();
    const addCall = (raw: unknown, fallbackIndex: number) => {
      const call = record(raw);
      const fn = record(call?.['function']);
      const index =
        typeof call?.['index'] === 'number' ? call['index'] : fallbackIndex;
      const current = calls.get(index) ?? { id: '', name: '', arguments: '' };
      if (typeof call?.['id'] === 'string' && call['id'])
        current.id = call['id'];
      if (typeof fn?.['name'] === 'string') current.name += fn['name'];
      if (typeof fn?.['arguments'] === 'string')
        current.arguments += fn['arguments'];
      calls.set(index, current);
    };

    if (onText) {
      await this.postStream(payload, signal, (chunk) => {
        const choice = this.firstChoice(chunk);
        const delta = record(choice?.['delta']);
        if (typeof delta?.['content'] === 'string' && delta['content']) {
          content += delta['content'];
          if (content.length <= 16000) onText(delta['content']);
        }
        const raw = delta?.['tool_calls'];
        if (Array.isArray(raw)) raw.forEach((c, i) => addCall(c, i));
        if (choice?.['finish_reason']) finish = choice['finish_reason'];
      });
    } else {
      const choice = this.firstChoice(await this.post(payload, signal));
      const message = record(choice?.['message']);
      if (typeof message?.['content'] === 'string')
        content = message['content'];
      const raw = message?.['tool_calls'];
      if (Array.isArray(raw)) raw.forEach((c, i) => addCall(c, i));
      finish = choice?.['finish_reason'];
    }

    if (finish === 'length')
      throw new BadGatewayException(
        'The AI response was cut short. Try a smaller request.',
      );
    const toolCalls = [...calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, c]) => c);
    if (toolCalls.some((c) => !c.id || !c.name))
      throw new BadGatewayException(
        'The AI provider returned an invalid tool call.',
      );
    for (const c of toolCalls) if (!c.arguments) c.arguments = '{}';
    const text = content.trim();
    if ((!text && !toolCalls.length) || text.length > 16000)
      throw new BadGatewayException(
        'The AI provider returned an invalid response.',
      );
    return { content: text, toolCalls };
  }

  private firstChoice(
    body: Record<string, unknown> | null,
  ): Record<string, unknown> | null {
    const choices = body?.['choices'];
    return Array.isArray(choices) ? record(choices[0]) : null;
  }

  /** Sends a Chat Completions request (no redirects, bounded time) and maps failures to safe errors. */
  private async send(
    payload: Record<string, unknown>,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<Response> {
    const provider = this.config.provider();
    const response = await fetch(provider.url, {
      method: 'POST',
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${provider.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: provider.model, ...payload }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 429)
        throw new HttpException(
          'The AI provider is busy or its usage limit has been reached. Try again later.',
          429,
        );
      throw new BadGatewayException(
        'The AI provider rejected the request. Check its configuration or try again later.',
      );
    }
    if (!response.body)
      throw new BadGatewayException(
        'The AI provider returned an empty response.',
      );
    return response;
  }

  private mapError(error: unknown): never {
    if (error instanceof HttpException) throw error;
    if (
      error instanceof Error &&
      (error.name === 'TimeoutError' || error.name === 'AbortError')
    ) {
      throw new GatewayTimeoutException(
        'The AI request was cancelled or timed out.',
      );
    }
    throw new BadGatewayException(
      'Could not reach the AI provider or read its response.',
    );
  }

  /** Reads a response body in decoded chunks, refusing anything over 256 kB. */
  private async *read(response: Response): AsyncGenerator<string> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 256_000) {
          await reader.cancel();
          throw new BadGatewayException('The AI response is too large.');
        }
        yield decoder.decode(chunk.value, { stream: true });
      }
      yield decoder.decode();
    } finally {
      reader.releaseLock();
    }
  }

  /** POSTs a non-streaming request and returns the parsed JSON body. */
  private async post(
    payload: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Record<string, unknown> | null> {
    try {
      const response = await this.send(
        { stream: false, ...payload },
        signal,
        30_000,
      );
      let text = '';
      for await (const part of this.read(response)) text += part;
      return record(JSON.parse(text));
    } catch (error) {
      return this.mapError(error);
    }
  }

  /**
   * POSTs a streaming request and calls `onChunk` with every parsed `data:` event (server-sent
   * events, OpenAI style). The whole stream is bounded to 90 s and 256 kB.
   */
  private async postStream(
    payload: Record<string, unknown>,
    signal: AbortSignal,
    onChunk: (chunk: Record<string, unknown>) => void,
  ): Promise<void> {
    try {
      const response = await this.send(
        { stream: true, ...payload },
        signal,
        90_000,
      );
      let buffer = '';
      const handle = (line: string) => {
        if (!line.startsWith('data:')) return;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') return;
        const parsed = record(JSON.parse(data));
        if (parsed) onChunk(parsed);
      };
      for await (const part of this.read(response)) {
        buffer += part;
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          handle(buffer.slice(0, nl).trim());
          buffer = buffer.slice(nl + 1);
        }
      }
      handle(buffer.trim());
    } catch (error) {
      return this.mapError(error);
    }
  }
}

function toWireMessage(m: AiTurnMessage): Record<string, unknown> {
  if (m.role === 'tool')
    return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
  if ('toolCalls' in m)
    return {
      role: 'assistant',
      content: m.content,
      tool_calls: m.toolCalls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: c.arguments },
      })),
    };
  return { role: m.role, content: m.content };
}
