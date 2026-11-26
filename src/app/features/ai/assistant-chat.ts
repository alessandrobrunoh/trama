import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  effect,
  computed,
  inject,
  signal,
  output,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import {
  LucideCircleDot,
  LucideCornerDownLeft,
  LucideDynamicIcon,
  LucideFileText,
  LucideGitBranch,
  LucideGitPullRequest,
  LucideSparkles,
  LucideSquare,
} from '@lucide/angular';
import { AssistantStore } from '../../core/ai/assistant.store';
import {
  askAnswerMeta,
  askPlaceholder,
  type AskSourceIcon,
} from '../../core/ai/ask-context';
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
 * Conversation and input of the "Ask Trama" panel (v4 "Dialog 07 Ask overlay"): the question as a
 * right-aligned bubble, the answer under a mono "TRAMA · FROM N RECORDS" kicker with the records it
 * came from as chips, then the input with its footer note. Talks to the same AssistantStore as the
 * full Ask page, so both show the same chats.
 */
@Component({
  selector: 'app-assistant-chat',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, RouterLink, LucideDynamicIcon, Markdown, ActivitySteps],
  host: { class: 'flex min-h-0 flex-1 flex-col' },
  template: `
    <div
      #conversation
      class="min-h-[120px] flex-1 overflow-y-auto"
      role="log"
      aria-label="Conversation"
      aria-live="polite"
      aria-relevant="additions text"
    >
      <div class="flex flex-col gap-4 px-3.5 py-4">
        @if (!ai.messages().length && !ai.busy()) {
          <div class="flex flex-col gap-2">
            <div class="text-faint font-mono text-[10.5px] uppercase">Ask about your records</div>
          </div>
        }

        @for (message of ai.messages(); track $index; let last = $last) {
          @if (message.role === 'user') {
            <div class="flex justify-end">
              <p
                class="bg-secondary border-border text-foreground m-0 max-w-[88%] border px-3 py-2 text-[13px] leading-5 [overflow-wrap:anywhere] whitespace-pre-wrap"
              >
                {{ message.content }}
              </p>
            </div>
          } @else {
            @let meta = metaOf(message.activity?.steps);
            <article class="flex flex-col gap-2.5">
              <div class="text-faint flex items-center gap-1.5 font-mono text-[10.5px] uppercase">
                <svg
                  [lucideIcon]="sparklesIcon"
                  [size]="12"
                  class="text-primary shrink-0"
                  aria-hidden="true"
                ></svg>
                Trama
                @if (meta.records) {
                  · from {{ meta.records }} {{ meta.records === 1 ? 'record' : 'records' }}
                }
              </div>
              <app-markdown
                class="text-muted-foreground text-[13px]! leading-5!"
                [source]="message.content"
                [link]="refs.linker()"
              />
              @if (meta.sources.length) {
                <ul class="m-0 flex list-none flex-wrap gap-1.5 p-0" aria-label="Sources">
                  @for (source of meta.sources.slice(0, 6); track $index) {
                    <li
                      class="bg-secondary border-border text-muted-foreground flex max-w-full items-center gap-[5px] border px-[7px] py-0.5 font-mono text-[10.5px]"
                    >
                      <svg
                        [lucideIcon]="iconFor(source.icon)"
                        [size]="11"
                        class="text-muted-foreground shrink-0"
                        aria-hidden="true"
                      ></svg>
                      <span class="truncate">{{ source.label }}</span>
                    </li>
                  }
                </ul>
              }
              @if (last && !ai.busy() && actionsOn()) {
                <div class="flex flex-wrap gap-1.5 pt-1">
                  <button
                    type="button"
                    class="border-primary/40 bg-primary/10 text-foreground hover:bg-primary/20 border px-2.5 py-[5px] font-mono text-[11px] outline-none focus-visible:underline"
                    (click)="draftUpdate()"
                  >
                    Draft update
                  </button>
                  @if (ai.contextThreadUrl(); as thread) {
                    <a
                      [href]="thread"
                      target="_blank"
                      rel="noopener noreferrer"
                      class="border-border text-muted-foreground hover:text-foreground hover:border-border-strong border px-2.5 py-[5px] font-mono text-[11px] outline-none focus-visible:underline"
                      >Open in Delta</a
                    >
                  }
                </div>
              }
            </article>
          }
        }

        @if (ai.busy()) {
          <article class="flex flex-col gap-2.5" role="status">
            <div class="text-faint flex items-center gap-1.5 font-mono text-[10.5px] uppercase">
              <svg
                [lucideIcon]="sparklesIcon"
                [size]="12"
                class="text-primary shrink-0"
                aria-hidden="true"
              ></svg>
              @if (live(); as l) {
                Trama · {{ l.steps.length || l.working ? 'working' : 'thinking' }} {{ elapsed() }}s
              }
            </div>
            @if (live(); as l) {
              @if (l.steps.length || l.working) {
                <app-activity-steps [steps]="l.steps" [working]="l.working" />
              }
              @if (l.text) {
                <app-markdown
                  class="text-muted-foreground text-[13px]! leading-5!"
                  [source]="l.text"
                  [link]="refs.linker()"
                />
              }
            }
          </article>
        }
      </div>
    </div>

    <div class="border-border flex shrink-0 flex-col gap-2 border-t px-3.5 py-3">
      @if (ai.error() || ai.statusError()) {
        <p class="text-red m-0 font-mono text-[11px]" role="alert">
          {{ ai.error() || ai.statusError() }}
        </p>
      }
      @if (ai.loadingStatus()) {
        <p class="text-faint m-0 font-mono text-[11px]" role="status">Checking AI connection…</p>
      } @else if (!ai.ready()) {
        <p class="text-faint m-0 font-mono text-[11px]">
          AI is not available yet.
          <a
            [routerLink]="['/', ai.slug(), 'settings', 'ai']"
            class="text-delta hover:underline"
            (click)="navigated.emit()"
            >Open AI settings</a
          >
        </p>
      }
      <form
        (submit)="send($event)"
        class="bg-background border-primary/40 focus-within:border-primary flex items-center gap-2 border px-3 py-2.5"
      >
        <textarea
          #composer
          aria-label="Ask Trama"
          rows="1"
          maxlength="8000"
          name="message"
          class="placeholder:text-faint text-foreground field-sizing-content max-h-32 min-h-5 min-w-0 flex-1 resize-none bg-transparent text-[13px] leading-5 outline-none"
          [placeholder]="placeholder()"
          [ngModel]="ai.draft()"
          (ngModelChange)="ai.draft.set($event)"
          [disabled]="!ai.ready() || ai.busy()"
          (keydown)="onComposerKey($event)"
        ></textarea>
        @if (ai.busy()) {
          <button
            type="button"
            class="border-border-strong text-foreground hover:bg-secondary flex shrink-0 items-center border px-1.5 py-[3px]"
            aria-label="Stop response"
            (click)="ai.stop()"
          >
            <svg [lucideIcon]="stopIcon" [size]="12" aria-hidden="true"></svg>
          </button>
        } @else {
          <button
            type="submit"
            class="bg-primary text-primary-foreground flex shrink-0 items-center px-1.5 py-[3px] disabled:opacity-40"
            aria-label="Send message"
            [disabled]="!ai.ready() || !ai.draft().trim()"
          >
            <svg [lucideIcon]="sendIcon" [size]="12" aria-hidden="true"></svg>
          </button>
        }
      </form>
      <p class="text-faint m-0 font-mono text-[10px] leading-[14px]">
        Reads Trama data and Delta records. Agents run in Delta.
      </p>
    </div>
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
  readonly navigated = output<void>();
  private readonly composer = viewChild<ElementRef<HTMLTextAreaElement>>('composer');
  private readonly conversation = viewChild<ElementRef<HTMLElement>>('conversation');
  protected readonly sparklesIcon = LucideSparkles;
  protected readonly sendIcon = LucideCornerDownLeft;
  protected readonly stopIcon = LucideSquare;
  protected readonly placeholder = computed(() => askPlaceholder(this.ai.context()?.kind));
  /** "Draft update" only makes sense about a task or a project. */
  protected readonly actionsOn = computed(() => {
    const kind = this.ai.context()?.kind;
    return kind === 'issue' || kind === 'project';
  });
  protected readonly metaOf = askAnswerMeta;

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

  protected iconFor(icon: AskSourceIcon) {
    switch (icon) {
      case 'pr':
        return LucideGitPullRequest;
      case 'thread':
        return LucideGitBranch;
      case 'task':
        return LucideCircleDot;
      default:
        return LucideFileText;
    }
  }

  focusComposer(): void {
    this.composer()?.nativeElement.focus();
  }

  /** Puts a status-update request in the input for the subject in context; the person sends it. */
  protected draftUpdate(): void {
    const ctx = this.ai.context();
    if (!ctx) return;
    this.ai.draft.set(`Draft a status update for ${ctx.label}`);
    this.focusComposer();
  }

  protected send(event: Event): void {
    event.preventDefault();
    void this.ai.send();
  }

  protected onComposerKey(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) this.send(event);
  }
}
