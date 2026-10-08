import { ChangeDetectionStrategy, Component, DestroyRef, effect, inject, input } from '@angular/core';
import { PageChrome, type PageTitle } from '../layout/page-chrome';

/**
 * Page title + optional toolbar. The title and description are rendered by the shell's top bar
 * (one Linear-style header row: breadcrumb › title · description … actions), so pages don't
 * repeat their name twice. Projected slots render in a compact toolbar row under the top bar,
 * which is hidden when nothing is projected:
 *   [leading]  icon / status glyph
 *   [meta]     key chip, badges
 *   [actions]  right-aligned controls (layout toggles, scope switches)
 *   default    tabs / filter row rendered under the toolbar (optional)
 *
 *   <app-page-header title="Workstreams" description="Everything in flight">
 *     <button actions hlmBtn size="sm">New</button>
 *   </app-page-header>
 */
@Component({
  selector: 'app-page-header',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <h1 class="sr-only">{{ title() }}</h1>
    <div
      class="hidden min-h-10 flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-1.5 sm:px-6 [&:has(>:not(.spacer))]:flex"
    >
      <ng-content select="[leading]" />
      <ng-content select="[meta]" />
      <span class="spacer flex-1"></span>
      <ng-content select="[actions]" />
    </div>
    <ng-content />
  `,
})
export class PageHeader {
  readonly title = input.required<string>();
  readonly description = input<string>();

  constructor() {
    const chrome = inject(PageChrome);
    let mine: PageTitle | null = null;
    effect(() => chrome.page.set((mine = { title: this.title(), description: this.description() })));
    inject(DestroyRef).onDestroy(() => {
      if (chrome.page() === mine) chrome.page.set(null);
    });
  }
}
