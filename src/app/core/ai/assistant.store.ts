import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router } from '@angular/router';
import { filter, map } from 'rxjs';
import { SessionStore } from '../session/session.store';
import { NablaStore } from '../stores/nabla.store';
import {
  AiApi,
  type ActivityStep,
  type AiStatus,
  type AssistantActivity,
  type ChatContext,
  type ChatMessage,
} from './ai-api';

/** One saved conversation. Kept in this browser only, per user and workspace. */
export interface AssistantChat {
  id: string;
  title: string;
  messages: ChatMessage[];
  updatedAt: number;
  /** The assistant answered while the chat was out of sight; cleared when it is opened. */
  unread?: boolean;
}

const MAX_CHATS = 30;
const MAX_MESSAGES = 100;

function isMessage(value: unknown): value is ChatMessage {
  const m = value as ChatMessage | null;
  return !!m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string';
}

function validActivity(value: unknown): value is AssistantActivity {
  const a = value as AssistantActivity | null;
  return (
    !!a &&
    typeof a.seconds === 'number' &&
    Array.isArray(a.steps) &&
    a.steps.length <= 60 &&
    a.steps.every(
      (s) =>
        !!s &&
        ['note', 'read', 'write'].includes(s.kind) &&
        typeof s.label === 'string' &&
        s.label.length <= 700,
    )
  );
}

/** Drops an activity block that does not look like one (old or edited storage). */
function cleanMessage(m: ChatMessage): ChatMessage {
  return m.activity && !validActivity(m.activity) ? { role: m.role, content: m.content } : m;
}

