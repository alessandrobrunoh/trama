// Input requests: questions on a workstream that need a human answer (VISION §8, PLAN §3).
// `InputRequestItem` answers inline (suggested options or free text), dismisses, edits and deletes;
// `WsInputRequests` lists open / resolved requests and has the "Ask a question" form.
import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import {
  LucideChevronDown,
  LucideChevronRight,
  LucideCornerDownRight,
  LucideDynamicIcon,
  LucideEllipsis,
  LucideMessageCircleQuestion,
  LucidePencil,
  LucidePlus,
  LucideTrash2,
  LucideX,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { HlmTextareaImports } from '@spartan-ng/helm/textarea';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import { TramaStore, Notifier, UiStore, type InputRequest, type Workstream } from '../../core';
import { ActorLabel } from '../../shared/actor-avatar';
import { Kbd } from '../../shared/kbd';
import { RelativeTimePipe } from '../../shared/pipes';
import { Picker } from './picker';
import { WsActions } from './ws-actions';
import { userOptions } from './ws-model';

const splitOptions = (raw: string): string[] =>
  [...new Set(raw.split(/[,\n]/).map((s) => s.trim()).filter(Boolean))].slice(0, 10);

@Component({
  selector: 'app-input-request-item',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    HlmButtonImports,
    HlmDropdownMenuImports,
    HlmInputImports,
    HlmTextareaImports,
    HlmTooltip,
    LucideDynamicIcon,
    ActorLabel,
    Picker,
    RelativeTimePipe,
  ],
  host: { class: 'block' },
  template: `
    @let r = request();
    @if (editing()) {
      <div class="flex flex-col gap-2">
        <textarea hlmTextarea class="min-h-14 w-full text-[13px]" aria-label="Question" [value]="qDraft()" (input)="qDraft.set($any($event.target).value)" (keydown.meta.enter)="saveEdit()" (keydown.control.enter)="saveEdit()" (keydown.escape)="cancelEdit($event)"></textarea>
        <input hlmInput class="h-8 text-[13px]" placeholder="Suggested answers, comma-separated (optional)" aria-label="Suggested answers" [value]="oDraft()" (input)="oDraft.set($any($event.target).value)" />
        <div class="flex flex-wrap items-center gap-2">
          <app-picker class="w-48" label="Ask" placeholder="Anyone" [clearable]="true" clearLabel="Anyone" [options]="users()" [value]="aDraft() ? [aDraft()] : []" (valueChange)="aDraft.set($event[0] ?? '')" />
          <span class="flex-1"></span>
          <button hlmBtn variant="ghost" size="sm" (click)="editing.set(false)">Cancel</button>
          <button hlmBtn size="sm" [disabled]="!qDraft().trim()" (click)="saveEdit()">Save</button>
        </div>
      </div>
    } @else {
      <div class="flex items-start gap-2.5">
        <svg
          [lucideIcon]="qIcon"
          [size]="16"
          class="mt-0.5 shrink-0"
          [class.text-status-needs-input]="r.state === 'open'"
          [class.text-muted-foreground]="r.state !== 'open'"
        ></svg>
        <div class="min-w-0 flex-1">
          <p class="text-[13px] leading-snug" [class.font-medium]="r.state === 'open'" [class.text-muted-foreground]="r.state === 'dismissed'">{{ r.question }}</p>
          <div class="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs">
            <app-actor [actor]="r.requestedBy" [size]="14" />
            <span>asked {{ r.createdAt | relativeTime }}</span>
            @if (r.assigneeUserId) {
              <span>·</span>
              <span class="inline-flex items-center gap-1">for <app-actor [actor]="{ type: 'user', id: r.assigneeUserId }" [size]="14" /></span>
            }
            @if (r.state === 'dismissed') {
              <span>· dismissed</span>
            }
          </div>

          @if (r.state === 'answered') {
            <div class="bg-muted/60 mt-2 flex items-start gap-1.5 rounded-md px-2.5 py-1.5 text-[13px]">
              <svg [lucideIcon]="replyIcon" [size]="13" class="text-muted-foreground mt-0.5 shrink-0"></svg>
              <div class="min-w-0 flex-1">
                <p class="whitespace-pre-wrap">{{ r.answer }}</p>
                <p class="text-muted-foreground mt-0.5 text-xs">
                  {{ r.answeredById ? store.getUser(r.answeredById)?.name : 'Someone' }} · {{ r.answeredAt | relativeTime }}
                </p>
              </div>
            </div>
          } @else if (r.state === 'open' && canEdit()) {
            @if (r.options?.length) {
              <div class="mt-2 flex flex-wrap gap-1.5">
                @for (o of r.options; track o) {
                  <button hlmBtn variant="outline" size="xs" class="font-normal" (click)="answer(o)">{{ o }}</button>
                }
              </div>
            }
            <div class="mt-2 flex items-center gap-1.5">
              <input
                hlmInput
                class="h-7 flex-1 text-[13px]"
                [placeholder]="r.options?.length ? 'Or write another answer…' : 'Write an answer…'"
                aria-label="Answer"
                [value]="draft()"
                (input)="draft.set($any($event.target).value)"
                (keydown.enter)="answer(draft())"
              />
              <button hlmBtn size="xs" [disabled]="!draft().trim()" (click)="answer(draft())">Answer</button>
            </div>
          }
        </div>
        @if (canEdit()) {
          <span class="flex shrink-0 items-center">
            @if (r.state === 'open' && !compact()) {
              <button hlmBtn variant="ghost" size="icon-xs" class="text-muted-foreground" hlmTooltip="Dismiss" aria-label="Dismiss question" (click)="dismiss()">
                <svg [lucideIcon]="xIcon" [size]="13"></svg>
              </button>
            }
            <button hlmBtn variant="ghost" size="icon-xs" class="text-muted-foreground" aria-label="Question actions" [hlmDropdownMenuTrigger]="menu">
              <svg [lucideIcon]="moreIcon" [size]="13"></svg>
            </button>
          </span>
        }
      </div>
    }

    <ng-template #menu>
      <hlm-dropdown-menu class="w-44">
        @if (request().state === 'open') {
          <button hlmDropdownMenuItem (triggered)="startEdit()"><svg [lucideIcon]="editIcon" [size]="14"></svg>Edit</button>
          <button hlmDropdownMenuItem (triggered)="dismiss()"><svg [lucideIcon]="xIcon" [size]="14"></svg>Dismiss</button>
          <hlm-dropdown-menu-separator />
        }
        <button hlmDropdownMenuItem variant="destructive" (triggered)="remove()"><svg [lucideIcon]="trashIcon" [size]="14"></svg>Delete</button>
      </hlm-dropdown-menu>
    </ng-template>
  `,
})
export class InputRequestItem {
  protected readonly store = inject(TramaStore);
  private readonly ui = inject(UiStore);
  private readonly notify = inject(Notifier);
  readonly request = input.required<InputRequest>();
  /** Hide the inline dismiss button (e.g. inside "Needs attention", which has its own). */
  readonly compact = input(false);

