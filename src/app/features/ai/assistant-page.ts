import { ChangeDetectionStrategy, Component, effect, inject, viewChild } from '@angular/core';
import { LucideDynamicIcon, LucideSquarePen, LucideTrash2 } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { AssistantStore } from '../../core/ai/assistant.store';
import { AssistantChat } from './assistant-chat';

/** Full-page assistant: the same chats as the floating popup, with room for long conversations. */
@Component({
  selector: 'app-assistant-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideDynamicIcon, HlmButtonImports, AssistantChat],
  host: { class: 'flex h-full min-h-0 flex-col' },
  template: `
    @if (!ai.active()) {
      <div class="flex h-12 shrink-0 items-center border-b px-4">
        <h1 class="text-sm font-medium">New chat</h1>
      </div>
    }
    @if (ai.active(); as chat) {
      <div class="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <h1 class="min-w-0 flex-1 truncate text-sm font-medium">{{ chat.title }}</h1>
        <button
          hlmBtn
          variant="ghost"
          size="sm"
          class="text-muted-foreground"
          (click)="ai.deleteChat(chat.id)"
        >
          <svg [lucideIcon]="deleteIcon" [size]="14"></svg> Delete
        </button>
        <button hlmBtn variant="ghost" size="sm" (click)="ai.newChat()">
          <svg [lucideIcon]="newIcon" [size]="14"></svg> New chat
        </button>
      </div>
    }
    <app-assistant-chat [page]="true" />
  `,
})
export class AssistantPage {
  protected readonly ai = inject(AssistantStore);
  private readonly chat = viewChild(AssistantChat);
  protected readonly newIcon = LucideSquarePen;
  protected readonly deleteIcon = LucideTrash2;

  constructor() {
    // The page opens on a fresh chat (with the history underneath) unless the popup handed one over
    // or a reply is still on its way.
    if (!this.ai.handoverToPage && !this.ai.busy()) this.ai.newChat();
    this.ai.handoverToPage = false;
    effect(() => {
      if (this.chat()) queueMicrotask(() => this.chat()?.focusComposer());
    });
  }
}
