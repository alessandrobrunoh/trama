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
 * Slim status bar under the main pane (one muted 12px row: breadcrumb-like context on the left,
 * compact controls on the right). A page declares it anywhere in its template; the shell renders it
 * pinned under the scroll area, outside the page, so it never scrolls away:
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
      <div
        role="status"
        class="text-muted-foreground flex h-8 min-w-0 shrink-0 items-center gap-3 border-t border-border bg-background px-3 text-xs max-md:hidden"
      >
        <div class="flex min-w-0 flex-1 items-center gap-3 truncate"><ng-content /></div>
        <div class="flex shrink-0 items-center gap-2"><ng-content select="[end]" /></div>
      </div>
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
