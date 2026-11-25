import { ChangeDetectionStrategy, Component } from '@angular/core';

/**
 * "Divider / Weave" (v3 Brand assets §04): a hairline that a single amber warp thread crosses, sitting on
 * the page margin. Used at most twice per page to separate big sections; the other sections keep a plain rule.
 * The line stops 4px before the margin so the thread lands exactly on it (20 / 40 / 120px).
 */
@Component({
  selector: 'app-site-weave',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'flex h-[25px] w-full items-center',
    role: 'separator',
    'aria-hidden': 'true',
  },
  template: `
    <span
      class="bg-border h-px w-[calc(max(0px,(100%-1440px)/2)+16px)] shrink-0 md:w-[calc(max(0px,(100%-1440px)/2)+36px)] xl:w-[calc(max(0px,(100%-1440px)/2)+116px)]"
    ></span>
    <span class="relative h-[25px] w-[9px] shrink-0">
      <span class="bg-primary absolute top-0 left-[4px] h-[25px] w-px"></span>
    </span>
    <span class="bg-border h-px flex-1"></span>
  `,
})
export class SiteWeave {}
