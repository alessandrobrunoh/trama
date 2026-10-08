import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  model,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import {
  LucideCheck,
  LucideClock,
  LucideDynamicIcon,
  LucideExternalLink,
  LucideEllipsis,
  LucideMessageSquareReply,
  LucideRotateCcw,
  LucideX,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import { HlmTextareaImports } from '@spartan-ng/helm/textarea';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import { toast } from '@spartan-ng/brain/sonner';
import { NablaStore, shortDate, type AttentionItem } from '../../core';
import { Kbd, KeyChip } from '../../shared';
import { AgoPipe } from '../overview/ago';
import { ATTENTION_KIND_VIEW, SEVERITY_VIEW } from './attention-kinds';
import { snoozePresets, type SnoozePreset } from './snooze';

/**
 * One My Attention row: icon, title, detail, workstream key, since, and the inline actions that
 * resolve it (answer an input request, accept/reject a decision, open the PR, snooze, dismiss).
 */
@Component({
  selector: 'app-attention-row',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    LucideDynamicIcon,
    HlmButtonImports,
    HlmDropdownMenuImports,
    HlmTextareaImports,
    HlmTooltip,
    Kbd,
    KeyChip,
    AgoPipe,
  ],
  host: {
    class: 'group/row relative block border-b outline-none',
    '[attr.data-row-id]': 'item().id',
    '[attr.data-focused]': 'focused() ? "" : null',
    '[class.bg-accent/60]': 'focused()',
    '(click)': 'rowClicked.emit()',
  },
  template: `
    <span
      class="absolute inset-y-0 start-0 w-0.5"
      [class]="severityBar()"
      aria-hidden="true"
    ></span>

    <div
      class="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-2 px-4 py-2.5 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:px-6"
    >
      <svg [lucideIcon]="kind().icon" [size]="16" [strokeWidth]="1.75" class="mt-0.5" [class]="kind().color"></svg>

      <div class="min-w-0">
        <div class="flex min-w-0 items-baseline gap-2">
          <a
            [routerLink]="primaryLink().commands"
            [queryParams]="primaryLink().query"
            class="hover:underline min-w-0 truncate text-sm font-medium focus-visible:underline focus-visible:outline-none"
            >{{ item().title }}</a
          >
          @if (item().severity === 'high' && mode() === 'open') {
            <span class="text-status-blocked shrink-0 text-[11px] font-medium">High</span>
          }
        </div>
        @if (item().detail) {
          <p class="text-meta mt-0.5 line-clamp-2 sm:truncate">{{ item().detail }}</p>
        }

        @if (mode() === 'open') {
          @if (item().kind === 'input_requested' && request(); as ir) {
            @if (!answering()) {
              <div class="mt-2 flex flex-wrap items-center gap-1.5">
                @for (o of ir.options ?? []; track o) {
                  <button hlmBtn variant="outline" size="sm" class="max-sm:h-9" (click)="answer(o)">
                    {{ o }}
                  </button>
                }
                <button hlmBtn variant="ghost" size="sm" class="max-sm:h-9" (click)="answering.set(true)">
                  <svg [lucideIcon]="reply" [size]="14"></svg>
                  {{ (ir.options?.length ?? 0) > 0 ? 'Other answer' : 'Answer' }}
                  <app-kbd keys="a" class="max-sm:hidden" />
                </button>
              </div>
            } @else {
              <div class="mt-2 flex flex-col gap-2">
                <textarea
                  #answerBox
                  hlmTextarea
                  rows="2"
                  class="min-h-16 max-w-xl"
                  placeholder="Write an answer for {{ requesterName() }}…"
                  aria-label="Answer"
                  [value]="draft()"
                  (input)="draft.set($any($event.target).value)"
                  (keydown.meta.enter)="send()"
                  (keydown.control.enter)="send()"
                  (keydown.escape)="cancelAnswer($event)"
                ></textarea>
                <div class="flex flex-wrap items-center gap-1.5">
                  <button hlmBtn size="sm" class="max-sm:h-9" [disabled]="!draft().trim()" (click)="send()">
                    Send answer
                    <app-kbd keys="mod+enter" class="max-sm:hidden" />
                  </button>
                  <button hlmBtn variant="ghost" size="sm" class="max-sm:h-9" (click)="cancelAnswer()">Cancel</button>
                </div>
              </div>
            }
          }

          @if (item().kind === 'needs_decision' && decisionId()) {
            <div class="mt-2 flex flex-wrap items-center gap-1.5">
              <button hlmBtn variant="outline" size="sm" class="max-sm:h-9" (click)="accept()">
                <svg [lucideIcon]="check" [size]="14" class="text-status-shipped"></svg>
                Accept
              </button>
              <button hlmBtn variant="ghost" size="sm" class="max-sm:h-9" (click)="reject()">
                <svg [lucideIcon]="x" [size]="14"></svg>
                Reject
              </button>
            </div>
          }
        }
      </div>

      <div
        class="col-span-full flex items-center gap-2 max-sm:ps-7 sm:col-span-1 sm:justify-end"
      >
        @if (wsKey(); as k) {
          <a
            [routerLink]="['/', slug(), 'workstreams', k]"
            class="hover:bg-accent -m-1 rounded p-1 max-sm:me-auto"
            tabindex="-1"
          >
            <app-key-chip [value]="k" />
          </a>
        }
        <span class="text-meta w-9 text-end tabular-nums max-sm:w-auto" [class.max-sm:me-auto]="!wsKey()">{{ item().since | ago }}</span>

        @if (mode() === 'open') {
          <div
            class="flex items-center gap-0.5 sm:opacity-0 sm:transition-opacity sm:group-hover/row:opacity-100 sm:group-focus-within/row:opacity-100 sm:group-data-[focused]/row:opacity-100"
          >
            @if (artifactUrl(); as url) {
              <a
                hlmBtn
                variant="ghost"
                size="icon-sm"
                class="max-sm:size-9"
                [href]="url"
                target="_blank"
                rel="noopener noreferrer"
                hlmTooltip="Open pull request"
                position="bottom"
                aria-label="Open pull request"
              >
                <svg [lucideIcon]="external" [size]="14"></svg>
              </a>
            }
            <button
              hlmBtn
              variant="ghost"
              size="icon-sm"
              class="max-sm:size-9"
              [hlmDropdownMenuTrigger]="snoozeMenu"
              align="end"
              hlmTooltip="Snooze (S)"
              position="bottom"
              aria-label="Snooze"
            >
              <svg [lucideIcon]="clock" [size]="14"></svg>
            </button>
            <button
              hlmBtn
              variant="ghost"
              size="icon-sm"
              class="max-sm:size-9"
              hlmTooltip="Dismiss (E)"
              position="bottom"
              aria-label="Dismiss"
              (click)="dismiss.emit()"
            >
              <svg [lucideIcon]="x" [size]="14"></svg>
            </button>
            <button
              hlmBtn
              variant="ghost"
              size="icon-sm"
              class="max-sm:size-9"
              [hlmDropdownMenuTrigger]="moreMenu"
              align="end"
              aria-label="More actions"
            >
              <svg [lucideIcon]="more" [size]="14"></svg>
            </button>
          </div>
        } @else {
          <span class="text-meta hidden sm:inline">{{ archivedLabel() }}</span>
          <button hlmBtn variant="outline" size="sm" class="max-sm:h-9" (click)="restore.emit()">
            <svg [lucideIcon]="undo" [size]="13"></svg>
            Restore
          </button>
        }
      </div>
      @if (mode() === 'archived') {
        <span class="text-meta col-span-full ps-7 sm:hidden">{{ archivedLabel() }}</span>
      }
    </div>

    <ng-template #snoozeMenu>
      <hlm-dropdown-menu class="w-52">
        <hlm-dropdown-menu-label>Snooze until</hlm-dropdown-menu-label>
        <hlm-dropdown-menu-group>
          @for (p of presets(); track p.id) {
            <button hlmDropdownMenuItem (triggered)="snooze.emit(p.until)">
              {{ p.label }}
              <hlm-dropdown-menu-shortcut>{{ p.hint }}</hlm-dropdown-menu-shortcut>
            </button>
          }
        </hlm-dropdown-menu-group>
        <hlm-dropdown-menu-separator />
        <button hlmDropdownMenuItem (triggered)="pickDate.emit()">Pick a date…</button>
      </hlm-dropdown-menu>
    </ng-template>

    <ng-template #moreMenu>
      <hlm-dropdown-menu class="w-52">
        @if (item().workstreamId && wsKey(); as k) {
          <button hlmDropdownMenuItem (triggered)="go(['/', slug(), 'workstreams', k])">Open workstream</button>
        }
        @if (artifactUrl(); as url) {
          <button hlmDropdownMenuItem (triggered)="openExternal(url)">Open pull request</button>
        }
        <hlm-dropdown-menu-separator />
        <button hlmDropdownMenuItem (triggered)="dismiss.emit()">
          Dismiss
          <hlm-dropdown-menu-shortcut><app-kbd keys="e" /></hlm-dropdown-menu-shortcut>
        </button>
      </hlm-dropdown-menu>
    </ng-template>
  `,
})
export class AttentionRow {
  protected readonly store = inject(NablaStore);

