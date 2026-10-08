import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  signal,
  inject,
  viewChild,
} from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import {
  LucideDynamicIcon,
  LucideHistory,
  LucideMaximize2,
  LucideMessageSquare,
  LucideMinus,
  LucideX,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { AssistantStore } from '../../core/ai/assistant.store';
import { AssistantChat, timeAgo } from './assistant-chat';

/**
 * Floating assistant: a popup anchored to a thin dock at the bottom right. The dock lists the
 * latest chats, so a conversation can be resumed in one click; the full list lives on the
 * assistant page.
 */
@Component({
  selector: 'app-assistant-overlay',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, LucideDynamicIcon, HlmButtonImports, AssistantChat],
  template: `
    @if (ai.open() && !ai.onAssistantPage()) {
      <section
        id="nabla-assistant"
        role="dialog"
        aria-modal="false"
        aria-labelledby="assistant-title"
        class="assistant-panel bg-popover text-popover-foreground fixed z-40 flex flex-col overflow-hidden rounded-lg border shadow-lg"
        (keydown.escape)="minimize($event)"
      >
        <header class="flex h-12 shrink-0 items-center gap-1 border-b px-3">
          <h2 id="assistant-title" class="min-w-0 flex-1 truncate text-sm font-medium">
            {{ ai.active()?.title ?? 'New chat' }}
          </h2>
          <button
            hlmBtn
            variant="ghost"
            size="icon"
            class="text-muted-foreground size-7"
            aria-label="Minimize chat"
            title="Minimize"
            (click)="minimize()"
          >
            <svg [lucideIcon]="minimizeIcon" [size]="14"></svg>
          </button>
          <button
            hlmBtn
            variant="ghost"
            size="icon"
            class="text-muted-foreground size-7"
            aria-label="Open full page"
            title="Open full page"
            (click)="expand()"
          >
            <svg [lucideIcon]="expandIcon" [size]="14"></svg>
          </button>
          <button
            hlmBtn
            variant="ghost"
            size="icon"
            class="text-muted-foreground size-7"
            aria-label="Close chat"
            title="Close"
            (click)="closeChat()"
          >
            <svg [lucideIcon]="closeIcon" [size]="15"></svg>
          </button>
        </header>
        <app-assistant-chat (navigated)="minimize()" />
      </section>
    }

    @if (!ai.onAssistantPage()) {
      <div
        class="bg-popover text-muted-foreground fixed right-4 bottom-4 z-30 flex h-8 items-center gap-0.5 rounded-md border px-1 text-xs shadow-md max-md:hidden"
      >
        @for (chat of dockChats(); track chat.id) {
          <button
            type="button"
            class="hover:bg-accent hover:text-foreground h-6 max-w-44 truncate rounded px-2"
            [class.bg-accent]="ai.open() && ai.activeId() === chat.id"
            [class.text-foreground]="ai.open() && ai.activeId() === chat.id"
            [attr.aria-label]="'Open chat: ' + chat.title"
            (click)="resume(chat.id)"
          >
            @if (chat.unread) {
              <span
                class="bg-primary mr-1.5 inline-block size-1.5 rounded-full align-middle"
                aria-label="Unread"
              ></span>
            }
            <span class="truncate">{{ chat.title }}</span>
          </button>
        }
        <button
          #launcher
          type="button"
          id="desktop-assistant-launcher"
          class="hover:bg-accent text-foreground inline-flex h-6 items-center gap-1.5 rounded px-2"
          [class.bg-accent]="ai.open() && !activeInDock()"
          aria-controls="nabla-assistant"
          [attr.aria-expanded]="ai.open()"
          (click)="toggle()"
        >
          <svg [lucideIcon]="chatIcon" [size]="14"></svg> Assistant
        </button>
        <button
          type="button"
          class="hover:bg-accent hover:text-foreground inline-flex size-6 items-center justify-center rounded"
          [class.bg-accent]="historyOpen()"
          aria-label="Chat history"
          title="Chat history"
          aria-haspopup="true"
          [attr.aria-expanded]="historyOpen()"
          (click)="historyOpen.set(!historyOpen())"
        >
          <svg [lucideIcon]="historyIcon" [size]="14"></svg>
        </button>
      </div>

      @if (historyOpen()) {
        <div class="fixed inset-0 z-40" aria-hidden="true" (click)="historyOpen.set(false)"></div>
        <div
          role="menu"
          aria-label="Chat history"
          class="bg-popover text-popover-foreground fixed right-4 bottom-16 z-50 w-96 max-w-[calc(100vw-2rem)] rounded-lg border p-1 shadow-md"
          (keydown.escape)="historyOpen.set(false)"
        >
          <div class="text-muted-foreground px-3 py-2 text-xs">Chat history</div>
          @for (chat of ai.chats(); track chat.id) {
            <button
              type="button"
              role="menuitem"
              class="hover:bg-accent flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm"
              (click)="openFromHistory(chat.id)"
            >
              <span
                class="size-1.5 shrink-0 rounded-full"
                [class.bg-primary]="ai.activeId() === chat.id || chat.unread"
                aria-hidden="true"
              ></span>
              <span class="min-w-0 flex-1 truncate" [class.font-medium]="chat.unread">{{
                chat.title
              }}</span>
              <span class="text-muted-foreground shrink-0 text-xs">{{ ago(chat.updatedAt) }}</span>
            </button>
          } @empty {
            <p class="text-muted-foreground px-3 py-3 text-sm">No chats yet.</p>
          }
          <a
            [routerLink]="['/', ai.slug(), 'assistant']"
            class="text-muted-foreground hover:bg-accent hover:text-foreground mt-1 block rounded-md border-t px-3 py-2 text-xs"
            (click)="historyOpen.set(false); ai.open.set(false)"
            >Open full page</a
          >
        </div>
      }
    }
  `,
  styles: `
    .assistant-panel {
      right: 1rem;
      bottom: 4rem;
      width: min(400px, calc(100vw - 2rem));
      height: min(600px, calc(100dvh - 5rem));
    }
    @media (pointer: coarse) {
      button,
      a {
        min-height: 36px;
        min-width: 36px;
      }
    }
    @media (max-width: 767px) {
      .assistant-panel {
        right: 0.5rem;
        bottom: 4.5rem;
        width: calc(100vw - 1rem);
        height: calc(100dvh - 7rem);
      }
    }
  `,
})
export class AssistantOverlay {
  protected readonly ai = inject(AssistantStore);
  private readonly document = inject(DOCUMENT);
  private readonly router = inject(Router);
  private readonly launcher = viewChild<{ nativeElement: HTMLButtonElement }>('launcher');
  private readonly chat = viewChild(AssistantChat);
  protected readonly chatIcon = LucideMessageSquare;
  protected readonly historyIcon = LucideHistory;
  protected readonly minimizeIcon = LucideMinus;
  protected readonly expandIcon = LucideMaximize2;
  protected readonly closeIcon = LucideX;
  protected readonly historyOpen = signal(false);
  protected readonly ago = timeAgo;
  protected readonly dockChats = computed(() => {
    const chats = this.ai.chats();
    return this.ai
      .dock()
      .map((id) => chats.find((c) => c.id === id))
      .filter((c) => !!c);
  });
  protected readonly activeInDock = computed(() =>
    this.dockChats().some((c) => c.id === this.ai.activeId()),
  );

