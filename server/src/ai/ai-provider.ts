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
  ): Promise<AiToolTurn> {
    const body = await this.post(
      {
        messages: messages.map(toWireMessage),
        tools: tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.parameters },
        })),
        tool_choice: 'auto',
        max_tokens: 2000,
      },
      signal,
    );
    const choice = this.firstChoice(body);
    const message = record(choice?.['message']);
    if (choice?.['finish_reason'] === 'length')
      throw new BadGatewayException(
        'The AI response was cut short. Try a smaller request.',
      );
    const content = typeof message?.['content'] === 'string' ? message['content'].trim() : '';
    const raw = message?.['tool_calls'];
    const toolCalls: AiToolCall[] = [];
    if (Array.isArray(raw)) {
      for (const entry of raw) {
        const call = record(entry);
        const fn = record(call?.['function']);
        if (typeof call?.['id'] !== 'string' || typeof fn?.['name'] !== 'string')
          throw new BadGatewayException('The AI provider returned an invalid tool call.');
        toolCalls.push({
          id: call['id'],
          name: fn['name'],
          arguments: typeof fn['arguments'] === 'string' ? fn['arguments'] : '{}',
        });
      }
    }
    if ((!content && !toolCalls.length) || content.length > 16000)
      throw new BadGatewayException('The AI provider returned an invalid response.');
    return { content, toolCalls };
  }

  private firstChoice(body: Record<string, unknown> | null): Record<string, unknown> | null {
    const choices = body?.['choices'];
    return Array.isArray(choices) ? record(choices[0]) : null;
  }

  /** POSTs a Chat Completions request (size-bounded, no redirects) and maps failures to safe errors. */
  private async post(
    payload: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Record<string, unknown> | null> {
    const provider = this.config.provider();
    try {
      const response = await fetch(provider.url, {
        method: 'POST',
        redirect: 'error',
        headers: {
          Authorization: `Bearer ${provider.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: provider.model, stream: false, ...payload }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
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
      const reader = response.body?.getReader();
      if (!reader)
        throw new BadGatewayException(
          'The AI provider returned an empty response.',
        );
      let text = '';
      let bytes = 0;
      const decoder = new TextDecoder();
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 256_000) {
            await reader.cancel();
            throw new BadGatewayException('The AI response is too large.');
          }
          text += decoder.decode(chunk.value, { stream: true });
        }
      } finally {
        reader.releaseLock();
      }
      text += decoder.decode();
      return record(JSON.parse(text));
    } catch (error) {
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
  }
}

function toWireMessage(m: AiTurnMessage): Record<string, unknown> {
  if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
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
