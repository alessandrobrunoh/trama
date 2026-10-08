import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  effect,
  computed,
  inject,
  input,
  signal,
  output,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import {
  LucideArrowUp,
  LucideChevronRight,
  LucideDynamicIcon,
  LucideFileText,
  LucideSquare,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { AssistantStore } from '../../core/ai/assistant.store';
import { EntityRefs } from '../../shared/entity-ref';
import { Markdown } from '../../shared/markdown';
import { ActivitySteps } from './activity-steps';

/** Compact relative time: now, 5m, 3h, 2d, 4mo. */
export function timeAgo(time: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - time) / 60000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return days < 30 ? `${days}d` : `${Math.round(days / 30)}mo`;
}

/**
 * Conversation + composer shared by the floating popup and the full-page assistant.
 * `page` centres the composer on an empty chat and lists recent chats beneath it.
 */
@Component({
  selector: 'app-assistant-chat',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, RouterLink, LucideDynamicIcon, HlmButtonImports, Markdown, ActivitySteps],
  host: { class: 'flex min-h-0 flex-1 flex-col' },
  template: `
    @if (ai.messages().length || !page()) {
      <div
        #conversation
        class="min-h-0 flex-1 overflow-y-auto"
        role="log"
        aria-label="Conversation"
        aria-live="polite"
        aria-relevant="additions text"
      >
        <div class="mx-auto w-full space-y-5 px-4 py-4" [class.max-w-3xl]="page()">
          @if (!ai.messages().length) {
            <div class="flex min-h-40 flex-col justify-center gap-2 py-4">
              <h3 class="text-sm font-medium">A little help with your work</h3>
              <p class="text-muted-foreground text-sm leading-relaxed">
                Ask a question, improve a draft, or summarize the item you have open.
              </p>
              @if (ai.ready()) {
                <div class="mt-2 flex flex-col gap-2">
                  @for (prompt of prompts; track prompt) {
                    <button
                      type="button"
                      class="hover:bg-accent rounded-md border px-3 py-2 text-left text-xs"
                      (click)="ai.draft.set(prompt); focusComposer()"
                    >
                      {{ prompt }}
                    </button>
                  }
                </div>
              }
            </div>
          }
          @for (message of ai.messages(); track $index) {
            <article [class]="message.role === 'user' ? 'bg-muted ml-8 rounded-md p-3' : 'pr-2'">
              <div class="text-muted-foreground mb-1 text-[11px] font-medium">
                {{ message.role === 'user' ? 'You' : 'Trama' }}
              </div>
              @if (message.activity; as activity) {
                <details
                  class="group mb-2"
                  [attr.open]="$last && !ai.busy() && activity.steps.length <= 6 ? '' : null"
                >
                  <summary
                    class="text-muted-foreground hover:text-foreground flex w-fit cursor-pointer list-none items-center gap-1 text-[13px] select-none [&::-webkit-details-marker]:hidden"
                  >
                    Worked for {{ activity.seconds }}
                    {{ activity.seconds === 1 ? 'second' : 'seconds' }}
                    <svg
                      [lucideIcon]="chevronIcon"
                      [size]="12"
                      class="transition-transform group-open:rotate-90"
                    ></svg>
                  </summary>
                  <app-activity-steps class="mt-2" [steps]="activity.steps" />
                </details>
              }
              @if (message.role === 'user') {
                <p class="m-0 whitespace-pre-wrap break-words text-sm leading-relaxed">
                  {{ message.content }}
                </p>
              } @else {
                <app-markdown [source]="message.content" [link]="refs.linker()" />
              }
            </article>
          }
          @if (ai.busy()) {
            <article class="pr-2" role="status">
              <div class="text-muted-foreground mb-1 text-[11px] font-medium">Trama</div>
              <div class="text-muted-foreground mb-2 flex items-center gap-1.5 text-[13px]">
                @if (live(); as l) {
                  {{ l.steps.length || l.working ? 'Working' : 'Thinking' }} for {{ elapsed() }}s
                }
              </div>
              @if (live(); as l) {
                @if (l.steps.length || l.working) {
                  <app-activity-steps class="mb-2" [steps]="l.steps" [working]="l.working" />
                }
                @if (l.text) {
                  <app-markdown [source]="l.text" [link]="refs.linker()" />
                }
              }
            </article>
          }
        </div>
      </div>
    } @else {
      <div class="min-h-0 flex-1" aria-hidden="true"></div>
    }

    <div class="mx-auto w-full px-3 pb-3" [class.max-w-3xl]="page()">
      @if (ai.error() || ai.statusError()) {
        <p class="text-destructive mb-2 text-xs" role="alert">
          {{ ai.error() || ai.statusError() }}
        </p>
      }
      @if (ai.loadingStatus()) {
        <p class="text-muted-foreground mb-2 text-xs" role="status">Checking AI connection…</p>
      } @else if (!ai.ready()) {
        <p class="text-muted-foreground mb-2 text-xs">
          AI is not available yet.
          <a
            [routerLink]="['/', ai.slug(), 'settings', 'ai']"
            class="underline"
            (click)="navigated.emit()"
            >Open AI settings</a
          >
        </p>
      }
      <form
        (submit)="send($event)"
        class="border-input dark:bg-secondary focus-within:border-ring focus-within:ring-ring/50 border p-2 transition-colors focus-within:ring-2"
        [class]="page() ? 'bg-card rounded-xl p-3 shadow-xs' : 'rounded-md'"
      >
        <textarea
          #composer
          aria-label="Message Trama assistant"
          aria-describedby="assistant-context-hint"
          [rows]="page() ? 3 : 2"
          maxlength="8000"
          class="placeholder:text-muted-foreground w-full resize-none bg-transparent px-1 outline-none"
          [class]="page() ? 'text-[15px]' : 'text-sm'"
          placeholder="Ask Trama…"
          name="message"
          [ngModel]="ai.draft()"
          (ngModelChange)="ai.draft.set($event)"
          [disabled]="!ai.ready() || ai.busy()"
          (keydown)="onComposerKey($event)"
        ></textarea>
        <div class="flex items-center justify-between gap-2">
          @if (page()) {
            <span></span>
          } @else {
            <button
              type="button"
              class="text-muted-foreground hover:bg-accent hover:text-foreground inline-flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2 text-xs"
              [class.text-foreground]="ai.shareContext()"
              [attr.aria-pressed]="ai.shareContext()"
              [attr.aria-label]="'Include ' + ai.context().label + ' in this chat'"
              (click)="ai.shareContext.set(!ai.shareContext())"
            >
              <svg [lucideIcon]="contextIcon" [size]="13" class="shrink-0"></svg>
              <span class="truncate" [class.line-through]="!ai.shareContext()">{{
                ai.context().label
              }}</span>
            </button>
          }
          @if (ai.busy()) {
            <button
              hlmBtn
              type="button"
              size="icon"
              variant="outline"
              class="size-7"
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
              class="size-7"
              aria-label="Send message"
              [disabled]="!ai.ready() || !ai.draft().trim()"
            >
              <svg [lucideIcon]="sendIcon" [size]="14"></svg>
            </button>
          }
        </div>
      </form>
      @if (page() && !ai.messages().length && ai.chats().length) {
        <ul class="mt-4" aria-label="Recent chats">
          @for (chat of ai.chats(); track chat.id) {
            <li>
              <button
                type="button"
                class="hover:bg-accent/60 flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-2 text-left text-[13px]"
                (click)="ai.openChat(chat.id)"
              >
                @if (chat.unread) {
                  <span
                    class="bg-primary size-1.5 shrink-0 rounded-full"
                    role="img"
                    aria-label="Unread"
                  ></span>
                }
                <span
                  class="min-w-0 flex-1 truncate"
                  [class]="chat.unread ? 'text-foreground' : 'text-foreground/80'"
                  >{{ chat.title }}</span
                >
                <span class="text-muted-foreground shrink-0 text-xs">{{
                  ago(chat.updatedAt)
                }}</span>
              </button>
            </li>
          }
        </ul>
      }
      <p id="assistant-context-hint" class="text-muted-foreground mt-3 text-center text-[11px]">
        {{
          ai.shareContext()
            ? ai.context().kind === 'page'
              ? ai.status()?.assistantTools?.enabled
                ? 'Shares the page name. The assistant can look up and change records in this workspace for you, within your permissions and usage caps.'
                : 'Shares the page name and your open issues (titles only).'
              : 'Shares this item’s details with the AI provider.'
            : 'No current page data will be added.'
        }}
        AI can make mistakes. Review suggestions before using them.
      </p>
    </div>
    @if (page() && !ai.messages().length) {
      <div class="flex-[1.5]" aria-hidden="true"></div>
    }
  `,
  styles: `
    @media (pointer: coarse) {
      button {
        min-height: 36px;
        min-width: 36px;
      }
    }
  `,
})
export class AssistantChat {
  protected readonly ai = inject(AssistantStore);
  protected readonly refs = inject(EntityRefs);
  protected readonly live = this.ai.live;
  private readonly tick = signal(Date.now());
  /** Seconds since the reply started; ticks once a second while the assistant is busy. */
  protected readonly elapsed = computed(() => {
    const l = this.live();
    return l ? Math.max(0, Math.floor((this.tick() - l.startedAt) / 1000)) : 0;
  });
  readonly page = input(false);
  readonly navigated = output<void>();
  private readonly composer = viewChild<ElementRef<HTMLTextAreaElement>>('composer');
  private readonly conversation = viewChild<ElementRef<HTMLElement>>('conversation');
  protected readonly contextIcon = LucideFileText;
  protected readonly sendIcon = LucideArrowUp;
  protected readonly stopIcon = LucideSquare;
  protected readonly chevronIcon = LucideChevronRight;
  protected readonly prompts = [
    'Summarize this item',
    'What information is missing?',
    'Help me write a clearer description',
  ];

  constructor() {
    effect((onCleanup) => {
      if (!this.ai.busy()) return;
      this.tick.set(Date.now());
      const timer = setInterval(() => this.tick.set(Date.now()), 1000);
      onCleanup(() => clearInterval(timer));
    });
    effect(() => {
      this.ai.messages();
      this.ai.busy();
      this.ai.live();
      const element = this.conversation()?.nativeElement;
      if (element)
        queueMicrotask(() => {
          element.scrollTop = element.scrollHeight;
        });
    });
  }

  focusComposer(): void {
    this.composer()?.nativeElement.focus();
  }

  protected send(event: Event): void {
    event.preventDefault();
    void this.ai.send();
  }

  protected onComposerKey(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) this.send(event);
  }

  protected readonly ago = timeAgo;
}
