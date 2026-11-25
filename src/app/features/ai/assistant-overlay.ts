import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import {
  LucideCircleDot,
  LucideDynamicIcon,
  LucideFileText,
  LucideGlobe,
  LucideHistory,
  LucideLayoutList,
  LucideMaximize2,
  LucideSparkles,
  LucideX,
} from '@lucide/angular';
import { AssistantStore } from '../../core/ai/assistant.store';
import {
  projectChip,
  taskChip,
  type AskChipKind,
  type AskContextChip,
} from '../../core/ai/ask-context';
import { TramaStore } from '../../core/stores/trama.store';
import { AssistantChat, timeAgo } from './assistant-chat';

const IS_MAC =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Most records the "+ add" list shows at once. */
const PICKER_LIMIT = 6;

/**
 * "Ask Trama" (v4 "Dialog 07 Ask overlay"): a non-modal panel docked bottom right above the status
 * bar, opened with ⌘J or the status bar chip. Mounted once by the app shell, so the conversation,
 * the draft and the CONTEXT chips survive navigation.
 *
 *   header    Ask Trama · ⌘J · history · expand to /:workspace/assistant · close
 *   CONTEXT   chips the route fills in (task, project, view or page); each can be removed, "+ add" adds more
 *   body      the conversation and the input (app-assistant-chat), on the same AssistantStore as the full page
 *
 * Esc closes the panel while focus is inside it (a menu open inside it closes first).
 */
