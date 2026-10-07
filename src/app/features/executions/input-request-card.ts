// An agent's question: open → answer inline (free text or suggested options); answered → history line.
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideCircleHelp, LucideDynamicIcon } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmTextareaImports } from '@spartan-ng/helm/textarea';
import { NablaStore, type InputRequest } from '../../core';
import { ActorAvatar } from '../../shared/actor-avatar';
import { Kbd } from '../../shared/kbd';
import { RelativeTimePipe } from '../../shared/pipes';

@Component({
  selector: 'app-input-request-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ActorAvatar, HlmButtonImports, HlmTextareaImports, LucideDynamicIcon, RelativeTimePipe, RouterLink, Kbd],
  host: { class: 'block' },
  template: `
    @let r = request();
    <div class="rounded-lg border p-3" [class]="r.state === 'open' ? 'border-status-needs-input/40 bg-status-needs-input/5' : ''">
      <div class="flex items-start gap-2.5">
        <app-actor-avatar [actor]="r.requestedBy" [size]="22" class="mt-0.5" />
        <div class="min-w-0 flex-1">
          <div class="text-muted-foreground flex flex-wrap items-center gap-x-2 text-xs">
            <span class="text-foreground font-medium">{{ store.actorName(r.requestedBy) }}</span>
            <span>asked {{ r.createdAt | relativeTime }}</span>
            @if (showExecution() && execution(); as e) {
              <span>in</span>
              <a class="text-foreground hover:underline" [routerLink]="['/', store.slug(), 'executions', e.id]">{{ e.title }}</a>
            }
            @if (r.state === 'open') {
              <span class="text-status-needs-input ml-auto inline-flex items-center gap-1"><svg [lucideIcon]="help" [size]="12"></svg>Needs input</span>
            }
          </div>
          <p class="mt-1 text-sm">{{ r.question }}</p>

          @if (r.state === 'open') {
            @if (canAnswer()) {
              @if (r.options?.length) {
                <div class="mt-2 flex flex-wrap gap-1.5">
                  @for (o of r.options; track o) {
                    <button hlmBtn size="sm" variant="outline" type="button" class="h-auto min-h-7 py-1 whitespace-normal" (click)="answer(o)">{{ o }}</button>
                  }
                </div>
              }
              <textarea
                hlmTextarea
                class="mt-2 min-h-14 w-full"
                rows="2"
                [placeholder]="r.options?.length ? 'Or write a different answer…' : 'Write an answer…'"
                aria-label="Answer"
                [value]="draft()"
                (input)="draft.set($any($event.target).value)"
                (keydown.meta.enter)="answer(draft())"
                (keydown.control.enter)="answer(draft())"
              ></textarea>
              <div class="mt-1.5 flex items-center gap-2">
                <button hlmBtn size="sm" type="button" [disabled]="!draft().trim() || busy()" (click)="answer(draft())">
                  Answer <app-kbd keys="mod+enter" class="opacity-70 max-sm:hidden" />
                </button>
                <button hlmBtn size="sm" variant="ghost" type="button" (click)="dismiss()">Dismiss</button>
              </div>
            }
          } @else if (r.state === 'answered') {
            <div class="bg-muted/60 mt-2 rounded-md px-2.5 py-1.5 text-sm">
              <span class="text-muted-foreground text-xs">{{ store.getUser(r.answeredById)?.name ?? 'Someone' }} answered {{ r.answeredAt | relativeTime }}</span>
              <p>{{ r.answer }}</p>
            </div>
          } @else {
            <p class="text-muted-foreground mt-1 text-xs">Dismissed</p>
          }
        </div>
      </div>
    </div>
  `,
})
export class InputRequestCard {
  protected readonly store = inject(NablaStore);
  readonly request = input.required<InputRequest>();
  readonly showExecution = input(true);
  protected readonly draft = signal('');
  protected readonly busy = signal(false);
  protected readonly help = LucideCircleHelp;
  protected readonly canAnswer = computed(() => this.store.can('member'));
  protected readonly execution = computed(() => this.store.getExecution(this.request().executionId));

  protected async answer(text: string): Promise<void> {
    const a = text.trim();
    if (!a || this.busy()) return;
    this.busy.set(true);
    await this.store.answerInput(this.request().id, a);
    this.busy.set(false);
    this.draft.set('');
  }

  protected dismiss(): void {
    void this.store.dismissInput(this.request().id);
  }
}