  constructor() {
    inject(DestroyRef).onDestroy(() => this.ai.stop());
    effect(() => {
      if (this.ai.open() && this.chat()) queueMicrotask(() => this.chat()?.focusComposer());
    });
  }

  protected toggle(): void {
    if (this.ai.open()) this.minimize();
    else this.ai.open.set(true);
  }

  protected openFromHistory(id: string): void {
    this.historyOpen.set(false);
    this.ai.openChat(id);
    this.ai.open.set(true);
  }

  protected resume(id: string): void {
    if (this.ai.open() && this.ai.activeId() === id) {
      this.minimize();
      return;
    }
    this.ai.openChat(id);
    this.ai.open.set(true);
  }

  /** Hides the popup; the chat stays selected and in the dock. */
  protected minimize(event?: Event): void {
    event?.stopPropagation();
    this.ai.open.set(false);
    const mobileLauncher = this.document.getElementById('mobile-assistant-launcher');
    if (mobileLauncher?.getClientRects().length) {
      mobileLauncher.focus();
    } else {
      this.launcher()?.nativeElement.focus();
    }
  }

  /** Closes the popup and removes the chat's chip; the chat stays in the history. */
  protected closeChat(): void {
    const id = this.ai.activeId();
    this.ai.newChat();
    if (id) this.ai.unpin(id);
    this.ai.open.set(false);
    this.historyOpen.set(false);
  }

  protected expand(): void {
    this.ai.open.set(false);
    void this.router.navigate(['/', this.ai.slug(), 'assistant']);
  }
}
