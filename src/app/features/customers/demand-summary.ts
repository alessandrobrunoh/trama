import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideCircleCheck, LucideDynamicIcon, LucideStar, LucideUsers } from '@lucide/angular';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import { TramaStore, type Demand } from '../../core';
import { CustomerAvatar } from './customer-avatar';
import { compactNumber, type RequestState } from './customer-model';

/**
 * "Who is waiting on this": the customers behind an issue, project or workstream, how many requests,
 * how many are flagged important and how much revenue they stand for. Says "Delivered to" once the work is
 * done. Shows nothing when nobody asked.
 *   <app-demand-summary [demand]="store.demand().get(issue.id)" state="open" />
 */
@Component({
  selector: 'app-demand-summary',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, LucideDynamicIcon, HlmTooltip, CustomerAvatar],
  host: { class: 'block' },
  template: `
    @if (demand(); as d) {
      <section class="bg-card border-border rounded-lg border px-3 py-2.5" aria-label="Customer demand">
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h2 class="flex items-center gap-1.5 text-[13px] font-semibold">
            <svg [lucideIcon]="state() === 'delivered' ? doneIcon : usersIcon" [size]="14" [class]="state() === 'delivered' ? 'text-tone-green' : 'text-muted-foreground'"></svg>
            {{ heading() }}
          </h2>
          <span class="text-muted-foreground flex flex-wrap items-center gap-x-3 text-xs tabular-nums">
            <span>{{ d.customerCount }} {{ d.customerCount === 1 ? 'customer' : 'customers' }}</span>
            <span>{{ d.requestCount }} {{ d.requestCount === 1 ? 'request' : 'requests' }}</span>
            @if (d.importantCount) {
              <span class="text-tone-amber inline-flex items-center gap-1"><svg [lucideIcon]="starIcon" [size]="11" fill="currentColor"></svg>{{ d.importantCount }} important</span>
            }
            @if (d.revenue) {
              <span [hlmTooltip]="'Annual revenue of these customers, added up'">{{ compact(d.revenue) }} revenue</span>
            }
          </span>
        </div>
        <ul class="mt-2 flex flex-wrap gap-1.5">
          @for (c of shown(); track c.id) {
            <li>
              <a
                [routerLink]="['/', slug(), 'customers', c.id]"
                class="border-border hover:bg-accent inline-flex h-6 items-center gap-1.5 rounded-full border ps-1 pe-2 text-xs"
              >
                <app-customer-avatar [customer]="c" [size]="14" />
                <span class="max-w-36 truncate">{{ c.name }}</span>
                @if (tierOf(c.tierId); as tier) {
                  <span class="size-1.5 rounded-full" [style.background]="tier.color" [hlmTooltip]="tier.name"></span>
                }
              </a>
            </li>
          }
          @if (more() > 0) {
            <li class="text-muted-foreground inline-flex h-6 items-center text-xs">+{{ more() }} more</li>
          }
        </ul>
      </section>
    }
  `,
})
export class DemandSummary {
  private readonly store = inject(TramaStore);

  readonly demand = input<Demand | undefined>();
  /** open: customers are waiting; delivered: the work is done; dropped: the work was canceled. */
  readonly state = input<RequestState>('open');
  /** How many customers to name before "+N more". */
  readonly limit = input(8);

  protected readonly usersIcon = LucideUsers;
  protected readonly doneIcon = LucideCircleCheck;
  protected readonly starIcon = LucideStar;
  protected readonly compact = compactNumber;
  protected readonly slug = computed(() => this.store.slug() ?? '');
  protected readonly heading = computed(() => {
    const s = this.state();
    return s === 'delivered' ? 'Delivered to' : s === 'dropped' ? 'Customers who asked' : 'Customers waiting';
  });
  private readonly customers = computed(() =>
    (this.demand()?.customerIds ?? []).flatMap((id) => {
      const c = this.store.getCustomer(id);
      return c ? [c] : [];
    }),
  );
  protected readonly shown = computed(() => this.customers().slice(0, this.limit()));
  protected readonly more = computed(() => Math.max(0, this.customers().length - this.limit()));

  protected tierOf(id: string | undefined) {
    return id ? this.store.settings().customerTiers.find((t) => t.id === id) : undefined;
  }
}
