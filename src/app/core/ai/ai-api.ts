import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom, fromEvent, takeUntil } from 'rxjs';
import { ApiClient } from '../api/api-client';
import { ApiError } from '../api/api-error';
import { CLIENT_ID } from '../sync/client-id';

export interface AiStatus {
  suggestions: { configured: boolean; model: string | null };
  supergrok: {
    available: boolean;
    connected: boolean;
    login: { code: string | null; url: string | null; error: string | null } | null;
  };
  chatgpt: { status: 'unavailable'; reason: string };
  /** The assistant can use tools (read and change the workspace) for this user. */
  assistantTools?: { enabled: boolean };
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
  issueOptions?: AiIssueDraftOptions;
}
export interface AiIssueDraftOptions {
  kinds: string[];
  priorities: string[];
  estimates: number[];
  teams: { id: string; label: string }[];
  assignees: { id: string; label: string }[];
  workstreams: { id: string; key: string; title: string; objective: string }[];
  similar: {
    key: string;
    title: string;
    kind: string;
    priority: string;
    estimate: number | null;
    cycleDays: number | null;
  }[];
}
export type AiIssueDraftSuggestion =
  | { field: 'priority'; value: string; why: string }
  | { field: 'kind'; value: string; why: string }
  | { field: 'estimate'; value: number; why: string }
  | { field: 'teamId'; value: string; label: string; why: string }
  | { field: 'assigneeId'; value: string; label: string; why: string }
  | { field: 'workstreamId'; value: string; label: string; why: string };
export interface AiIssueDraftTriage {
  suggestions: AiIssueDraftSuggestion[];
}
export interface AiSuggestion {
  title: string;
  description: string;
  questions: string[];
  triage?: AiIssueDraftTriage;
}
/** One thing the assistant did while preparing a reply. */
export interface ActivityStep {
  kind: 'note' | 'read' | 'write';
  label: string;
  /** False when the step failed or was refused (always present on writes). */
  ok?: boolean;
  /** Consecutive identical steps are merged. */
  count?: number;
  /** Failed steps: why, in the API's words. */
  detail?: string;
}
export interface AssistantActivity {
  seconds: number;
  steps: ActivityStep[];
}
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  /** Assistant replies only; never sent back to the server. */
  activity?: AssistantActivity;
}
/** What the server streams while it prepares a reply. */
export type ChatStreamEvent =
  | { type: 'working'; label: string }
  | { type: 'step'; index: number; step: ActivityStep }
  | { type: 'text'; delta: string }
  | { type: 'reset' }
  | { type: 'done'; content: string; activity?: AssistantActivity }
  | { type: 'error'; message: string };

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
    return this.post<{ content: string; activity?: AssistantActivity }>(
      slug,
      'chat',
      { messages: messages.map(({ role, content }) => ({ role, content })), context },
      signal,
    );
  }

  /**
   * Like `chat`, but reports progress as it happens (steps, text as it is written) through
   * `onEvent`. Resolves with the final reply; rejects with the server's message on failure.
   */
  async chatStream(
    slug: string,
    messages: ChatMessage[],
    context: ChatContext | undefined,
    signal: AbortSignal,
    onEvent: (event: ChatStreamEvent) => void,
  ): Promise<{ content: string; activity?: AssistantActivity }> {
    signal.throwIfAborted();
    let response: Response;
    try {
      response = await fetch(`${this.api.baseUrl}/w/${encodeURIComponent(slug)}/ai/chat/stream`, {
        method: 'POST',
        credentials: 'include',
        signal,
        headers: { 'Content-Type': 'application/json', 'X-Client-Id': CLIENT_ID },
        body: JSON.stringify({
          messages: messages.map(({ role, content }) => ({ role, content })),
          context,
        }),
      });
    } catch {
      if (signal.aborted) throw new DOMException('Request cancelled', 'AbortError');
      throw new ApiError(0, 'Could not reach the server.');
    }
    if (!response.ok || !response.body) {
      if (response.status === 401) this.api.sessionExpired.next();
      const body = (await response.json().catch(() => null)) as {
        message?: string | string[];
      } | null;
      const message = Array.isArray(body?.message) ? body.message.join('; ') : body?.message;
      throw new ApiError(response.status, message || 'Could not send your message.');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let result: { content: string; activity?: AssistantActivity } | null = null;
    const handle = (block: string) => {
      let name = 'message';
      let data = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) name = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (!data) return;
      const payload = JSON.parse(data) as Record<string, unknown>;
      const event = { type: name, ...payload } as ChatStreamEvent;
      if (event.type === 'error') throw new ApiError(502, event.message);
      if (event.type === 'done') result = { content: event.content, activity: event.activity };
      onEvent(event);
    };
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let end: number;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          handle(buffer.slice(0, end));
          buffer = buffer.slice(end + 2);
        }
      }
    } catch (error) {
      if (signal.aborted) throw new DOMException('Request cancelled', 'AbortError');
      throw error instanceof ApiError ? error : new ApiError(0, 'The connection was interrupted.');
    } finally {
      reader.releaseLock();
    }
    if (!result) throw new ApiError(502, 'The reply was interrupted. Try again.');
    return result;
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