function titleFrom(content: string): string {
  const line = content.replace(/\s+/g, ' ').trim();
  return line.length > 60 ? `${line.slice(0, 57)}…` : line;
}

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
  /** Set when the popup expands into the full page, so the page keeps that chat instead of starting a new one. */
  handoverToPage = false;
  readonly expanded = signal(false);
  /** Chats shown as chips in the dock (opened this session, newest last). Closing one removes its chip, not the chat. */
  readonly dock = signal<string[]>([]);
  readonly status = signal<AiStatus | null>(null);
  readonly statusError = signal('');
  readonly loadingStatus = signal(false);
  /** Saved chats, newest first. */
  readonly chats = signal<AssistantChat[]>([]);
  /** Open chat; null is a fresh chat that is saved on its first message. */
  readonly activeId = signal<string | null>(null);
  readonly active = computed(() => this.chats().find((c) => c.id === this.activeId()) ?? null);
  readonly messages = computed(() => this.active()?.messages ?? []);
  readonly draft = signal('');
  readonly busy = signal(false);
  /** The reply being prepared right now: steps so far, the tool running, text as it is written. */
  readonly live = signal<{
    steps: ActivityStep[];
    working: string | null;
    text: string;
    startedAt: number;
  } | null>(null);
  readonly error = signal('');
  readonly shareContext = signal(true);
  readonly slug = this.store.slug;
  readonly onAssistantPage = computed(
    () => this.url().split(/[?#]/)[0].split('/')[2] === 'assistant',
  );
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
    () =>
      this.status()?.suggestions.configured === true || this.status()?.supergrok.connected === true,
  );

  /** True when the active chat is on screen: the popup is open or the full page is showing. */
  readonly viewing = computed(
    () => this.activeId() !== null && (this.open() || this.onAssistantPage()),
  );

  constructor() {
    effect(() => {
      const id = this.activeId();
      if (id && this.viewing()) untracked(() => this.markRead(id));
    });
    effect(() => {
      const user = this.session.user()?.id;
      const slug = this.slug();
      untracked(() => {
        this.revision++;
        this.newChat();
        this.loadChats(user, slug);
        this.open.set(false);
        this.dock.set([]);
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
    this.activeId.set(null);
    this.draft.set('');
    this.error.set('');
  }

  openChat(id: string): void {
    if (!this.chats().some((c) => c.id === id)) return;
    this.stop();
    this.activeId.set(id);
    this.pin(id);
    this.draft.set('');
    this.error.set('');
  }

  deleteChat(id: string): void {
    if (this.activeId() === id) this.newChat();
    this.unpin(id);
    this.chats.update((items) => items.filter((c) => c.id !== id));
    this.saveChats();
  }

  private markRead(id: string): void {
    if (!this.chats().some((c) => c.id === id && c.unread)) return;
    this.chats.update((items) => items.map((c) => (c.id === id ? { ...c, unread: false } : c)));
    this.saveChats();
  }

  /** Removes a chat's chip from the dock; the chat stays in the history. */
  unpin(id: string): void {
    this.dock.update((ids) => ids.filter((x) => x !== id));
  }

  private pin(id: string): void {
    this.dock.update((ids) => [...ids.filter((x) => x !== id), id].slice(-2));
  }

  stop(): void {
    const id = this.activeId();
    if (this.busy() && id) {
      const pending = this.messages().at(-1);
      if (pending?.role === 'user') {
        this.draft.set(pending.content);
        this.removeLastMessage(id);
      }
    }
    this.controller?.abort();
    this.controller = undefined;
    this.busy.set(false);
    this.live.set(null);
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
    const chatId = this.activeId() ?? crypto.randomUUID();
    const messages: ChatMessage[] = [...this.messages(), { role: 'user', content }];
    const history: ChatMessage[] = [];
    let size = 0;
    for (const message of messages.slice(-19).reverse()) {
      if (size + message.content.length > 40000) break;
      history.unshift(message);
      size += message.content.length;
    }
    this.writeChat(chatId, messages);
    this.activeId.set(chatId);
    this.pin(chatId);
    this.draft.set('');
    this.error.set('');
    this.busy.set(true);
    this.live.set({ steps: [], working: null, text: '', startedAt: Date.now() });
    const update = (change: (live: NonNullable<ReturnType<typeof this.live>>) => void) =>
      this.live.update((live) => {
        if (!live || this.controller !== controller) return live;
        const next = { ...live, steps: [...live.steps] };
        change(next);
        return next;
      });
    try {
      const result = await this.api.chatStream(
        slug,
        history,
        this.shareContext() ? this.context() : undefined,
        controller.signal,
        (event) => {
          switch (event.type) {
            case 'working':
              update((l) => (l.working = event.label));
              break;
            case 'step':
              update((l) => {
                l.steps[event.index] = event.step;
                l.working = null;
              });
              break;
            case 'text':
              update((l) => (l.text += event.delta));
              break;
            case 'reset':
              update((l) => (l.text = ''));
              break;
          }
        },
      );
      if (this.controller === controller)
        this.writeChat(
          chatId,
          [
            ...messages,
            {
              role: 'assistant',
              content: result.content,
              ...(result.activity ? { activity: result.activity } : {}),
            },
          ],
          !(this.activeId() === chatId && this.viewing()),
        );
    } catch (error) {
      if (this.controller === controller && !controller.signal.aborted) {
        this.removeLastMessage(chatId);
        this.draft.set(content);
        this.error.set(error instanceof Error ? error.message : 'Could not send your message.');
      }
    } finally {
      if (this.controller === controller) {
        this.controller = undefined;
        this.busy.set(false);
        this.live.set(null);
      }
    }
  }

  /** Replaces a chat's messages (creating it if new) and moves it to the top of the list. */
  private writeChat(id: string, messages: ChatMessage[], unread = false): void {
    const kept = messages.slice(-MAX_MESSAGES);
    this.chats.update((items) => {
      const current = items.find((c) => c.id === id);
      const title = current?.title || titleFrom(kept.find((m) => m.role === 'user')?.content ?? '');
      const chat: AssistantChat = {
        id,
        title: title || 'New chat',
        messages: kept,
        updatedAt: Date.now(),
        unread,
      };
      return [chat, ...items.filter((c) => c.id !== id)].slice(0, MAX_CHATS);
    });
    this.saveChats();
  }

  /** Drops the last message; an emptied chat is removed so it does not linger in the history. */
  private removeLastMessage(id: string): void {
    const chat = this.chats().find((c) => c.id === id);
    if (!chat) return;
    const messages = chat.messages.slice(0, -1);
    if (!messages.length) {
      this.chats.update((items) => items.filter((c) => c.id !== id));
      if (this.activeId() === id) this.activeId.set(null);
      this.saveChats();
    } else {
      this.chats.update((items) => items.map((c) => (c.id === id ? { ...c, messages } : c)));
      this.saveChats();
    }
  }

  private storageKey: string | null = null;

  private loadChats(user: string | undefined, slug: string | null | undefined): void {
    this.storageKey = user && slug ? `trama.assistant.chats.${user}.${slug}` : null;
    let chats: AssistantChat[] = [];
    if (this.storageKey) {
      try {
        const parsed: unknown = JSON.parse(localStorage.getItem(this.storageKey) ?? '[]');
        if (Array.isArray(parsed))
          chats = parsed
            .filter(
              (c): c is AssistantChat =>
                !!c &&
                typeof c.id === 'string' &&
                typeof c.title === 'string' &&
                typeof c.updatedAt === 'number' &&
                Array.isArray(c.messages) &&
                c.messages.length > 0 &&
                c.messages.every(isMessage),
            )
            .slice(0, MAX_CHATS)
            .map((c) => ({ ...c, messages: c.messages.map(cleanMessage) }));
      } catch {
        chats = [];
      }
    }
    this.chats.set(chats);
  }

  private saveChats(): void {
    if (!this.storageKey) return;
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(this.chats()));
    } catch {
      // Storage can be full or blocked; the chat still works for this session.
    }
  }
}
