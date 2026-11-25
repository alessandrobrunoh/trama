import { ChangeDetectionStrategy, Component, input } from '@angular/core';

let nextId = 0;

/**
 * A titled group of charts (v3 section head: Newsreader 20 title over a hairline) with a plain-words introduction
 * that says what is counted and what is left out.
 */
@Component({
  selector: 'app-stat-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block mb-10' },
  template: `
    <section [attr.aria-labelledby]="id">
      <div class="border-border mb-4 border-b pb-2">
        <h2 [id]="id" class="font-title text-foreground text-[24px] leading-[30px]">{{ title() }}</h2>
        @if (description()) {
          <p class="text-muted-foreground mt-0.5 max-w-3xl text-[12.5px] leading-snug">{{ description() }}</p>
        }
      </div>
      <ng-content />
    </section>
  `,
})
export class StatSection {
  readonly title = input.required<string>();
  readonly description = input<string | undefined>(undefined);
  protected readonly id = `stat-section-${nextId++}`;
}