  protected readonly canEdit = computed(() => this.store.can('member'));
  protected readonly users = computed(() => userOptions(this.store));
  protected readonly draft = signal('');
  protected readonly editing = signal(false);
  protected readonly qDraft = signal('');
  protected readonly oDraft = signal('');
  protected readonly aDraft = signal('');
  protected readonly qIcon = LucideMessageCircleQuestion;
  protected readonly replyIcon = LucideCornerDownRight;
  protected readonly xIcon = LucideX;
  protected readonly moreIcon = LucideEllipsis;
  protected readonly editIcon = LucidePencil;
  protected readonly trashIcon = LucideTrash2;

  protected async answer(text: string): Promise<void> {
    const a = text.trim();
    if (!a) return;
    this.draft.set('');
    if (await this.store.answerInput(this.request().id, a)) this.notify.success('Answered', { description: a });
  }

  protected dismiss(): void {
    void this.store.dismissInput(this.request().id);
  }

  protected startEdit(): void {
    const r = this.request();
    this.qDraft.set(r.question);
    this.oDraft.set((r.options ?? []).join(', '));
    this.aDraft.set(r.assigneeUserId ?? '');
    this.editing.set(true);
  }

  protected cancelEdit(e: Event): void {
    e.stopPropagation();
    this.editing.set(false);
  }

  protected saveEdit(): void {
    const question = this.qDraft().trim();
    if (!question) return;
    const options = splitOptions(this.oDraft());
    this.editing.set(false);
    void this.store.updateInputRequest(this.request().id, {
      question,
      options: options.length ? options : null,
      assigneeUserId: this.aDraft() || null,
    });
  }

  protected remove(): void {
    const r = this.request();
    this.ui.setConfirmDelete({
      title: 'Delete this question?',
      description: `“${r.question}”${r.answer ? ' and its answer' : ''} will be removed. This cannot be undone.`,
      onConfirm: async () => {
        await this.store.deleteInputRequest(r.id);
      },
    });
  }
}

