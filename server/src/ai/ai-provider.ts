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

export abstract class AiProvider {
  abstract complete(
    messages: AiMessage[],
    signal: AbortSignal,
    userId?: string,
  ): Promise<string>;
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
    const provider = this.config.provider();
    try {
      const response = await fetch(provider.url, {
        method: 'POST',
        redirect: 'error',
        headers: {
          Authorization: `Bearer ${provider.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: provider.model,
          messages,
          max_tokens: 1200,
          stream: false,
        }),
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
      const body = record(JSON.parse(text));
      const choices = body?.['choices'];
      const choice = Array.isArray(choices) ? record(choices[0]) : null;
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
