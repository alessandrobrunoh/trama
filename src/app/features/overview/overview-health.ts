import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { LucideArrowRight, LucideDynamicIcon, LucidePlus } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import { map } from 'rxjs';
import { UiStore } from '../../core';
import { ActorAvatar } from '../../shared/actor-avatar';
import { EmptyState } from '../../shared/empty-state';
import { KeyChip } from '../../shared/key-chip';
import { ShortDatePipe } from '../../shared/pipes';
import { StatusIcon } from '../../shared/status';
import { NextMilestoneChip } from '../milestones/milestone-chips';
import { HEALTH_VIEW, OverviewModel } from './overview-model';

const CAP = 9;

/**
 * Active workstreams as compact cards, most urgent first: health, issue progress, next milestone,
 * accountable person and target date. The filter lives in the URL (`?filter=risk|mine|team:KEY`).
 */
@Component({
  selector: 'app-overview-health',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, LucideDynamicIcon, HlmButtonImports, HlmTooltip, ActorAvatar, EmptyState, KeyChip, ShortDatePipe, StatusIcon, NextMilestoneChip],
  host: { class: 'block' },
  template: `
    <section aria-labelledby="ov-health">
      <header class="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 id="ov-health" class="text-sm font-medium">Workstream health</h2>
        <span class="text-meta tabular-nums">{{ m.activeCount() }} active</span>
        <span class="flex-1"></span>
        <a [routerLink]="['/', m.slug(), 'workstreams']" class="text-meta hover:text-foreground inline-flex items-center gap-1">
          All workstreams <svg [lucideIcon]="arrow" [size]="12"></svg>
        </a>
      </header>

      @if (m.activeCount() === 0) {
        <app-empty-state title="No active workstreams" description="A workstream is an outcome that resolves one or more issues. Start one to coordinate the work.">
          <button hlmBtn size="sm" (click)="ui.openCreate('workstream')"><svg [lucideIcon]="plus" [size]="14"></svg> New workstream</button>
        </app-empty-state>
      } @else {
        <div class="-mx-4 mb-3 overflow-x-auto px-4 scrollbar-none sm:mx-0 sm:px-0" role="group" aria-label="Filter workstreams">
          <div class="flex w-max items-center gap-1.5 sm:w-auto sm:flex-wrap">
            @for (c of chips(); track c.id) {
              <button
                type="button"
                class="hover:bg-hover inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs whitespace-nowrap transition-colors"
                [class.bg-accent]="filter() === c.id"
                [class.border-border-strong]="filter() === c.id"
                [class.text-foreground]="filter() === c.id"
                [class.text-muted-foreground]="filter() !== c.id"
                [attr.aria-pressed]="filter() === c.id"
                (click)="setFilter(c.id)"
              >
                {{ c.label }} <span class="tabular-nums opacity-70">{{ c.count }}</span>
              </button>
            }
          </div>
        </div>

        @if (visible().length === 0) {
          <div class="text-meta flex flex-col items-start gap-2 py-6">
            <span>No active workstreams match this filter.</span>
            <button hlmBtn variant="outline" size="sm" (click)="setFilter('all')">Show all</button>
          </div>
        } @else {
          <ul class="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-3">
            @for (r of visible(); track r.ws.id) {
              <li class="flex min-w-0">
                <a
                  [routerLink]="['/', m.slug(), 'workstreams', r.ws.key]"
                  class="border-border hover:border-border-strong hover:bg-hover focus-visible:ring-ring/50 flex min-w-0 flex-1 flex-col gap-2.5 rounded-lg border p-3 outline-none transition-colors focus-visible:ring-2"
                >
                  <div class="flex items-center gap-2">
                    <app-status-icon entity="workstream" [status]="r.ws.status" />
                    <app-key-chip [value]="r.ws.key" />
                    <span class="flex-1"></span>
                    <span class="inline-flex h-5 items-center rounded-full px-2 text-[11px] font-medium whitespace-nowrap" [class]="health[r.health].pill" [hlmTooltip]="r.reason" position="left">
                      {{ health[r.health].label }}
                    </span>
                  </div>
                  <p class="line-clamp-2 min-h-[2.5rem] text-[13px] leading-5 font-medium">{{ r.ws.title }}</p>

                  <div class="flex items-center gap-2">
                    @if (r.total > 0) {
                      <span class="bg-foreground/[0.08] h-1 flex-1 overflow-hidden rounded-full" role="img" [attr.aria-label]="r.done + ' of ' + r.total + ' issues done'">
                        <span class="bg-status-shipped block h-full rounded-full" [style.width.%]="r.fraction * 100"></span>
                      </span>
                      <span class="text-meta tabular-nums">{{ r.done }}/{{ r.total }} issues</span>
                    } @else {
                      <span class="text-meta">No issues yet</span>
                    }
                  </div>

                  <div class="mt-auto flex min-h-5 items-center gap-2">
                    <app-next-milestone [workstreamId]="r.ws.id" class="min-w-0" />
                    <span class="flex-1"></span>
                    @if (r.ws.targetDate) {
                      <span class="text-meta tabular-nums" [class.text-status-blocked]="r.overdue" [hlmTooltip]="r.overdue ? 'Past its target date' : 'Target date'" position="top">{{ r.ws.targetDate | shortDate }}</span>
                    }
                    @if (r.ws.accountableUserId) {
                      <app-actor-avatar [actor]="{ type: 'user', id: r.ws.accountableUserId }" [size]="18" />
                    }
                  </div>
                </a>
              </li>
            }
          </ul>
          @if (filtered().length > visible().length) {
            <a [routerLink]="['/', m.slug(), 'workstreams']" class="text-muted-foreground hover:text-foreground mt-3 inline-flex items-center gap-1 text-xs">
              View all {{ filtered().length }} <svg [lucideIcon]="arrow" [size]="12"></svg>
            </a>
          }
        }
      }
    </section>
  `,
})
export class OverviewHealth {
  protected readonly m = inject(OverviewModel);
  protected readonly ui = inject(UiStore);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  protected readonly health = HEALTH_VIEW;
  protected readonly arrow = LucideArrowRight;
  protected readonly plus = LucidePlus;

