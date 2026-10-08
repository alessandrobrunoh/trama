import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  effect,
  inject,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import {
  LucideArrowUp,
  LucideDynamicIcon,
  LucideMaximize2,
  LucideMessageSquare,
  LucideMinimize2,
  LucidePlus,
  LucideSquare,
  LucideX,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { AssistantStore } from '../../core/ai/assistant.store';

@Component({
  selector: 'app-assistant-overlay',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, RouterLink, LucideDynamicIcon, HlmButtonImports],
  template: `
    @if (ai.open()) {
      <section
        id="nabla-assistant"
        role="dialog"
        aria-modal="false"
        aria-labelledby="assistant-title"
        class="assistant-panel bg-popover text-popover-foreground fixed z-40 flex flex-col overflow-hidden rounded-xl border shadow-xl"
        [class.expanded]="ai.expanded()"
        (keydown.escape)="close($event)"
      >
        <header class="flex h-12 shrink-0 items-center gap-2 border-b px-3">
          <svg [lucideIcon]="chatIcon" [size]="16" class="text-muted-foreground"></svg>
          <h2 id="assistant-title" class="flex-1 text-sm font-medium">Nabla assistant</h2>
          <button
            hlmBtn
            variant="ghost"
            size="icon"
            class="size-7"
            aria-label="New chat"
            title="New chat"
            (click)="ai.newChat(); focusComposer()"
          >
            <svg [lucideIcon]="plusIcon" [size]="15"></svg>
          </button>
          <button
            hlmBtn
            variant="ghost"
            size="icon"
            class="size-7"
            [attr.aria-label]="ai.expanded() ? 'Shrink chat' : 'Expand chat'"
            [attr.aria-pressed]="ai.expanded()"
            (click)="ai.expanded.set(!ai.expanded())"
          >
            <svg [lucideIcon]="ai.expanded() ? shrinkIcon : expandIcon" [size]="15"></svg>
          </button>
          <button
            hlmBtn
            variant="ghost"
            size="icon"
            class="size-7"
            aria-label="Close chat"
            (click)="close()"
          >
            <svg [lucideIcon]="closeIcon" [size]="16"></svg>
          </button>
        </header>

        <div
          #conversation
          class="min-h-0 flex-1 space-y-5 overflow-y-auto p-4"
          role="log"
          aria-label="Conversation"
          aria-live="polite"
          aria-relevant="additions text"
        >
          @if (!ai.messages().length) {
            <div class="flex min-h-48 flex-col justify-center gap-3 py-6">
              <h3 class="text-base font-medium">A little help with your work</h3>
              <p class="text-muted-foreground text-sm leading-relaxed">
                Ask a question, improve a draft, or summarize the item you have open.
              </p>
              @if (ai.ready()) {
                @for (prompt of prompts; track prompt) {
                  <button
                    type="button"
                    class="hover:bg-accent rounded-lg border px-3 py-2 text-left text-xs"
                    (click)="ai.draft.set(prompt); focusComposer()"
                  >
                    {{ prompt }}
                  </button>
                }
              }
            </div>
          }
          @for (message of ai.messages(); track $index) {
            <article [class]="message.role === 'user' ? 'bg-muted ml-5 rounded-xl p-3' : 'pr-2'">
              <div class="text-muted-foreground mb-1 text-[11px] font-medium">
                {{ message.role === 'user' ? 'You' : 'Nabla' }}
              </div>
              <p class="m-0 whitespace-pre-wrap break-words text-sm leading-relaxed">
                {{ message.content }}
              </p>
            </article>
          }
          @if (ai.busy()) {
            <p class="text-muted-foreground text-xs" role="status">Thinking…</p>
          }
        </div>

        <div class="space-y-2 border-t p-3">
          @if (ai.error() || ai.statusError()) {
            <p class="text-destructive text-xs" role="alert">
              {{ ai.error() || ai.statusError() }}
            </p>
          }
          @if (ai.loadingStatus()) {
            <p class="text-muted-foreground text-xs" role="status">Checking AI connection…</p>
          } @else if (!ai.ready()) {
            <p class="text-muted-foreground text-xs">
              AI is not available yet.
              <a
                [routerLink]="['/', ai.slug(), 'settings', 'ai']"
                class="underline"
                (click)="close()"
                >Open AI settings</a
              >
            </p>
          }
          <label
            for="assistant-share-context"
            class="text-muted-foreground flex items-center gap-2 text-xs"
          >
            <input
              id="assistant-share-context"
              type="checkbox"
              [ngModel]="ai.shareContext()"
              (ngModelChange)="ai.shareContext.set($event)"
            />
            <span class="truncate">Include {{ ai.context().label }}</span>
          </label>
          <p id="assistant-context-hint" class="text-muted-foreground text-[11px]">
            {{
              ai.shareContext()
                ? ai.context().kind === 'page'
                  ? 'Shares the page name only.'
                  : 'Shares this item’s details with the AI provider.'
                : 'No current page data will be added.'
            }}
            Earlier messages remain in this chat.
          </p>
          <form (submit)="send($event)" class="bg-muted/50 rounded-lg border p-2">
            <textarea
              #composer
              aria-label="Message Nabla assistant"
              aria-describedby="assistant-context-hint"
              rows="3"
              maxlength="8000"
              class="placeholder:text-muted-foreground w-full resize-none bg-transparent text-sm focus-visible:outline focus-visible:outline-1 focus-visible:outline-ring"
              placeholder="Ask Nabla…"
              name="message"
              [ngModel]="ai.draft()"
              (ngModelChange)="ai.draft.set($event)"
              [disabled]="!ai.ready() || ai.busy()"
              (keydown)="onComposerKey($event)"
            ></textarea>
            <div class="flex items-center justify-between gap-2">
              <span class="text-muted-foreground truncate text-[11px]">{{
                ai.status()?.suggestions?.model ?? 'AI not configured'
              }}</span>
              @if (ai.busy()) {
                <button
                  hlmBtn
                  type="button"
                  size="icon"
                  variant="outline"
                  class="size-7 rounded-full"
                  aria-label="Stop response"
                  (click)="ai.stop()"
                >
                  <svg [lucideIcon]="stopIcon" [size]="12"></svg>
                </button>
              } @else {
                <button
                  hlmBtn
                  type="submit"
                  size="icon"
                  class="size-7 rounded-full"
                  aria-label="Send message"
                  [disabled]="!ai.ready() || !ai.draft().trim()"
                >
                  <svg [lucideIcon]="sendIcon" [size]="14"></svg>
                </button>
              }
            </div>
          </form>
          <p class="text-muted-foreground text-center text-[10px]">
            AI can make mistakes. Review suggestions before using them.
          </p>
        </div>
      </section>
    }
    <button
      #launcher
      hlmBtn
      variant="outline"
      class="bg-popover fixed right-5 bottom-4 z-40 h-8 gap-2 rounded-full shadow-md"
      aria-controls="nabla-assistant"
      [attr.aria-expanded]="ai.open()"
      (click)="toggle()"
    >
      <svg [lucideIcon]="chatIcon" [size]="14"></svg> Assistant
    </button>
  `,
  styles: `
    .assistant-panel {
      right: 1rem;
      bottom: 3.75rem;
      width: min(440px, calc(100vw - 2rem));
      height: min(640px, calc(100dvh - 5rem));
    }
    .assistant-panel.expanded {
      width: min(760px, calc(100vw - 2rem));
      height: calc(100dvh - 5rem);
    }
    @media (pointer: coarse) {
      button {
        min-height: 36px;
        min-width: 36px;
      }
    }
    @media (max-width: 600px) {
      .assistant-panel {
        right: 0.5rem;
        width: calc(100vw - 1rem);
        height: calc(100dvh - 5rem);
      }
    }
  `,
})
export class AssistantOverlay {
  protected readonly ai = inject(AssistantStore);
  private readonly composer = viewChild<ElementRef<HTMLTextAreaElement>>('composer');
  private readonly launcher = viewChild<ElementRef<HTMLButtonElement>>('launcher');
  private readonly conversation = viewChild<ElementRef<HTMLElement>>('conversation');
  protected readonly chatIcon = LucideMessageSquare;
  protected readonly plusIcon = LucidePlus;
  protected readonly expandIcon = LucideMaximize2;
  protected readonly shrinkIcon = LucideMinimize2;
  protected readonly closeIcon = LucideX;
  protected readonly sendIcon = LucideArrowUp;
  protected readonly stopIcon = LucideSquare;
  protected readonly prompts = [
    'Summarize this item',
    'What information is missing?',
    'Help me write a clearer description',
  ];

  constructor() {
    inject(DestroyRef).onDestroy(() => this.ai.stop());
    effect(() => {
      this.ai.messages();
      this.ai.busy();
      const element = this.conversation()?.nativeElement;
      if (element)
        queueMicrotask(() => {
          element.scrollTop = element.scrollHeight;
        });
    });
    effect(() => {
      if (this.ai.open() && this.composer()) queueMicrotask(() => this.focusComposer());
    });
  }

  protected toggle(): void {
    if (this.ai.open()) this.close();
    else this.ai.open.set(true);
  }
  protected close(event?: Event): void {
    event?.stopPropagation();
    this.ai.open.set(false);
    this.launcher()?.nativeElement.focus();
  }
  protected focusComposer(): void {
    this.composer()?.nativeElement.focus();
  }
  protected send(event: Event): void {
    event.preventDefault();
    void this.ai.send();
  }
  protected onComposerKey(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) this.send(event);
  }
}
