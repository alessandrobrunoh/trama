import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { LucideDynamicIcon, LucideInfo } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { AssistantStore, type AssistantChat } from '../../core/ai/assistant.store';
import type { ActivityStep } from '../../core/ai/ai-api';
import { usePageShortcuts } from '../../core/keyboard/keyboard-shortcuts.service';
import { TramaStore } from '../../core/stores/trama.store';
import { UiStore } from '../../core/stores/ui.store';
import { TopBarActions } from '../../layout/page-chrome';
import { ago } from '../../shared/ago';
import { EntityRefs } from '../../shared/entity-ref';
import { Kbd } from '../../shared/kbd';
import { Markdown } from '../../shared/markdown';
import { PageHeader } from '../../shared/page-header';
import { ActivitySteps } from './activity-steps';
import { AskTurn, type AskTurnData } from './ask-turn';

const SUGGESTIONS: readonly string[] = [
  'What is blocked right now?',
  'Which tasks have no linked thread?',
  'What changed in the last week?',
];

/** History time as the v3 frame writes it: 2m, 3h, yesterday, Nov 21. */
function savedAt(time: number, now = Date.now()): string {
  const minutes = Math.round((now - time) / 60000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const then = new Date(time);
  const today = new Date(now);
  const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (time >= midnight) return `${Math.round(minutes / 60)}h`;
  if (time >= midnight - 86_400_000) return 'yesterday';
  return then.toLocaleDateString('en', {
    month: 'short',
    day: 'numeric',
    ...(then.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
  });
}

/**
 * `/:workspace/assistant` (v3 "10 Ask"): ask a question about your tasks and their linked threads.
 *
 *   history   300px column of saved answers (the chats kept in this browser), newest first
 *   main      the open answer: kicker, serif question, answer and the numbered sources, then the ask box
 *   ask box   scope (what the assistant may see), which provider answers, and Ask (Enter or mod+Enter)
 *
 * The page opens on a fresh question; opening a saved answer shows it as it was written. Phones show
 * one column at a time: the answer, or the saved answers behind the "Saved answers" button.
 * Keyboard: Shift+A opens the saved answers (and closes them again on a phone).
 */
@Component({
  selector: 'app-assistant-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    RouterLink,
    LucideDynamicIcon,
    HlmButtonImports,
    Kbd,
    Markdown,
    ActivitySteps,
    PageHeader,
    TopBarActions,
    AskTurn,
  ],
  host: { class: 'flex h-full min-h-0 flex-col' },
  template: `
    <app-page-header title="Ask the records" />

    <ng-template appTopBarActions>
      <button
        hlmBtn
        variant="outline"
        type="button"
        [attr.aria-pressed]="historyOpen()"
        (click)="toggleHistory()"
      >
        Saved answers <app-kbd keys="shift+a" />
      </button>
    </ng-template>

    <div class="flex min-h-0 flex-1">
      <!-- saved answers -->
      <aside
        class="border-border bg-card min-h-0 w-full flex-col md:w-[300px] md:shrink-0 md:border-r"
        [class]="historyOpen() ? 'flex' : 'hidden md:flex'"
        aria-label="Saved answers"
      >
        <div class="border-border flex shrink-0 items-center gap-2 border-b px-4 py-3">
          <h2 class="text-foreground flex-1 font-mono text-[10.5px] leading-[13px] uppercase">
            Saved answers
          </h2>
          <button
            type="button"
            class="text-faint hover:text-foreground font-mono text-[10.5px] leading-[13px] outline-none focus-visible:underline"
            (click)="newQuestion()"
          >
            + New
          </button>
        </div>
        <div #historyList class="min-h-0 flex-1 overflow-y-auto">
          @for (chat of ai.chats(); track chat.id) {
            <button
              type="button"
              class="border-border hover:bg-secondary flex w-full flex-col items-start gap-1 border-b px-4 py-3 text-start outline-none focus-visible:underline"
              [class.bg-hover]="chat.id === ai.activeId()"
              [attr.aria-current]="chat.id === ai.activeId() ? 'true' : null"
              [attr.data-chat-id]="chat.id"
              (click)="openChat(chat)"
            >
              <span
                class="w-full truncate text-[13px] leading-4"
                [class]="chat.id === ai.activeId() ? 'text-foreground' : 'text-muted-foreground'"
                >{{ chat.title }}</span
              >
              <span class="text-faint flex items-center gap-1.5 font-mono text-[10px] leading-3">
                @if (chat.unread) {
                  <span class="bg-primary size-1.5" role="img" aria-label="Unread"></span>
                }
                {{ time(chat) }}
              </span>
            </button>
          } @empty {
            <p class="text-faint px-4 py-4 font-mono text-[11px] leading-4">
              No saved answers yet. Ask a question and its answer is kept here.
            </p>
          }
        </div>
      </aside>

      <!-- the open answer and the ask box -->
      <section
        class="min-h-0 min-w-0 flex-1 flex-col"
        [class]="historyOpen() ? 'hidden md:flex' : 'flex'"
        aria-label="Answer"
      >
        <div #scroller class="min-h-0 flex-1 overflow-y-auto px-4 pt-6 md:px-16 md:pt-9">
          <div class="mx-auto flex w-full max-w-[860px] flex-col gap-6 pb-6">
            <button
              type="button"
              class="text-muted-foreground border-border -mb-2 w-fit border px-2 py-[3px] font-mono text-[11px] md:hidden"
              (click)="toggleHistory()"
            >
              Saved answers
            </button>
            <div class="border-border flex w-full items-center gap-2.5 border px-3.5 py-2.5">
              <svg
                [lucideIcon]="infoIcon"
                [size]="14"
                class="text-muted-foreground shrink-0"
                aria-hidden="true"
              ></svg>
              <p class="text-faint m-0 font-mono text-[11px] leading-4">
                Answers are built from your tasks and their linked threads. They are saved in this
                browser, per workspace. Answers can be wrong: check the sources.
              </p>
            </div>

            @for (turn of turns(); track $index; let first = $first; let last = $last) {
              <app-ask-turn
                [turn]="turn"
                [asker]="asker()"
                [when]="last && !ai.busy() ? savedWhen() : null"
                [canDelete]="first && !!ai.active()"
                (remove)="deleteActive()"
              />
            }

            @if (ai.busy()) {
              <div class="flex w-full flex-col gap-3.5" role="status">
                @if (live(); as l) {
                  <div class="text-faint font-mono text-[11px] leading-4">
                    {{ l.steps.length || l.working ? 'Working' : 'Thinking' }} for {{ elapsed() }}s
                  </div>
                  @if (l.steps.length || l.working) {
                    <app-activity-steps [steps]="l.steps" [working]="l.working" />
                  }
                  @if (l.text) {
                    <app-markdown
                      class="text-foreground text-[15.5px]! leading-[26px]!"
                      [source]="l.text"
                      [link]="refs.linker()"
                    />
                  }
                }
              </div>
            }

            @if (!turns().length) {
              <div class="flex w-full flex-col gap-2">
                <div class="text-faint font-mono text-[10.5px] uppercase">New question</div>
                <h2 class="font-title text-foreground text-[24px] leading-[30px] md:text-[30px] md:leading-9">
                  What do you want to know?
                </h2>
              </div>
              @if (ai.ready()) {
                <ul class="border-border divide-border w-full divide-y border" aria-label="Suggestions">
                  @for (s of suggestions; track s) {
                    <li>
                      <button
                        type="button"
                        class="hover:bg-secondary text-muted-foreground hover:text-foreground w-full px-3.5 py-2.5 text-start text-[13px] outline-none focus-visible:underline"
                        (click)="ai.draft.set(s); focusComposer()"
                      >
                        {{ s }}
                      </button>
                    </li>
                  }
                </ul>
              }
            }
          </div>
        </div>

        <!-- ask box -->
        <div class="shrink-0 px-4 pt-2 pb-4 md:px-16 md:pb-9">
          <div class="mx-auto w-full max-w-[860px]">
            @if (ai.error() || ai.statusError()) {
              <p class="text-red mb-2 font-mono text-[11px]" role="alert">
                {{ ai.error() || ai.statusError() }}
              </p>
            }
            <form
              (submit)="send($event)"
              class="border-border bg-card focus-within:border-border-strong flex w-full flex-col gap-2.5 border p-3.5"
            >
              <textarea
                #composer
                aria-label="Ask about your tasks and their linked threads"
                rows="1"
                maxlength="8000"
                name="message"
                class="placeholder:text-faint text-foreground field-sizing-content max-h-40 min-h-5 w-full resize-none bg-transparent text-[14px] leading-5 outline-none"
                placeholder="Ask anything about your tasks and their linked threads…"
                [ngModel]="ai.draft()"
                (ngModelChange)="ai.draft.set($event)"
                [disabled]="!ai.ready() || ai.busy()"
                (keydown)="onComposerKey($event)"
              ></textarea>
              <div class="flex w-full flex-wrap items-center gap-2">
                <button
                  type="button"
                  class="border-border hover:border-border-strong flex items-center gap-1.5 border px-2 py-[3px] font-mono text-[11px] leading-[14px]"
                  [attr.aria-pressed]="ai.shareContext()"
                  [attr.aria-label]="
                    ai.shareContext()
                      ? 'Scope: ' + scopeLabel() + '. Press to answer without workspace context.'
                      : 'Scope: none. Press to share workspace context.'
                  "
                  [title]="scopeHint()"
                  (click)="ai.shareContext.set(!ai.shareContext())"
                >
                  <span class="text-muted-foreground">scope</span>
                  <span [class]="ai.shareContext() ? 'text-foreground' : 'text-faint line-through'">{{
                    scopeLabel()
                  }}</span>
                </button>
                <span class="flex items-center gap-1.5 font-mono text-[10.5px] leading-[13px]">
                  <span class="size-1.5 shrink-0" [class]="dot()" aria-hidden="true"></span>
                  @if (ai.loadingStatus()) {
                    <span class="text-faint" role="status">checking AI connection…</span>
                  } @else if (ai.ready()) {
                    <span class="text-faint">runs on {{ provider() }}</span>
                  } @else {
                    <span class="text-faint">
                      AI is not available yet ·
                      <a
                        [routerLink]="['/', ai.slug(), 'settings', 'ai']"
                        class="text-delta hover:underline"
                        >Open AI settings</a
                      >
                    </span>
                  }
                </span>
                <span class="flex-1"></span>
                @if (ai.busy()) {
                  <button hlmBtn variant="outline" type="button" (click)="ai.stop()">Stop</button>
                } @else {
                  <button
                    hlmBtn
                    type="submit"
                    [disabled]="!ai.ready() || !ai.draft().trim()"
                  >
                    Ask <app-kbd keys="mod+enter" />
                  </button>
                }
              </div>
            </form>
          </div>
        </div>
      </section>
    </div>
  `,
})
export class AssistantPage {
  protected readonly ai = inject(AssistantStore);
  protected readonly refs = inject(EntityRefs);
  private readonly store = inject(TramaStore);
  private readonly ui = inject(UiStore);
  private readonly composer = viewChild<ElementRef<HTMLTextAreaElement>>('composer');
  private readonly scroller = viewChild<ElementRef<HTMLElement>>('scroller');
  private readonly historyList = viewChild<ElementRef<HTMLElement>>('historyList');
  protected readonly infoIcon = LucideInfo;
  protected readonly suggestions = SUGGESTIONS;
  protected readonly live = this.ai.live;
  /** Phones show either the answer or the saved answers; wider screens show both. */
  protected readonly historyOpen = signal(false);
  private readonly tick = signal(Date.now());

  /** Seconds since the reply started; ticks once a second while the assistant is busy. */
  protected readonly elapsed = computed(() => {
    const l = this.live();
    return l ? Math.max(0, Math.floor((this.tick() - l.startedAt) / 1000)) : 0;
  });

  /** First name, as the kicker writes it ("asked by Alessandro"). */
  protected readonly asker = computed(
    () => this.store.me()?.name.trim().split(/\s+/)[0] || 'you',
  );

  protected readonly scopeLabel = computed(() => {
    if (!this.ai.shareContext()) return 'none';
    return this.store.workspace()?.name ?? 'workspace';
  });

  protected readonly scopeHint = computed(() => {
    if (!this.ai.shareContext()) return 'No workspace data is added to your question.';
    return this.ai.status()?.assistantTools?.enabled
      ? 'The assistant can look up and change records in this workspace for you, within your permissions and usage caps.'
      : 'Shares the page name and your open tasks (titles only).';
  });

  /** Who answers: the connected SuperGrok account, else the configured model. */
  protected readonly provider = computed(() => {
    const status = this.ai.status();
    if (status?.supergrok.connected) return 'SuperGrok';
    return status?.suggestions.model ?? 'Trama cloud';
  });

  protected readonly dot = computed(() =>
    this.ai.loadingStatus() ? 'bg-faint' : this.ai.ready() ? 'bg-green' : 'bg-red',
  );

  /** The open chat as question / answer pairs; the last question has no answer while it is prepared. */
  protected readonly turns = computed<AskTurnData[]>(() => {
    const out: AskTurnData[] = [];
    for (const m of this.ai.messages()) {
      if (m.role === 'user') {
        out.push({ question: m.content, answer: null, sources: [], notes: [], seconds: null });
        continue;
      }
      const turn = out.at(-1);
      if (!turn || turn.answer !== null) continue;
      const steps: readonly ActivityStep[] = m.activity?.steps ?? [];
      turn.answer = m.content;
      turn.sources = steps.filter((s) => s.kind !== 'note');
      turn.notes = steps.filter((s) => s.kind === 'note');
      turn.seconds = m.activity?.seconds ?? null;
    }
    return out;
  });

  /** "2m ago" for the last answer of the open chat; the time the chat was last written. */
  protected readonly savedWhen = computed(() => {
    const at = this.ai.active()?.updatedAt;
    if (!at) return null;
    const text = ago(new Date(at).toISOString(), this.tick());
    return text === 'now' ? 'just now' : `${text} ago`;
  });

  constructor() {
    // The page opens on a fresh question (with the saved answers beside it) unless the popup handed
    // a chat over or a reply is still on its way.
    if (!this.ai.handoverToPage && !this.ai.busy()) this.ai.newChat();
    this.ai.handoverToPage = false;

    effect(() => {
      if (this.composer()) queueMicrotask(() => this.focusComposer());
    });

    effect((onCleanup) => {
      if (!this.ai.busy()) return;
      this.tick.set(Date.now());
      const timer = setInterval(() => this.tick.set(Date.now()), 1000);
      onCleanup(() => clearInterval(timer));
    });

    // A saved answer opens at its question; a reply being written keeps the newest text in view.
    effect(() => {
      this.ai.activeId();
      untracked(() => queueMicrotask(() => this.scroller()?.nativeElement.scrollTo({ top: 0 })));
    });
    effect(() => {
      this.ai.live();
      const element = this.scroller()?.nativeElement;
      if (element && untracked(() => this.ai.busy()))
        queueMicrotask(() => (element.scrollTop = element.scrollHeight));
    });

    usePageShortcuts([
      {
        keys: 'shift+a',
        label: 'Show the saved answers',
        run: () => this.toggleHistory(),
      },
    ]);
  }

  protected time(chat: AssistantChat): string {
    return savedAt(chat.updatedAt, this.tick());
  }

  protected toggleHistory(): void {
    const open = !this.historyOpen();
    this.historyOpen.set(open);
    if (!open) return;
    // On a wide screen the list is already there: put the keyboard on the open answer.
    queueMicrotask(() =>
      this.historyList()
        ?.nativeElement.querySelector<HTMLElement>('[aria-current="true"], button')
        ?.focus(),
    );
  }

  protected openChat(chat: AssistantChat): void {
    this.ai.openChat(chat.id);
    this.historyOpen.set(false);
  }

  protected newQuestion(): void {
    this.ai.newChat();
    this.historyOpen.set(false);
    queueMicrotask(() => this.focusComposer());
  }

  protected deleteActive(): void {
    const chat = this.ai.active();
    if (!chat) return;
    this.ui.setConfirmDelete({
      title: `Delete “${chat.title}”?`,
      description: 'The answer is removed from this device. This cannot be undone.',
      onConfirm: () => this.ai.deleteChat(chat.id),
    });
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
