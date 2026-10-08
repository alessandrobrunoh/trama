import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router } from '@angular/router';
import { filter, map } from 'rxjs';
import { SessionStore } from '../session/session.store';
import { NablaStore } from '../stores/nabla.store';
import { AiApi, type AiStatus, type ChatContext, type ChatMessage } from './ai-api';

@Injectable({ providedIn: 'root' })
export class AssistantStore {
  private readonly api = inject(AiApi);
  private readonly router = inject(Router);
  private readonly session = inject(SessionStore);
  private readonly store = inject(NablaStore);
  private readonly url = toSignal(
    this.router.events.pipe(
      filter((e) => e instanceof NavigationEnd),
      map((e) => e.urlAfterRedirects),
    ),
    { initialValue: this.router.url },
  );
  private controller?: AbortController;
  private revision = 0;
  private grokPoll?: ReturnType<typeof setTimeout>;
  readonly open = signal(false);
  readonly expanded = signal(false);
  readonly status = signal<AiStatus | null>(null);
  readonly statusError = signal('');
  readonly loadingStatus = signal(false);
  readonly messages = signal<ChatMessage[]>([]);
  readonly draft = signal('');
  readonly busy = signal(false);
  readonly error = signal('');
  readonly shareContext = signal(true);
  readonly slug = this.store.slug;
  readonly context = computed<ChatContext>(() => {
    const parts =
      this.router.parseUrl(this.url()).root.children['primary']?.segments.map((s) => s.path) ?? [];
    const page = parts[1] ?? 'overview';
    const id = parts[2];
    if (id && page === 'issues')
      return {
        kind: 'issue',
        id,
        label: this.store.issues().find((i) => i.key === id || i.id === id)?.key ?? id,
      };
    if (id && page === 'workstreams')
      return {
        kind: 'workstream',
        id,
        label: this.store.workstreams().find((w) => w.key === id || w.id === id)?.title ?? id,
      };
    if (id && page === 'projects')
      return {
        kind: 'project',
        id,
        label: this.store.repositories().find((p) => p.id === id)?.fullName ?? 'Project',
      };
    if (id && page === 'decisions')
      return {
        kind: 'decision',
        id,
        label: this.store.decisions().find((d) => d.key === id || d.id === id)?.title ?? id,
      };
    return {
      kind: 'page',
      label: page.charAt(0).toUpperCase() + page.slice(1).replaceAll('-', ' '),
    };
  });
  readonly ready = computed(
    () => this.status()?.suggestions.configured === true || this.status()?.supergrok.connected === true,
  );

  constructor() {
    effect(() => {
      const user = this.session.user()?.id;
      const slug = this.slug();
      untracked(() => {
        this.revision++;
        this.newChat();
        this.open.set(false);
        this.status.set(null);
        this.statusError.set('');
        this.loadingStatus.set(false);
        this.shareContext.set(true);
        if (user && slug) void this.refreshStatus();
      });
    });
  }

  async refreshStatus(): Promise<void> {
    const slug = this.slug();
    if (!slug) return;
    const revision = this.revision;
    this.loadingStatus.set(true);
    this.statusError.set('');
    try {
      const status = await this.api.status(slug);
      if (revision === this.revision) {
        this.status.set(status);
        this.pollSuperGrok(status);
      }
    } catch (error) {
      if (revision === this.revision)
        this.statusError.set(
          error instanceof Error ? error.message : 'Could not load AI settings.',
        );
    } finally {
      if (revision === this.revision) this.loadingStatus.set(false);
    }
  }

  async connectSuperGrok(): Promise<void> {
    const slug = this.slug();
    if (!slug) return;
    this.statusError.set('');
    try {
      await this.api.connectSuperGrok(slug);
      await this.refreshStatus();
    } catch (error) {
      this.statusError.set(error instanceof Error ? error.message : 'Could not start Grok login.');
    }
  }

  async disconnectSuperGrok(): Promise<void> {
    const slug = this.slug();
    if (!slug) return;
    if (this.grokPoll) clearTimeout(this.grokPoll);
    this.grokPoll = undefined;
    try {
      await this.api.disconnectSuperGrok(slug);
      await this.refreshStatus();
    } catch (error) {
      this.statusError.set(error instanceof Error ? error.message : 'Could not disconnect Grok.');
    }
  }

  private pollSuperGrok(status: AiStatus): void {
    if (this.grokPoll) clearTimeout(this.grokPoll);
    this.grokPoll = undefined;
    if (status.supergrok.connected || status.supergrok.login?.error) return;
    if (!status.supergrok.login) return;
    this.grokPoll = setTimeout(() => void this.refreshStatus(), 2500);
  }

  newChat(): void {
    this.stop();
    this.messages.set([]);
    this.draft.set('');
    this.error.set('');
  }

  stop(): void {
    if (this.busy()) {
      const pending = this.messages().at(-1);
      if (pending?.role === 'user') {
        this.draft.set(pending.content);
        this.messages.update((items) => items.slice(0, -1));
      }
    }
    this.controller?.abort();
    this.controller = undefined;
    this.busy.set(false);
  }

  async send(): Promise<void> {
    const content = this.draft().trim();
    const slug = this.slug();
    if (!content || !slug || !this.ready() || this.busy()) return;
    if (content.length > 8000) {
      this.error.set('Keep your message under 8,000 characters.');
      return;
    }
    const controller = new AbortController();
    this.controller = controller;
    const messages: ChatMessage[] = [...this.messages(), { role: 'user', content }];
    const history: ChatMessage[] = [];
    let size = 0;
    for (const message of messages.slice(-19).reverse()) {
      if (size + message.content.length > 40000) break;
      history.unshift(message);
      size += message.content.length;
    }
    this.messages.set(messages);
    this.draft.set('');
    this.error.set('');
    this.busy.set(true);
    try {
      const result = await this.api.chat(
        slug,
        history,
        this.shareContext() ? this.context() : undefined,
        controller.signal,
      );
      if (this.controller === controller)
        this.messages.update((items) => [
          ...items.slice(-99),
          { role: 'assistant', content: result.content },
        ]);
    } catch (error) {
      if (this.controller === controller && !controller.signal.aborted) {
        this.messages.update((items) => items.slice(0, -1));
        this.draft.set(content);
        this.error.set(error instanceof Error ? error.message : 'Could not send your message.');
      }
    } finally {
      if (this.controller === controller) {
        this.controller = undefined;
        this.busy.set(false);
      }
    }
  }
}