  private readonly param = toSignal(this.route.queryParamMap.pipe(map((q) => q.get('filter') ?? 'all')), { initialValue: 'all' });
  protected readonly filter = computed(() => {
    const p = this.param();
    return p === 'risk' || p === 'mine' || p.startsWith('team:') ? p : 'all';
  });

  protected readonly chips = computed(() => {
    const rows = this.m.rows();
    const out = [
      { id: 'all', label: 'All', count: rows.length },
      { id: 'risk', label: 'At risk', count: this.m.atRiskRows().length },
      { id: 'mine', label: 'Mine', count: rows.filter((r) => r.mine).length },
    ];
    for (const { team, count } of this.m.teamsWithWork()) out.push({ id: `team:${team.key}`, label: team.name, count });
    return out;
  });

  protected readonly filtered = computed(() => {
    const f = this.filter();
    const rows = this.m.rows();
    if (f === 'risk') return this.m.atRiskRows();
    if (f === 'mine') return rows.filter((r) => r.mine);
    if (f.startsWith('team:')) {
      const key = f.slice(5).toUpperCase();
      const teamId = this.m.teamsWithWork().find((t) => t.team.key.toUpperCase() === key)?.team.id;
      return rows.filter((r) => r.ws.ownerTeamId === teamId);
    }
    return rows;
  });
  protected readonly visible = computed(() => this.filtered().slice(0, CAP));

  protected setFilter(id: string): void {
    void this.router.navigate([], { queryParams: { filter: id === 'all' ? null : id }, queryParamsHandling: 'merge', replaceUrl: true });
  }
}