  readonly item = input.required<AttentionItem>();
  readonly slug = input.required<string>();
  readonly mode = input<'open' | 'archived'>('open');
  readonly focused = input(false);
  /** Two-way: the inline answer editor is open (the page opens it for the `A` shortcut). */
  readonly answering = model(false);

  readonly dismiss = output<void>();
  readonly snooze = output<string>();
  readonly pickDate = output<void>();
  readonly restore = output<void>();
  readonly rowClicked = output<void>();

  private readonly box = viewChild<ElementRef<HTMLTextAreaElement>>('answerBox');
  protected readonly draft = signal('');

  protected readonly clock = LucideClock;
  protected readonly x = LucideX;
  protected readonly check = LucideCheck;
  protected readonly external = LucideExternalLink;
  protected readonly more = LucideEllipsis;
  protected readonly undo = LucideRotateCcw;
  protected readonly reply = LucideMessageSquareReply;

  protected readonly kind = computed(() => ATTENTION_KIND_VIEW[this.item().kind]);
  protected readonly severityBar = computed(() => (this.mode() === 'open' ? SEVERITY_VIEW[this.item().severity].bar : 'bg-transparent'));
  protected readonly ws = computed(() => {
    const id = this.item().workstreamId;
    return id ? this.store.workstreamById().get(id) : undefined;
  });
  protected readonly wsKey = computed(() => this.ws()?.key);
  protected readonly request = computed(() => {
    const id = this.item().inputRequestId;
    return id ? this.store.inputRequestById().get(id) : undefined;
  });
  protected readonly requesterName = computed(() => {
    const r = this.request();
    return r ? this.store.actorName(r.requestedBy) : 'the agent';
  });
  protected readonly decisionId = computed(() => this.item().decisionId);
  protected readonly artifactUrl = computed(() => {
    const id = this.item().artifactId;
    return id ? this.store.artifactById().get(id)?.url : undefined;
  });
  protected readonly presets = computed<SnoozePreset[]>(() => snoozePresets());