@Component({
  selector: 'app-assistant-overlay',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, LucideDynamicIcon, AssistantChat],
  template: `
    @if (ai.open() && !ai.onAssistantPage()) {
      <section
        id="trama-assistant"
        role="dialog"
        aria-modal="false"
        aria-labelledby="assistant-title"
        class="ask-panel bg-card border-border-strong fixed z-40 flex flex-col border shadow-[0_16px_48px_#00000066]"
        (keydown.escape)="close($event)"
      >
        <header class="border-border relative flex h-10 shrink-0 items-center gap-2 border-b px-3.5">
          <svg
            [lucideIcon]="sparklesIcon"
            [size]="14"
            class="text-primary shrink-0"
            aria-hidden="true"
          ></svg>
          <h2 id="assistant-title" class="text-foreground m-0 text-[13px] font-medium">
            Ask Trama
          </h2>
          <span class="text-faint font-mono text-[10.5px]" aria-hidden="true">{{ shortcut }}</span>
          <span class="flex-1"></span>
          <button
            type="button"
            class="text-muted-foreground hover:text-foreground flex size-5 items-center justify-center outline-none focus-visible:text-foreground"
            [class.text-foreground]="historyOpen()"
            aria-label="Chat history"
            title="Chat history"
            aria-haspopup="true"
            [attr.aria-expanded]="historyOpen()"
            (click)="toggleHistory()"
          >
            <svg [lucideIcon]="historyIcon" [size]="14"></svg>
          </button>
          <button
            type="button"
            class="text-muted-foreground hover:text-foreground flex size-5 items-center justify-center outline-none focus-visible:text-foreground"
            aria-label="Open full page"
            title="Open full page"
            (click)="expand()"
          >
            <svg [lucideIcon]="expandIcon" [size]="14"></svg>
          </button>
          <button
            type="button"
            class="text-muted-foreground hover:text-foreground flex size-5 items-center justify-center outline-none focus-visible:text-foreground"
            aria-label="Close"
            title="Close"
            (click)="close()"
          >
            <svg [lucideIcon]="closeIcon" [size]="14"></svg>
          </button>

          @if (historyOpen()) {
            <div
              role="menu"
              aria-label="Chat history"
              class="bg-popover border-border-strong absolute inset-x-2 top-full z-10 mt-1 max-h-72 overflow-y-auto border py-1 shadow-md"
              (keydown.escape)="closeMenus($event)"
            >
              <button
                type="button"
                role="menuitem"
                class="text-primary hover:bg-secondary w-full px-3 py-1.5 text-start font-mono text-[11px]"
                (click)="newChat()"
              >
                + New chat
              </button>
              @for (chat of ai.chats(); track chat.id) {
                <button
                  type="button"
                  role="menuitem"
                  class="hover:bg-secondary flex w-full items-center gap-2 px-3 py-1.5 text-start text-[13px]"
                  (click)="openChat(chat.id)"
                >
                  <span
                    class="size-1.5 shrink-0"
                    [class.bg-primary]="ai.activeId() === chat.id || chat.unread"
                    aria-hidden="true"
                  ></span>
                  <span
                    class="min-w-0 flex-1 truncate"
                    [class]="ai.activeId() === chat.id ? 'text-foreground' : 'text-muted-foreground'"
                    >{{ chat.title }}</span
                  >
                  <span class="text-faint shrink-0 font-mono text-[10px]">{{
                    ago(chat.updatedAt)
                  }}</span>
                </button>
              } @empty {
                <p class="text-faint m-0 px-3 py-2 font-mono text-[11px]">No chats yet.</p>
              }
            </div>
          }
        </header>

        <div class="border-border relative shrink-0 border-b px-3.5 py-2.5">
          <div class="flex flex-wrap items-center gap-1.5">
            <span class="text-faint me-0.5 font-mono text-[10px]">CONTEXT</span>
            @for (chip of ai.chips(); track chip.id) {
              <span
                class="bg-secondary border-border flex max-w-[170px] items-center gap-[5px] border py-0.5 ps-[7px] pe-1.5"
                [attr.title]="chip.hint ?? chip.label"
              >
                <svg
                  [lucideIcon]="iconFor(chip.kind)"
                  [size]="11"
                  class="text-muted-foreground shrink-0"
                  aria-hidden="true"
                ></svg>
                <span class="text-muted-foreground truncate font-mono text-[10.5px]">{{
                  chip.label
                }}</span>
                <button
                  type="button"
                  class="text-faint hover:text-foreground flex shrink-0 items-center outline-none focus-visible:text-foreground"
                  [attr.aria-label]="'Remove ' + chip.label + ' from the context'"
                  (click)="ai.removeChip(chip.id)"
                >
                  <svg [lucideIcon]="closeIcon" [size]="10" aria-hidden="true"></svg>
                </button>
              </span>
            }
            <button
              type="button"
              class="text-primary font-mono text-[10.5px] outline-none hover:underline focus-visible:underline"
              aria-haspopup="true"
              [attr.aria-expanded]="adding()"
              (click)="toggleAdd()"
            >
              + add
            </button>
          </div>

          @if (adding()) {
            <div
              class="bg-popover border-border-strong absolute inset-x-2 top-full z-10 mt-1 border shadow-md"
              (keydown.escape)="closeMenus($event)"
            >
              <input
                #picker
                type="text"
                name="context-search"
                autocomplete="off"
                aria-label="Add a task or project to the context"
                placeholder="Find a task or project…"
                class="placeholder:text-faint border-border text-foreground w-full border-b bg-transparent px-3 py-2 font-mono text-[11px] outline-none"
                [ngModel]="query()"
                (ngModelChange)="query.set($event)"
              />
              <div class="max-h-56 overflow-y-auto py-1" role="menu" aria-label="Add to the context">
                @for (chip of candidates(); track chip.id) {
                  <button
                    type="button"
                    role="menuitem"
                    class="hover:bg-secondary flex w-full items-center gap-2 px-3 py-1.5 text-start"
                    (click)="add(chip)"
                  >
                    <svg
                      [lucideIcon]="iconFor(chip.kind)"
                      [size]="11"
                      class="text-muted-foreground shrink-0"
                      aria-hidden="true"
                    ></svg>
                    <span class="text-foreground shrink-0 font-mono text-[10.5px]">{{
                      chip.kind === 'task' ? chip.label : ''
                    }}</span>
                    <span class="text-muted-foreground min-w-0 flex-1 truncate text-[12.5px]">{{
                      chip.kind === 'task' ? taskTitle(chip) : chip.label
                    }}</span>
                  </button>
                } @empty {
                  <p class="text-faint m-0 px-3 py-2 font-mono text-[11px]">Nothing to add.</p>
                }
              </div>
            </div>
          }
        </div>

        <app-assistant-chat (navigated)="closeAfterNavigate()" />
      </section>
    }
  `,
  styles: `
    .ask-panel {
      right: 1rem;
      /* 28px status bar + a small gap */
      bottom: 2.25rem;
      width: min(408px, calc(100vw - 2rem));
      max-height: min(640px, calc(100dvh - 6rem));
    }
    @media (max-width: 767px) {
      /* no status bar on phones: clear the bottom navigation instead */
      .ask-panel {
        right: 0.5rem;
        bottom: 4.5rem;
        width: calc(100vw - 1rem);
        max-height: calc(100dvh - 7rem);
      }
    }
  `,
})
export class AssistantOverlay {
  protected readonly ai = inject(AssistantStore);
  private readonly store = inject(TramaStore);
  private readonly document = inject(DOCUMENT);
  private readonly router = inject(Router);
  private readonly chat = viewChild(AssistantChat);
  private readonly picker = viewChild<{ nativeElement: HTMLInputElement }>('picker');
  protected readonly sparklesIcon = LucideSparkles;
  protected readonly historyIcon = LucideHistory;
  protected readonly expandIcon = LucideMaximize2;
  protected readonly closeIcon = LucideX;
  protected readonly shortcut = IS_MAC ? '⌘J' : 'Ctrl J';
  protected readonly historyOpen = signal(false);
  protected readonly adding = signal(false);
  protected readonly query = signal('');
  protected readonly ago = timeAgo;

