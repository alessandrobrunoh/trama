import { ChangeDetectionStrategy, Component, OnDestroy, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideCopy, LucideDynamicIcon, LucideSparkles } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { Clipboard, TramaStore } from '../../core';
import { Markdown } from '../../shared/markdown';
import { AiActions } from './ai-actions.service';
import { AiButton } from './ai-button';
import { AiResult } from './ai-result';

/**
 * "Standup digest": what changed in the last day and week, workstreams at risk, overdue milestones
 * and the issues waiting longest, written by the AI from store data. Self-contained: drop it
 * anywhere (`<app-ai-digest-card />`). Nothing is requested until the person presses Generate.
 */
@Component({
  selector: 'app-ai-digest-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButtonImports, LucideDynamicIcon, RouterLink, AiButton, AiResult, Markdown],
  host: { class: 'block' },
  template: `
    <section class="bg-card border-border-strong rounded-lg border px-3 py-2.5" aria-labelledby="ai-digest-title">
      <header class="flex items-center gap-1.5">
        <svg [lucideIcon]="sparkles" [size]="14" [strokeWidth]="1.75" class="text-entity-workstream"></svg>
        <h3 id="ai-digest-title" class="text-[13px] font-medium">Standup digest</h3>
        <span class="flex-1"></span>
        @if (job.state() === 'idle') {
          <app-ai-button label="Generate" variant="secondary" size="xs" tooltip="Write today's digest" (pressed)="generate()" />
        } @else if (job.state() === 'done') {
          <button hlmBtn variant="ghost" size="xs" type="button" class="text-muted-foreground" (click)="copy()">
            <svg [lucideIcon]="copyIcon" [size]="12"></svg>Copy
          </button>
          <button hlmBtn variant="ghost" size="xs" type="button" class="text-muted-foreground" (click)="job.reset()">Clear</button>
        }
      </header>

      @if (job.state() === 'idle') {
        <p class="text-muted-foreground mt-1 text-xs leading-snug">
          What moved in the last day and week, what is at risk, and what has waited longest.
          @if (!ai.available() && ai.checked()) {
            <a class="hover:text-foreground underline-offset-2 hover:underline" [routerLink]="ai.settingsLink()">Enable AI</a> to generate it.
          } @else {
            Sends titles and statuses of {{ scope() }} to your configured AI provider.
          }
        </p>
      } @else {
        <div class="mt-2">
          <app-ai-result bare title="Standup digest" [state]="job.state()" [error]="job.error()" [autofocus]="false" (cancel)="job.cancel()" (retry)="generate()" (regenerate)="generate()" (closed)="job.reset()">
            <div class="max-h-96 overflow-y-auto">
              <app-markdown [source]="job.result()" />
            </div>
          </app-ai-result>
        </div>
      }
    </section>
  `,
})
export class AiDigestCard implements OnDestroy {
  protected readonly ai = inject(AiActions);
  private readonly store = inject(TramaStore);
  private readonly clipboard = inject(Clipboard);
  protected readonly sparkles = LucideSparkles;
  protected readonly copyIcon = LucideCopy;
  protected readonly job = this.ai.job<string>((signal) => this.ai.standupDigest(signal));
  protected readonly scope = computed(() => {
    const w = this.store.workstreams().filter((x) => x.status !== 'shipped' && x.status !== 'canceled').length;
    const i = this.store.issues().filter((x) => x.status !== 'done' && x.status !== 'canceled').length;
    return `${w} active workstream${w === 1 ? '' : 's'} and ${i} open issue${i === 1 ? '' : 's'}`;
  });

  constructor() {
    this.ai.touch();
  }

  ngOnDestroy(): void {
    this.job.cancel();
  }

  protected generate(): void {
    this.ai.markNoted();
    void this.job.start();
  }

  protected copy(): void {
    const text = this.job.result();
    if (text) void this.clipboard.copy(text, 'Digest copied');
  }
}
