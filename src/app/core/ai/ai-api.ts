import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom, fromEvent, takeUntil } from 'rxjs';
import { ApiClient } from '../api/api-client';
import { ApiError } from '../api/api-error';

export interface AiStatus {
  suggestions: { configured: boolean; model: string | null };
  supergrok: {
    available: boolean;
    connected: boolean;
    login: { code: string | null; url: string | null; error: string | null } | null;
  };
  chatgpt: { status: 'unavailable'; reason: string };
}
export interface SuperGrokLogin {
  connected?: boolean;
  code?: string | null;
  url?: string | null;
  error?: string | null;
}
export interface AiDraft {
  kind: 'issue' | 'workstream' | 'decision';
  title: string;
  description: string;
}
export interface AiSuggestion {
  title: string;
  description: string;
  questions: string[];
}
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}
export interface ChatContext {
  kind: 'page' | 'issue' | 'workstream' | 'project' | 'decision';
  label: string;
  id?: string;
}

@Injectable({ providedIn: 'root' })
export class AiApi {
  private readonly api = inject(ApiClient);
  private readonly http = inject(HttpClient);

  status(slug: string) {
    return this.api.request<AiStatus>('GET', `/w/${encodeURIComponent(slug)}/ai/status`);
  }

  connectSuperGrok(slug: string) {
    return this.api.request<SuperGrokLogin>(
      'POST',
      `/w/${encodeURIComponent(slug)}/ai/supergrok/login`,
    );
  }

  disconnectSuperGrok(slug: string) {
    return this.api.request<{ connected: boolean }>(
      'DELETE',
      `/w/${encodeURIComponent(slug)}/ai/supergrok/login`,
    );
  }

  suggest(slug: string, draft: AiDraft, signal: AbortSignal) {
    return this.post<AiSuggestion>(slug, 'suggestions', draft, signal);
  }

  chat(
    slug: string,
    messages: ChatMessage[],
    context: ChatContext | undefined,
    signal: AbortSignal,
  ) {
    return this.post<{ content: string }>(slug, 'chat', { messages, context }, signal);
  }

  private async post<T>(
    slug: string,
    path: string,
    body: unknown,
    signal: AbortSignal,
  ): Promise<T> {
    signal.throwIfAborted();
    try {
      return await firstValueFrom(
        this.http
          .post<T>(`${this.api.baseUrl}/w/${encodeURIComponent(slug)}/ai/${path}`, body)
          .pipe(takeUntil(fromEvent(signal, 'abort'))),
      );
    } catch (error) {
      if (signal.aborted) throw new DOMException('Request cancelled', 'AbortError');
      const normalized = ApiError.from(error);
      if (normalized.status === 401) this.api.sessionExpired.next();
      throw normalized;
    }
  }
}
