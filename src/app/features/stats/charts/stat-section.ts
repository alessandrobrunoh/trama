import { ChangeDetectionStrategy, Component, input } from '@angular/core';

let nextId = 0;

/** A titled group of charts with a plain-words introduction that says what is counted and what is left out. */
@Component({
  selector: 'app-stat-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block mb-10' },
  template: `
    <section [attr.aria-labelledby]="id">
      <h2 [id]="id" class="text-base">{{ title() }}</h2>
      @if (description()) {
        <p class="text-meta mt-1 mb-4 max-w-3xl text-xs">{{ description() }}</p>
      }
      <ng-content />
    </section>
  `,
})
export class StatSection {
  readonly title = input.required<string>();
  readonly description = input<string | undefined>(undefined);
  protected readonly id = `stat-section-${nextId++}`;
}
