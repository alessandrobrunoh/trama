import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import {
  LucideCircleAlert,
  LucideCircleCheck,
  LucideClock,
  LucideDynamicIcon,
  LucideFlag,
  LucideHourglass,
  LucideTrendingDown,
  LucideUserRoundX,
  type LucideIcon,
} from '@lucide/angular';
import { PreviewLink } from '../issues/list-preview';
import { OverviewLinks, TONE_VAR } from './overview-links';
import type { WatchItem, WatchKind } from './overview-model';

const ICONS: Record<WatchKind, LucideIcon> = {
  needs_you: LucideCircleAlert,
  stale: LucideClock,
  held_up: LucideHourglass,
  milestone_overdue: LucideFlag,
  project_slipping: LucideTrendingDown,
  unowned_urgent: LucideUserRoundX,
};

/**
 * "Worth a look": the few things most worth opening, each with the reason in plain words (line one) and what it is
 * (line two). Same two-line shape as the Inbox rows, so the page reads like the rest of the app.
 */
@Component({
  selector: 'app-overview-watch',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideDynamicIcon, PreviewLink],
  host: { class: 'block' },
  template: `
    @if (items().length === 0) {
      <p class="text-muted-foreground flex items-start gap-2.5 py-2 text-[13px] leading-snug">
        <svg [lucideIcon]="okIcon" [size]="16" [strokeWidth]="1.75" class="mt-px shrink-0" style="color: var(--tone-green)"></svg>
        Nothing stands out. No stale work, late milestones or slipping projects.
      </p>
    } @else {
      <ol class="-mx-2 flex flex-col">
        @for (item of items(); track item.id) {
          <li>
            <a
              [appPreviewLink]="links.route(item.target)"
              (preview)="links.show(item.target)"
              class="hover:bg-hover focus-visible:ring-ring/50 grid grid-cols-[1rem_minmax(0,1fr)] gap-x-2.5 rounded-md px-2 py-2 outline-none focus-visible:ring-2"
              [class.bg-selected]="links.isPreviewed(item.target)"
            >
              <svg
                [lucideIcon]="icons[item.kind]"
                [size]="16"
                [strokeWidth]="1.75"
                class="mt-0.5"
                [style.color]="tone(item.tone)"
                aria-hidden="true"
              ></svg>
              <span class="flex min-w-0 flex-col gap-0.5">
                <span class="text-[13px] leading-snug">{{ item.reason }}</span>
                <span class="text-meta flex min-w-0 items-baseline gap-2">
                  @if (item.key) {
                    <span class="shrink-0 font-mono">{{ item.key }}</span>
                  }
                  <span class="truncate">{{ item.title }}</span>
                </span>
              </span>
            </a>
          </li>
        }
      </ol>
    }
  `,
})
export class OverviewWatch {
  protected readonly links = inject(OverviewLinks);
  readonly items = input.required<readonly WatchItem[]>();

  protected readonly icons = ICONS;
  protected readonly okIcon = LucideCircleCheck;

  protected tone(t: WatchItem['tone']): string {
    return TONE_VAR[t];
  }
}
