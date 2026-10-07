import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * In-page header (below the shell's breadcrumb bar). Slots:
 *   [leading]  icon / status glyph before the title
 *   [meta]     key chip, badges after the title
 *   [actions]  right-aligned buttons
 *   default    tabs / filter row rendered under the title (optional)
 *
 *   <app-page-header title="Workstreams" description="Everything in flight">
 *     <button actions hlmBtn size="sm">New</button>
 *   </app-page-header>
 */
@Component({
  selector: 'app-page-header',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block border-b' },
  template: `
    <div class="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2 sm:px-6">
      <ng-content select="[leading]" />
      <div class="min-w-0 flex-1">
        <div class="flex min-w-0 items-center gap-2">
          <h1 class="truncate text-base font-semibold tracking-tight">{{ title() }}</h1>
          <ng-content select="[meta]" />
        </div>
        @if (description()) {
          <p class="text-meta mt-0.5 truncate">{{ description() }}</p>
        }
      </div>
      <div class="flex shrink-0 items-center gap-2 empty:hidden">
        <ng-content select="[actions]" />
      </div>
    </div>
    <ng-content />
  `,
})
export class PageHeader {
  readonly title = input.required<string>();
  readonly description = input<string>();
}
