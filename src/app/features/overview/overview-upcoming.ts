import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideArrowRight, LucideDynamicIcon } from '@lucide/angular';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import { KeyChip } from '../../shared/key-chip';
import { StatusIcon } from '../../shared/status';
import { MilestoneIcon } from '../milestones/milestone-icon';
import { HEALTH_VIEW, OverviewModel } from './overview-model';

/**
 * Two quiet columns: workstreams that are blocked, late or projected late, and what is due in the
 * next 14 days (milestones and workstream target dates) as a small timeline.
 */
@Component({
  selector: 'app-overview-upcoming',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, LucideDynamicIcon, HlmTooltip, KeyChip, StatusIcon, MilestoneIcon],
  host: { class: 'block' },
  template: `
    <div class="grid gap-x-10 gap-y-7 md:grid-cols-2">
      <section aria-labelledby="ov-risk" class="min-w-0">
        <header class="mb-1 flex items-baseline gap-3 border-b pb-2">
          <h2 id="ov-risk" class="text-sm font-medium">At risk</h2>
          <span class="text-meta tabular-nums">{{ m.atRiskRows().length }}</span>
          <span class="flex-1"></span>
          <span class="text-meta">blocked, overdue or projected late</span>
        </header>
        <ul>
          @for (r of riskTop(); track r.ws.id) {
            <li>
              <a [routerLink]="['/', m.slug(), 'workstreams', r.ws.key]" class="hover:bg-hover -mx-2 flex min-h-9 items-center gap-2.5 rounded-md px-2 py-1.5">
                <app-status-icon entity="workstream" [status]="r.ws.status" />
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-[13px]">{{ r.ws.title }}</span>
                  <span class="text-meta flex items-center gap-1.5">
                    <app-key-chip [value]="r.ws.key" /> <span aria-hidden="true">·</span> <span>{{ r.reason }}</span>
                  </span>
                </span>
                <span class="inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[11px] font-medium" [class]="health[r.health].pill">{{ health[r.health].label }}</span>
              </a>
            </li>
          } @empty {
            <li class="text-meta py-3">Nothing is blocked, overdue or slipping. Nice.</li>
          }
        </ul>
        @if (m.atRiskRows().length > riskTop().length) {
          <a [routerLink]="['/', m.slug(), 'workstreams']" class="text-meta hover:text-foreground mt-1 inline-flex items-center gap-1">
            {{ m.atRiskRows().length - riskTop().length }} more at risk <svg [lucideIcon]="arrow" [size]="12"></svg>
          </a>
        }
      </section>

      <section aria-labelledby="ov-next" class="min-w-0">
        <header class="mb-1 flex items-baseline gap-3 border-b pb-2">
          <h2 id="ov-next" class="text-sm font-medium">Next 14 days</h2>
          <span class="flex-1"></span>
          <a [routerLink]="['/', m.slug(), 'timeline']" class="text-meta hover:text-foreground inline-flex items-center gap-1">
            Timeline <svg [lucideIcon]="arrow" [size]="12"></svg>
          </a>
        </header>
        <ul class="relative">
          @for (u of m.upcoming(); track u.id) {
            <li>
              <a
                [routerLink]="['/', m.slug(), 'workstreams', u.ws.key]"
                class="hover:bg-hover -mx-2 grid min-h-9 grid-cols-[2.75rem_auto_minmax(0,1fr)_auto] items-center gap-x-2.5 rounded-md px-2 py-1.5"
              >
                <span class="text-meta tabular-nums" [class.text-status-blocked]="u.overdue">{{ u.dateText }}</span>
                @if (u.kind === 'milestone') {
                  <app-milestone-icon [fraction]="u.fraction" [state]="u.state ?? 'idle'" />
                } @else {
                  <app-status-icon entity="workstream" [status]="u.ws.status" />
                }
                <span class="min-w-0">
                  <span class="block truncate text-[13px]">{{ u.name }}</span>
                  <span class="text-meta flex min-w-0 items-center gap-1.5">
                    <app-key-chip [value]="u.ws.key" />
                    @if (u.kind === 'milestone') {
                      <span class="truncate">· {{ u.ws.title }}</span>
                    }
                  </span>
                </span>
                <span class="flex flex-col items-end text-end">
                  <span class="text-[12px] whitespace-nowrap tabular-nums" [class.text-status-blocked]="u.overdue" [class.text-muted-foreground]="!u.overdue">{{ u.when }}</span>
                  <span class="text-meta whitespace-nowrap tabular-nums" [hlmTooltip]="u.kind === 'milestone' ? 'Milestone progress' : 'Linked issues done'" position="left">{{ u.progress }}</span>
                </span>
              </a>
            </li>
          } @empty {
            <li class="text-meta py-3">No milestones or target dates in the next 14 days.</li>
          }
        </ul>
        @if (m.upcomingMore() > 0) {
          <a [routerLink]="['/', m.slug(), 'timeline']" class="text-meta hover:text-foreground mt-1 inline-flex items-center gap-1">
            {{ m.upcomingMore() }} more on the timeline <svg [lucideIcon]="arrow" [size]="12"></svg>
          </a>
        }
      </section>
    </div>
  `,
})
export class OverviewUpcoming {
  protected readonly m = inject(OverviewModel);
  protected readonly health = HEALTH_VIEW;
  protected readonly arrow = LucideArrowRight;
  protected readonly riskTop = computed(() => this.m.atRiskRows().slice(0, 5));
}
