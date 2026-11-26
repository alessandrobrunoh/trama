// One row of the Inbox list (v3 "03 · Inbox"): unread mark · 15px icon · title over a one-line subline · time.
// 60px tall with its hairline. A click selects the row (its preview opens on the right); on a phone, where there
// is no preview column, it opens the item. Double-click or Enter opens it everywhere.
import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { LucideDynamicIcon } from '@lucide/angular';
import { AgoPipe } from '../../shared/ago';
import type { InboxEntry } from './inbox-model';

@Component({
  selector: 'app-inbox-row',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideDynamicIcon, AgoPipe],
  host: {
    class:
      'border-border flex cursor-default items-start gap-3 border-b px-4 py-3 outline-none select-none',
    role: 'option',
    '[attr.aria-selected]': 'focused()',
    '[attr.data-row-id]': 'entry().id',
    '[attr.data-focused]': 'focused() ? "" : null',
    '[class.bg-secondary]': 'focused()',
    '[class.hover:bg-hover]': '!focused()',
    '(click)': 'onClick($event)',
    '(dblclick)': 'open.emit()',
  },
  template: `
    @let e = entry();
    <span class="flex h-[18px] w-1.5 shrink-0 items-center" aria-hidden="true">
      @if (marked()) {
        <span class="bg-red size-1.5"></span>
      }
    </span>
    @if (marked()) {
      <span class="sr-only">{{ e.unread ? 'Unread' : 'Needs you' }}</span>
    }
    <svg
      [lucideIcon]="e.icon"
      [size]="15"
      [strokeWidth]="1.75"
      class="mt-px shrink-0"
      [class]="e.iconColor"
      aria-hidden="true"
    ></svg>
    <div class="flex min-w-0 flex-1 flex-col gap-[3px]">
      <span
        class="truncate text-[13px] leading-[17px]"
        [class.text-foreground]="marked()"
        [class.text-muted-foreground]="!marked()"
        >{{ e.sentence }}</span
      >
      <span class="text-faint truncate text-[12px] leading-[15px]">{{ subline() }}</span>
    </div>
    <time class="text-faint shrink-0 font-mono text-[10.5px] leading-[17px]" [attr.datetime]="e.at">{{
      e.at | ago
    }}</time>
  `,
})
export class InboxRow {
  readonly entry = input.required<InboxEntry>();
  readonly focused = input(false);
  /** Open on a single click (phones, where there is no preview column). */
  readonly openOnClick = input(false);

  /** The row was clicked: it becomes the selected row. */
  readonly rowClicked = output<void>();
  /** Open what the row points at. */
  readonly open = output<void>();

  /** Unread updates and open items that wait on you get the red mark and the bright title. */
  protected readonly marked = computed(() => this.entry().unread || this.entry().section === 'action');

  /** Line two: the task key (unless the title already names it), then the short text. */
  protected readonly subline = computed(() => {
    const e = this.entry();
    const parts: string[] = [];
    if (e.key && !e.sentence.includes(e.key)) parts.push(e.key);
    if (e.text && e.text !== e.sentence) parts.push(e.text);
    return parts.join(' · ');
  });

  protected onClick(e: MouseEvent): void {
    this.rowClicked.emit();
    if (this.openOnClick() && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey) this.open.emit();
  }
}
