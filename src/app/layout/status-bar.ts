import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  TemplateRef,
  inject,
  viewChild,
  effect,
} from '@angular/core';
import { PageChrome } from './page-chrome';

/**
 * Page context for the shell's status bar (layout/shell-status-bar.ts), shown between the sync info
 * and the shortcuts hint. A page declares it anywhere in its template; the shell renders it pinned
 * under the scroll area, outside the page, so it never scrolls away:
 *
 *   <app-status-bar>
 *     <span>12 tasks</span>
 *     <span class="text-muted-foreground">in Trama / filtered by "bug"</span>
 *     <button end hlmBtn variant="ghost" size="xs">Group: status</button>
 *   </app-status-bar>
 *
 * Default content flows left; elements carrying the `end` attribute are pushed to the right. Both
 * sides are flex rows with a 12px gap. `<app-status-bar>` itself renders nothing in the page, and
 * the bar is hidden on phones.
 */
@Component({
  selector: 'app-status-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'hidden' },
  template: `
    <ng-template #bar>
      <!-- rendered inside the shell's status bar (layout/shell-status-bar.ts) -->
      <div class="flex min-w-0 flex-1 items-center gap-3 truncate"><ng-content /></div>
      <div class="flex shrink-0 items-center gap-2"><ng-content select="[end]" /></div>
    </ng-template>
  `,
})
export class StatusBar {
  private readonly chrome = inject(PageChrome);
  private readonly bar = viewChild.required<TemplateRef<unknown>>('bar');

  constructor() {
    let mine: TemplateRef<unknown> | null = null;
    effect(() => this.chrome.statusBar.set((mine = this.bar())));
    inject(DestroyRef).onDestroy(() => {
      if (this.chrome.statusBar() === mine) this.chrome.statusBar.set(null);
    });
  }
}
