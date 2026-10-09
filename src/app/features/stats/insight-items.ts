import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { InsightItem } from '../../core';
import { ActorAvatar } from '../../shared/actor-avatar';
import { KeyChip } from '../../shared/key-chip';
import { actorRef, formatAge, itemLink, itemTypeLabel } from './insights-model';

/**
 * The rows behind a metric: what causes the number. Each row links to the item, says in one
 * sentence why it is listed, and shows how long it has been like that and who has to act.
 */
@Component({
  selector: 'app-insight-items',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet, RouterLink, ActorAvatar, KeyChip],
  host: { class: 'block' },
  template: `
    @if (rows().length) {
      <ul class="divide-border divide-y" [attr.aria-label]="ariaLabel()">
        @for (r of rows(); track r.item.id + ':' + $index) {
          <li>
            @if (r.link; as link) {
              <a [routerLink]="link" class="hover:bg-hover focus-visible:ring-ring/50 -mx-2 flex items-start gap-3 rounded-md px-2 py-2 outline-none focus-visible:ring-2">
                <ng-container *ngTemplateOutlet="row; context: { $implicit: r }" />
              </a>
            } @else {
              <div class="-mx-2 flex items-start gap-3 px-2 py-2">
                <ng-container *ngTemplateOutlet="row; context: { $implicit: r }" />
              </div>
            }
          </li>
        }
      </ul>
    } @else {
      <p class="text-meta py-4 text-center">{{ empty() }}</p>
    }

    <ng-template #row let-r>
      <span class="min-w-0 flex-1">
        <span class="flex min-w-0 items-baseline gap-2">
          @if (r.item.key) {
            <app-key-chip [value]="r.item.key" />
          } @else {
            <span class="text-meta shrink-0 text-[10px] tracking-wide uppercase">{{ r.type }}</span>
          }
          <span class="truncate text-[13px] font-medium">{{ r.item.title }}</span>
        </span>
        <span class="text-muted-foreground mt-0.5 block text-xs">{{ r.item.detail }}</span>
      </span>
      <span class="flex shrink-0 flex-col items-end gap-1">
        @if (r.age) {
          <span class="bg-muted text-foreground rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums" [attr.title]="r.sinceTitle">{{ r.age }}</span>
        }
        @if (showWaiting() && r.item.waitingOn; as who) {
          <span class="text-meta inline-flex items-center gap-1 text-[11px]">
            @if (r.ref) {
              <app-actor-avatar [actor]="r.ref" [size]="14" />
            }
            <span class="max-w-28 truncate">{{ who.name }}</span>
          </span>
        }
      </span>
    </ng-template>
  `,
})
export class InsightItems {
  readonly items = input.required<readonly InsightItem[]>();
  readonly slug = input.required<string>();
  readonly empty = input('Nothing here.');
  readonly ariaLabel = input<string | undefined>(undefined);
  /** Show who has to act (off when the list is already about one person). */
  readonly showWaiting = input(true);

  protected readonly rows = computed(() =>
    this.items().map((item) => ({
      item,
      link: itemLink(this.slug(), item),
      type: itemTypeLabel(item.type),
      age: formatAge(item.ageDays),
      sinceTitle: item.since ? `Since ${new Date(item.since).toLocaleDateString()}` : null,
      ref: actorRef(item.waitingOn),
    })),
  );
}
