import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { LucideBell, LucideCheckCheck, LucideDynamicIcon } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmToggleGroupImports } from '@spartan-ng/helm/toggle-group';
import { NablaStore, NotificationsStore, type Notification } from '../../core';
import { ActorAvatar } from '../../shared/actor-avatar';
import { EmptyState } from '../../shared/empty-state';
import { PageHeader } from '../../shared/page-header';
import { RelativeTimePipe } from '../../shared/pipes';
import { NOTIFICATION_KIND_VISUAL } from './notification-kinds';

type Filter = 'all' | 'unread';

/** `/:workspace/notifications`: what happened that concerns you, newest first. */
@Component({
  selector: 'app-notifications-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideDynamicIcon, HlmButtonImports, HlmToggleGroupImports, ActorAvatar, EmptyState, PageHeader, RelativeTimePipe],
  host: { class: 'flex min-h-full flex-col' },
  template: `
    <app-page-header title="Notifications" description="What happened that concerns you">
      <hlm-toggle-group
        actions
        type="single"
        variant="outline"
        size="sm"
        [value]="filter()"
        (valueChange)="setFilter($event)"
        aria-label="Which notifications"
      >
        <button hlmToggleGroupItem value="all" class="max-sm:h-9">All</button>
        <button hlmToggleGroupItem value="unread" class="max-sm:h-9">
          Unread
          @if (store.unread()) {
            <span class="text-muted-foreground ms-1.5 text-xs tabular-nums">{{ store.unread() }}</span>
          }
        </button>
      </hlm-toggle-group>
      <button actions hlmBtn variant="outline" size="sm" class="max-sm:h-9" [disabled]="!store.unread()" (click)="store.markRead()">
        <svg [lucideIcon]="doneIcon" [size]="14"></svg>
        Mark all as read
      </button>
    </app-page-header>

    @for (g of groups(); track g.label) {
      <section [attr.aria-label]="g.label">
        <header class="bg-muted/40 flex h-8 items-center gap-2 border-b px-4 sm:px-6">
          <h2 class="text-xs font-medium">{{ g.label }}</h2>
          <span class="text-muted-foreground text-xs tabular-nums">{{ g.items.length }}</span>
        </header>
        @for (n of g.items; track n.id) {
          <button
            type="button"
            class="hover:bg-hover focus-visible:bg-hover flex w-full items-start gap-3 border-b px-4 py-3 text-left outline-none sm:px-6"
            [attr.data-row-id]="n.id"
            (click)="open(n)"
          >
            <span class="mt-1.5 flex size-2 shrink-0 items-center justify-center" aria-hidden="true">
              @if (!n.readAt) {
                <span class="bg-primary size-2 rounded-full"></span>
              }
            </span>
            <span class="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md" [class]="visual[n.kind].tint">
              <svg [lucideIcon]="visual[n.kind].icon" [size]="14"></svg>
            </span>
            <span class="min-w-0 flex-1">
              <span class="block text-[13px] leading-snug" [class.font-medium]="!n.readAt" [class.text-muted-foreground]="!!n.readAt">{{ n.title }}</span>
              @if (n.body) {
                <span class="text-muted-foreground mt-0.5 line-clamp-2 block text-xs leading-relaxed">{{ n.body }}</span>
              }
            </span>
            <span class="flex shrink-0 items-center gap-2">
              <app-actor-avatar [actor]="n.actor" [size]="18" />
              <time class="text-muted-foreground min-w-16 text-right text-xs whitespace-nowrap tabular-nums" [attr.datetime]="n.createdAt">{{ n.createdAt | relativeTime }}</time>
            </span>
          </button>
        }
      </section>
    } @empty {
      <app-empty-state
        class="m-auto"
        [icon]="bellIcon"
        [title]="filter() === 'unread' ? 'Nothing unread' : 'You are all caught up'"
        description="Assignments, questions, reviews, failing checks and comments that concern you show up here. Choose what you hear about in Settings → Notifications."
      >
        <button hlmBtn variant="outline" size="sm" (click)="openSettings()">Notification settings</button>
      </app-empty-state>
    }
  `,
})
export class NotificationsPage {
  protected readonly store = inject(NotificationsStore);
  private readonly nabla = inject(NablaStore);
  private readonly router = inject(Router);

  protected readonly visual = NOTIFICATION_KIND_VISUAL;
  protected readonly bellIcon = LucideBell;
  protected readonly doneIcon = LucideCheckCheck;
  protected readonly filter = signal<Filter>('all');

  protected readonly groups = computed(() => {
    const items = this.store.items().filter((n) => this.filter() === 'all' || !n.readAt);
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const today = startOfToday.getTime();
    const yesterday = today - 24 * 60 * 60 * 1000;
    const buckets: { label: string; items: Notification[] }[] = [
      { label: 'Today', items: [] },
      { label: 'Yesterday', items: [] },
      { label: 'Earlier', items: [] },
    ];
    for (const n of items) {
      const at = new Date(n.createdAt).getTime();
      buckets[at >= today ? 0 : at >= yesterday ? 1 : 2].items.push(n);
    }
    return buckets.filter((b) => b.items.length);
  });

  protected setFilter(value: unknown): void {
    if (value === 'all' || value === 'unread') this.filter.set(value);
  }

  protected open(n: Notification): void {
    if (!n.readAt) void this.store.markRead([n.id]);
    void this.router.navigate(['/', this.nabla.slug(), ...n.link.split('/')]);
  }

  protected openSettings(): void {
    void this.router.navigate(['/', this.nabla.slug(), 'settings', 'notifications']);
  }
}