@Component({
  selector: 'app-ws-input-requests',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButtonImports, HlmInputImports, HlmTextareaImports, LucideDynamicIcon, Kbd, Picker, InputRequestItem],
  host: { class: 'block' },
  template: `
    <section aria-labelledby="ws-inputs-title">
      <header class="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
        <svg [lucideIcon]="qIcon" [size]="15" class="text-muted-foreground"></svg>
        <h2 id="ws-inputs-title" class="text-sm font-semibold">Input requests</h2>
        <span class="text-muted-foreground text-xs">
          @if (open().length) {
            <span class="text-status-needs-input font-medium">{{ open().length }} open</span> ·
          }
          questions that need a human answer
        </span>
        @if (canEdit() && !asking()) {
          <button hlmBtn variant="ghost" size="sm" class="text-muted-foreground hover:text-foreground ml-auto h-7 gap-1.5 px-2 text-xs font-normal" (click)="startAsk()">
            <svg [lucideIcon]="plusIcon" [size]="13"></svg>Ask a question<app-kbd keys="q" class="opacity-60" />
          </button>
        }
      </header>

      @if (asking()) {
        <div class="bg-card mb-2 flex flex-col gap-2 rounded-lg border border-border-strong p-2.5">
          <textarea
            #askBox
            hlmTextarea
            class="min-h-16 w-full text-[13px]"
            placeholder="What do you need to know? e.g. “Should refresh tokens rotate on every request?”"
            aria-label="Question"
            [value]="question()"
            (input)="question.set($any($event.target).value)"
            (keydown.meta.enter)="ask()"
            (keydown.control.enter)="ask()"
            (keydown.escape)="cancelAsk($event)"
          ></textarea>
          <input hlmInput class="h-8 text-[13px]" placeholder="Suggested answers, comma-separated (optional)" aria-label="Suggested answers" [value]="options()" (input)="options.set($any($event.target).value)" (keydown.enter)="ask()" />
          <div class="flex flex-wrap items-center gap-2">
            <span class="text-muted-foreground text-xs">Ask</span>
            <app-picker class="w-48" label="Ask" placeholder="Anyone" [clearable]="true" clearLabel="Anyone" [options]="users()" [value]="assignee() ? [assignee()] : []" (valueChange)="assignee.set($event[0] ?? '')" />
            <span class="flex-1"></span>
            <button hlmBtn variant="ghost" size="sm" (click)="asking.set(false)">Cancel</button>
            <button hlmBtn size="sm" [disabled]="!question().trim() || busy()" (click)="ask()">Ask <app-kbd keys="mod+enter" class="opacity-70" /></button>
          </div>
        </div>
      }

      @if (open().length) {
        <ul class="bg-card overflow-hidden rounded-lg border border-border-strong">
          @for (r of open(); track r.id) {
            <li class="border-b px-3 py-2.5 last:border-b-0"><app-input-request-item [request]="r" /></li>
          }
        </ul>
      } @else if (!asking()) {
        <p class="text-muted-foreground text-sm">No open questions.</p>
      }

      @if (resolved().length) {
        <button type="button" class="text-muted-foreground hover:text-foreground mt-2 inline-flex items-center gap-1 text-xs" (click)="showResolved.update((v) => !v)">
          <svg [lucideIcon]="showResolved() ? downIcon : rightIcon" [size]="12"></svg>
          {{ resolved().length }} answered or dismissed
        </button>
        @if (showResolved()) {
          <ul class="mt-1.5 flex flex-col overflow-hidden rounded-lg border">
            @for (r of resolved(); track r.id) {
              <li class="border-b px-3 py-2.5 last:border-b-0"><app-input-request-item [request]="r" /></li>
            }
          </ul>
        }
      }
    </section>
  `,
})
export class WsInputRequests {
  protected readonly store = inject(TramaStore);
  private readonly actions = inject(WsActions);
  readonly ws = input.required<Workstream>();

  protected readonly qIcon = LucideMessageCircleQuestion;
  protected readonly plusIcon = LucidePlus;
  protected readonly downIcon = LucideChevronDown;
  protected readonly rightIcon = LucideChevronRight;

  protected readonly canEdit = computed(() => this.store.can('member'));
  protected readonly users = computed(() => userOptions(this.store));
  private readonly all = computed(() =>
    [...(this.store.inputRequestsByWorkstream().get(this.ws().id) ?? [])].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
  );
  protected readonly open = computed(() => this.all().filter((r) => r.state === 'open'));
  protected readonly resolved = computed(() => this.all().filter((r) => r.state !== 'open'));

  protected readonly asking = signal(false);
  protected readonly question = signal('');
  protected readonly options = signal('');
  protected readonly assignee = signal('');
  protected readonly busy = signal(false);
  protected readonly showResolved = signal(false);
  private readonly askBox = viewChild<ElementRef<HTMLTextAreaElement>>('askBox');

  constructor() {
    effect(() => {
      const i = this.actions.intent();
      if (i?.kind === 'ask') untracked(() => this.actions.consume('ask', this.ws().id) && this.startAsk());
    });
    effect(() => this.askBox()?.nativeElement.focus());
  }

  protected startAsk(): void {
    this.question.set('');
    this.options.set('');
    this.assignee.set(this.ws().accountableUserId ?? '');
    this.asking.set(true);
    this.askBox()?.nativeElement.focus();
  }

  protected cancelAsk(e: Event): void {
    e.stopPropagation();
    this.asking.set(false);
  }

  protected async ask(): Promise<void> {
    const question = this.question().trim();
    if (!question || this.busy()) return;
    this.busy.set(true);
    const options = splitOptions(this.options());
    const created = await this.store.createInputRequest({
      workstreamId: this.ws().id,
      question,
      options: options.length ? options : undefined,
      assigneeUserId: this.assignee() || undefined,
    });
    this.busy.set(false);
    if (created) this.asking.set(false);
  }
}
