// The section header of the task page (v3 "06 Task detail"): Newsreader 20 title, a mono 10.5 faint caption on the
// same baseline, whatever is projected on the right, and one hairline under it.
import { ChangeDetectionStrategy, Component, input } from '@angular/core';

@Component({
  selector: 'app-task-section-head',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'border-border flex w-full min-w-0 items-end gap-2.5 border-b pb-2' },
  template: `
    <h2 class="font-title text-foreground shrink-0 text-[20px] leading-[19px]">{{ title() }}</h2>
    @if (caption()) {
      <span class="text-faint min-w-0 truncate pb-px font-mono text-[10.5px] leading-[13px] max-sm:hidden">{{ caption() }}</span>
    }
    <span class="flex-1"></span>
    <ng-content />
  `,
})
export class TaskSectionHead {
  readonly title = input.required<string>();
  readonly caption = input<string>();
}