  protected readonly primaryLink = computed<{ commands: unknown[]; query?: Record<string, string> }>(() => {
    const it = this.item();
    const slug = this.slug();
    switch (it.kind) {
      case 'needs_decision': {
        const d = it.decisionId ? this.store.decisionById().get(it.decisionId) : undefined;
        if (d) return { commands: ['/', slug, 'decisions', d.key] };
        break;
      }
      case 'triage': {
        const i = it.issueId ? this.store.issueById().get(it.issueId) : undefined;
        const q: Record<string, string> = { status: 'backlog' };
        if (i?.teamId) q['team'] = i.teamId;
        return { commands: ['/', slug, 'issues'], query: q };
      }
      case 'input_requested':
      case 'blocked':
        break;
    }
    const k = this.wsKey();
    return { commands: k ? ['/', slug, 'workstreams', k] : ['/', slug, 'workstreams'] };
  });

  protected readonly archivedLabel = computed(() => {
    const it = this.item();
    if (it.state === 'snoozed') return it.snoozedUntil ? `Snoozed until ${shortDate(it.snoozedUntil)}` : 'Snoozed';
    return 'Dismissed';
  });

  constructor() {
    effect(() => {
      const el = this.box();
      if (el) untracked(() => el.nativeElement.focus());
    });
  }

  protected async answer(text: string): Promise<void> {
    const id = this.item().inputRequestId;
    if (!id || !text.trim()) return;
    const ok = await this.store.answerInput(id, text.trim());
    if (ok) toast.success('Answer sent', { description: `${this.requesterName()} can continue.` });
    this.draft.set('');
    this.answering.set(false);
  }

  protected send(): void {
    void this.answer(this.draft());
  }

  protected cancelAnswer(ev?: Event): void {
    ev?.stopPropagation();
    this.answering.set(false);
  }

  protected async accept(): Promise<void> {
    const id = this.decisionId();
    if (id && (await this.store.acceptDecision(id))) toast.success('Decision accepted');
  }

  protected async reject(): Promise<void> {
    const id = this.decisionId();
    if (id && (await this.store.rejectDecision(id))) toast.success('Decision rejected');
  }

  private readonly router = inject(Router);

  protected go(commands: unknown[]): void {
    void this.router.navigate(commands);
  }

  protected openExternal(url: string): void {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}