  /** What "+ add" offers: removed route chips first, then tasks and projects matching the search. */
  protected readonly candidates = computed<AskContextChip[]>(() => {
    const on = new Set(this.ai.chips().map((c) => c.id));
    const out: AskContextChip[] = [...this.ai.removedChips()];
    const q = this.query().trim().toLowerCase();
    const match = (text: string) => !q || text.toLowerCase().includes(q);
    for (const project of this.store.projects())
      if (out.length < PICKER_LIMIT && match(project.name)) out.push(projectChip(project));
    // Tasks only once there is something to search for: the full list is long.
    if (q)
      for (const issue of this.store.issues())
        if (out.length < PICKER_LIMIT * 2 && match(`${issue.key} ${issue.title}`))
          out.push(taskChip(issue));
    return out.filter((c) => !on.has(c.id)).slice(0, PICKER_LIMIT * 2);
  });

  constructor() {
    // Opening puts the cursor in the input; the full page has its own, so the panel stays shut there.
    effect(() => {
      if (!this.ai.open()) return;
      if (this.ai.onAssistantPage()) this.ai.open.set(false);
      else if (this.chat()) queueMicrotask(() => this.chat()?.focusComposer());
    });
    effect(() => {
      if (this.adding()) queueMicrotask(() => this.picker()?.nativeElement.focus());
    });
  }

  protected iconFor(kind: AskChipKind) {
    switch (kind) {
      case 'task':
        return LucideCircleDot;
      case 'project':
        return LucideGlobe;
      case 'view':
        return LucideLayoutList;
      default:
        return LucideFileText;
    }
  }

  /** The task title of a task chip (its hint reads "KEY · title"). */
  protected taskTitle(chip: AskContextChip): string {
    return chip.hint?.slice(chip.label.length + 3) ?? '';
  }

  protected toggleHistory(): void {
    this.adding.set(false);
    this.historyOpen.update((v) => !v);
  }

  protected toggleAdd(): void {
    this.historyOpen.set(false);
    this.query.set('');
    this.adding.update((v) => !v);
  }

  protected add(chip: AskContextChip): void {
    this.ai.addChip(chip);
    this.adding.set(false);
  }

  protected openChat(id: string): void {
    this.historyOpen.set(false);
    this.ai.openChat(id);
    queueMicrotask(() => this.chat()?.focusComposer());
  }

  protected newChat(): void {
    this.historyOpen.set(false);
    this.ai.newChat();
    queueMicrotask(() => this.chat()?.focusComposer());
  }

  /** Esc inside a menu closes the menu only. */
  protected closeMenus(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    this.historyOpen.set(false);
    this.adding.set(false);
  }

  /** Closes the panel; the conversation stays, so reopening picks up where it was. */
  protected close(event?: Event): void {
    event?.preventDefault();
    this.historyOpen.set(false);
    this.adding.set(false);
    const inside = this.document.activeElement?.closest('#trama-assistant');
    this.ai.open.set(false);
    // Focus was in the panel: hand it back to the status bar chip, else to the page.
    if (inside) {
      queueMicrotask(() => {
        const chip = this.document.getElementById('ask-trama-chip');
        if (chip?.getClientRects().length) chip.focus();
        else this.document.getElementById('main-content')?.focus();
      });
    }
  }

  /** A link inside the panel moved the app on: the panel stays open, as it is non-modal. */
  protected closeAfterNavigate(): void {
    this.historyOpen.set(false);
  }

  protected expand(): void {
    this.ai.open.set(false);
    this.ai.handoverToPage = true;
    void this.router.navigate(['/', this.ai.slug(), 'assistant']);
  }
}
