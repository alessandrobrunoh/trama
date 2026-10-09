import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { HlmTabsImports } from '@spartan-ng/helm/tabs';
import { TramaStore } from '../../core/stores/trama.store';
import { NotificationsStore } from '../../core/stores/notifications.store';
import { PageHeader } from '../../shared/page-header';
import { AttentionPage } from '../attention/attention-page';
import { NotificationsPage } from '../notifications/notifications-page';
import { OnboardingChecklist } from '../onboarding/onboarding-checklist';

type InboxTab = 'needs-you' | 'updates' | 'later';
const TABS: readonly InboxTab[] = ['needs-you', 'updates', 'later'];

/**
 * `/:workspace/inbox`: one place for everything addressed to you. It replaces My Attention and Notifications.
 *   Needs you   questions, decisions, reviews, blockers and deadlines waiting on a human (attention queue)
 *   Updates     assignments, comments and status changes that concern you (notifications)
 *   Snoozed & dismissed   what you set aside, one click from coming back
 * The tab lives in `?tab=`, so every state has a link; `/attention` and `/notifications` redirect here.
 */
@Component({
  selector: 'app-inbox-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmTabsImports, PageHeader, AttentionPage, NotificationsPage, OnboardingChecklist],
  host: { class: 'flex min-h-full flex-col' },
  template: `
    <app-page-header title="Inbox" [description]="summary()">
      <div class="px-4 sm:px-6">
        <hlm-tabs [tab]="current()" (tabActivated)="select($event)">
          <hlm-tabs-list variant="line" class="-mb-px h-9 p-0">
            <button hlmTabsTrigger="needs-you" class="px-2">
              Needs you
              <span class="text-muted-foreground ms-1.5 text-xs tabular-nums">{{ needsYou() }}</span>
            </button>
            <button hlmTabsTrigger="updates" class="px-2">
              Updates
              @if (notifications.unread()) {
                <span class="bg-primary text-primary-foreground ms-1.5 min-w-[18px] rounded-full px-1.5 text-center text-[10px] leading-[16px] font-semibold tabular-nums">{{ notifications.unread() }}</span>
              }
            </button>
            <button hlmTabsTrigger="later" class="px-2">
              Snoozed &amp; dismissed
              <span class="text-muted-foreground ms-1.5 text-xs tabular-nums">{{ later() }}</span>
            </button>
          </hlm-tabs-list>
        </hlm-tabs>
      </div>
    </app-page-header>

    <app-onboarding-checklist compact class="px-4 pt-3 sm:px-6" />

    @switch (current()) {
      @case ('updates') {
        <app-notifications-page />
      }
      @case ('later') {
        <app-attention-page [tab]="'archived'" [workspaceSlug]="workspaceSlug()" />
      }
      @default {
        <app-attention-page [tab]="'open'" [workspaceSlug]="workspaceSlug()" />
      }
    }
  `,
})
export class InboxPage {
  /** From the parent `:workspaceSlug` route segment. */
  readonly workspaceSlug = input<string>();
  /** From `?tab=`. */
  readonly tab = input<string>();

  protected readonly store = inject(TramaStore);
  protected readonly notifications = inject(NotificationsStore);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  protected readonly current = computed<InboxTab>(() => {
    const t = this.tab();
    return (TABS as readonly string[]).includes(t ?? '') ? (t as InboxTab) : 'needs-you';
  });

  protected readonly needsYou = computed(() => this.store.attentionCount());
  protected readonly later = computed(() => this.store.attention().filter((a) => a.state !== 'open').length);

  protected readonly summary = computed(() => {
    const parts: string[] = [];
    const n = this.needsYou();
    if (n) parts.push(`${n} need${n === 1 ? 's' : ''} you`);
    const u = this.notifications.unread();
    if (u) parts.push(`${u} unread`);
    return parts.join(' · ') || 'All clear';
  });

  protected select(tab: unknown): void {
    if (typeof tab !== 'string' || !(TABS as readonly string[]).includes(tab) || tab === this.current()) return;
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { tab },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }
}
