// The "Code · Outcome · Next" line above the acceptance criteria.
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import type { Workstream } from '../../core';
import { completionSummary } from './completion-summary';

@Component({
  selector: 'app-ws-completion-line',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmTooltip],
  host: { class: 'block' },
  template: `
    <p class="text-muted-foreground mb-2 text-[13px] leading-snug" data-testid="completion-line">
      <span>Code: <b class="text-foreground font-medium">{{ s().code }}</b></span>
      <span aria-hidden="true"> · </span>
      <span>Outcome: <b class="font-medium" [class]="s().achieved ? 'text-status-shipped' : 'text-foreground'">{{ s().result }}</b></span>
      <span aria-hidden="true"> · </span>
      <span>Next: <b class="text-foreground font-medium">{{ s().next }}</b></span>
      @if (s().pinned) {
        <span
          class="bg-muted ml-1.5 rounded px-1.5 py-px text-[11px]"
          hlmTooltip="The status was pinned by hand: it does not say whether the outcome is achieved."
          >manually pinned</span
        >
      }
    </p>
  `,
})
export class WsCompletionLine {
  readonly ws = input.required<Workstream>();
  protected readonly s = computed(() => completionSummary(this.ws()));
}
