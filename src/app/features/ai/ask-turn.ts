import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import type { ActivityStep } from '../../core/ai/ai-api';
import { EntityRefs } from '../../shared/entity-ref';
import { Markdown } from '../../shared/markdown';
import { ActivitySteps } from './activity-steps';

/** One question and the answer to it, as the Ask page lays them out. */
export interface AskTurnData {
  question: string;
  /** Null while the answer is still being prepared (the page shows the live reply instead). */
  answer: string | null;
  /** What the assistant looked at or changed to answer: the numbered rows under the answer. */
  sources: readonly ActivityStep[];
  /** The assistant's own commentary while it worked; folded behind "Worked for N seconds". */
  notes: readonly ActivityStep[];
  seconds: number | null;
}

/**
 * v3 "10 Ask": mono kicker, a 30px serif question, the answer in sans 15.5/26 and the numbered
 * sources in a hairline box.
 */
@Component({
  selector: 'app-ask-turn',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Markdown, ActivitySteps],
  host: { class: 'flex w-full flex-col gap-6' },
  template: `
    <div class="flex w-full flex-col gap-2">
      <div class="text-faint flex items-center gap-3 font-mono text-[10.5px] uppercase">
        <span class="min-w-0 flex-1 truncate">
          Question · asked by {{ asker() }}
          @if (when()) {
            · {{ when() }}
          }
        </span>
      </div>
      <h2
        class="font-title text-foreground text-[24px] leading-[30px] [overflow-wrap:anywhere] whitespace-pre-wrap md:text-[30px] md:leading-9"
      >
        {{ turn().question }}
      </h2>
    </div>

    @if (turn().answer !== null) {
      <div class="flex w-full flex-col gap-3.5">
        <app-markdown
          class="text-foreground text-[15.5px]! leading-[26px]!"
          [source]="turn().answer"
          [link]="refs.linker()"
        />
        @if (turn().sources.length) {
          <ol class="border-border divide-border w-full divide-y border" aria-label="Sources">
            @for (s of turn().sources; track $index) {
              <li class="flex items-center gap-3 px-3.5 py-2.5">
                <span
                  class="bg-secondary text-foreground flex size-5 shrink-0 items-center justify-center font-mono text-[10.5px]"
                  >{{ $index + 1 }}</span
                >
                <span class="text-muted-foreground shrink-0 font-mono text-[11px]">{{
                  s.kind === 'write' ? 'changed' : 'read'
                }}</span>
                <span
                  class="min-w-0 flex-1 text-[13px]"
                  [class]="s.ok === false ? 'text-red' : 'text-foreground'"
                >
                  {{ s.label }}
                  @if (s.count && s.count > 1) {
                    <span class="text-faint font-mono text-[11px]">×{{ s.count }}</span>
                  }
                  @if (s.ok === false) {
                    · failed
                    @if (s.detail) {
                      <span class="text-muted-foreground block text-xs">{{ s.detail }}</span>
                    }
                  }
                </span>
              </li>
            }
          </ol>
        }
        @if (turn().notes.length) {
          <details class="group">
            <summary
              class="text-faint hover:text-foreground w-fit cursor-pointer list-none font-mono text-[11px] select-none [&::-webkit-details-marker]:hidden"
            >
              Worked for {{ seconds() }}
            </summary>
            <app-activity-steps class="mt-2" [steps]="turn().notes" />
          </details>
        }
      </div>
    }
  `,
})
export class AskTurn {
  protected readonly refs = inject(EntityRefs);
  readonly turn = input.required<AskTurnData>();
  readonly asker = input('you');
  /** "2m ago": when the answer was saved. */
  readonly when = input<string | null>(null);
  protected readonly seconds = computed(() => {
    const s = this.turn().seconds;
    return s === null ? 'a while' : `${s} ${s === 1 ? 'second' : 'seconds'}`;
  });
}
