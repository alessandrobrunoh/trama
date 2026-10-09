import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { LucideBell, LucideCheck, LucideCheckCheck, LucideDynamicIcon } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmToggleGroupImports } from '@spartan-ng/helm/toggle-group';
import { TramaStore, NotificationsStore, UiStore, usePageShortcuts, type Notification } from '../../core';
import { ActorAvatar } from '../../shared/actor-avatar';
import { EmptyState } from '../../shared/empty-state';
import { RelativeTimePipe } from '../../shared/pipes';
import { NOTIFICATION_KIND_VISUAL } from './notification-kinds';

type Filter = 'all' | 'unread';

/** The "Updates" tab of the Inbox: what happened that concerns you, newest first. */
@Component({
  selector: 'app-notifications-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideDynamicIcon, HlmButtonImports, HlmToggleGroupImports, ActorAvatar, EmptyState, RelativeTimePipe],
  host: { class: 'flex flex-1 flex-col' },
  template: `
    <div class="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-1.5 sm:px-6">
      <p class="text-meta" aria-live="polite">{{ description() }}</p>
      <span class="flex-1"></span>
      <hlm-toggle-group
        type="single"
        variant="outline"
        size="sm"
        [value]="filter()"
        (valueChange)="setFilter($event)"
        aria-label="Which updates"
      >
        <button hlmToggleGroupItem value="all" class="max-sm:h-9">All</button>
        <button hlmToggleGroupItem value="unread" class="max-sm:h-9">Unread</button>
      </hlm-toggle-group>
      <button hlmBtn variant="outline" size="sm" class="max-sm:h-9" [disabled]="!store.unread()" (click)="store.markRead()">
        <svg [lucideIcon]="doneIcon" [size]="14"></svg>
        Mark all as read
      </button>
    </div>

    @for (g of groups(); track g.label) {
      <section [attr.aria-label]="g.label">
        <header class="bg-muted/40 flex h-8 items-center gap-2 border-b px-4 sm:px-6">
          <h2 class="text-xs font-medium">{{ g.label }}</h2>
          <span class="text-muted-foreground text-xs tabular-nums">{{ g.items.length }}</span>
        </header>
        @for (n of g.items; track n.id) {
          <div class="group/row relative" [class.bg-accent/60]="ui.focusedRowId() === n.id">
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
          @if (!n.readAt) {
            <button
              type="button"
              hlmBtn
              variant="ghost"
              size="sm"
              class="text-muted-foreground bg-background/90 absolute end-4 top-1/2 hidden h-7 -translate-y-1/2 px-2 text-xs group-hover/row:flex focus-visible:flex max-sm:hidden"
              [attr.aria-label]="'Mark as read: ' + n.title"
              (click)="markRead(n)"
            >
              <svg [lucideIcon]="readIcon" [size]="13"></svg>
              Mark read
            </button>
          }
          </div>
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
  private readonly trama = inject(TramaStore);
  private readonly router = inject(Router);

  protected readonly visual = NOTIFICATION_KIND_VISUAL;
  protected readonly bellIcon = LucideBell;
  protected readonly doneIcon = LucideCheckCheck;
  protected readonly readIcon = LucideCheck;
  protected readonly ui = inject(UiStore);
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

  protected readonly description = computed(() => {
    const n = this.store.unread();
    return n ? `${n} unread` : 'Everything is read';
  });

  private readonly focusedUnread = computed(() => {
    const id = this.ui.focusedRowId();
    return id ? this.store.items().find((n) => n.id === id && !n.readAt) : undefined;
  });

  private readonly _keys = usePageShortcuts([
    {
      keys: 'e',
      label: 'Mark update as read',
      when: () => !!this.focusedUnread(),
      run: () => this.markRead(this.focusedUnread()!),
    },
  ]);

  protected markRead(n: Notification): void {
    void this.store.markRead([n.id]);
  }

  protected setFilter(value: unknown): void {
    if (value === 'all' || value === 'unread') this.filter.set(value);
  }

  protected open(n: Notification): void {
    if (!n.readAt) void this.store.markRead([n.id]);
    void this.router.navigate(['/', this.trama.slug(), ...n.link.split('/')]);
  }

  protected openSettings(): void {
    void this.router.navigate(['/', this.trama.slug(), 'settings', 'notifications']);
  }
}
