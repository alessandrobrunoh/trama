import { ChangeDetectionStrategy, Component, computed, inject, OnInit } from '@angular/core';
import { LucideBell, LucideDynamicIcon, LucideMail, LucideSmartphone, type LucideIcon } from '@lucide/angular';
import { HlmCheckbox } from '@spartan-ng/helm/checkbox';
import {
  NOTIFICATION_KIND_META,
  type NotificationChannel,
  type NotificationKind,
} from '../../../core/contracts/domain';
import { NotificationsStore } from '../../../core/stores/notifications.store';
import { SECTION_KIT } from './section-kit';

/** A band of the matrix: a mono caption over the kinds it holds. */
interface KindGroup {
  title: string;
  kinds: readonly NotificationKind[];
}

/**
 * Settings → Notifications (v4 frame): a matrix of what Trama tells you about (rows, in bands) by channel
 * (columns), then the delivery card for this device. Personal: the same in every workspace.
 */
@Component({
  selector: 'app-notifications-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmCheckbox, LucideDynamicIcon, ...SECTION_KIT],
  host: { class: 'flex flex-col gap-9 leading-[normal]' },
  template: `
    <app-section-header
      flush
      title="Notifications"
      description="Choose what reaches you and where. Everything always lands in your Inbox."
    />

    @if (!store.emailAvailable() || !store.pushAvailable()) {
      <div class="border-primary/40 bg-primary/10 flex flex-wrap items-center gap-3 border px-3.5 py-3">
        <svg [lucideIcon]="mailIcon" [size]="16" class="text-primary shrink-0" aria-hidden="true"></svg>
        <div class="flex min-w-0 flex-1 flex-col gap-0.5">
          <span class="text-foreground text-[13px]">{{ bannerTitle() }}</span>
          <span class="text-muted-foreground text-[12px]">
            An admin adds <code class="font-mono">SMTP_URL</code> for email and VAPID keys for push. Until then those columns are off.
          </span>
        </div>
      </div>
    }

    <div class="bg-card border-border overflow-x-auto border">
      <div class="min-w-[520px]">
        <div class="bg-bg-deep flex items-center pl-4">
          <div class="text-faint flex-1 py-2.5 font-mono text-[10.5px]">WHEN</div>
          @for (channel of channels; track channel.id) {
            <div class="flex w-20 shrink-0 flex-col items-center gap-[3px] py-2.5 sm:w-24" [class.opacity-55]="unavailable(channel.id)">
              <span class="text-text-2 flex items-center gap-[5px] font-mono text-[10.5px]">
                <svg [lucideIcon]="channel.icon" [size]="12" aria-hidden="true"></svg>{{ channel.label }}
              </span>
              <span class="font-mono text-[9.5px]" [class]="channelStateClass(channel.id)">{{ channelState(channel.id) }}</span>
            </div>
          }
        </div>

        @for (group of groups; track group.title) {
          <div class="bg-card border-border text-muted-foreground border-t px-4 py-[7px] font-mono text-[10.5px]">{{ group.title }}</div>
          @for (kind of group.kinds; track kind) {
            <div class="border-border flex items-center border-t pl-4">
              <div class="flex min-w-0 flex-1 flex-col gap-0.5 py-2.5 pr-3">
                <span class="text-foreground text-[13px]">{{ meta[kind].label }}</span>
                <span class="text-faint text-[11.5px]">{{ meta[kind].description }}</span>
              </div>
              @for (channel of channels; track channel.id) {
                <div class="flex w-20 shrink-0 justify-center sm:w-24" [class.opacity-40]="unavailable(channel.id)">
                  <hlm-checkbox
                    [checked]="store.settings()[kind][channel.id]"
                    [aria-label]="meta[kind].label + ': ' + channel.label"
                    (checkedChange)="store.setChannel(kind, channel.id, $event)"
                  />
                </div>
              }
            </div>
          }
        }
      </div>
    </div>

    <app-settings-block title="Delivery">
      <app-settings-card>
        <app-card-row label="System notifications on this device" [description]="deviceHint()">
          <app-switch
            [checked]="store.pushSubscribed()"
            [disabled]="!canTogglePush()"
            (checkedChange)="togglePush($event)"
            aria-label="System notifications on this device"
          />
        </app-card-row>
      </app-settings-card>
    </app-settings-block>
  `,
})
export class NotificationsSection implements OnInit {
  protected readonly store = inject(NotificationsStore);

  protected readonly meta = NOTIFICATION_KIND_META;
  protected readonly groups: readonly KindGroup[] = [
    { title: 'ASSIGNED AND REVIEWS', kinds: ['assigned', 'review_requested'] },
    { title: 'WORK I FOLLOW', kinds: ['comment', 'ci_failed'] },
  ];
  protected readonly mailIcon = LucideMail;
  protected readonly channels: readonly { id: NotificationChannel; label: string; icon: LucideIcon }[] = [
    { id: 'inApp', label: 'IN-APP', icon: LucideBell },
    { id: 'email', label: 'EMAIL', icon: LucideMail },
    { id: 'push', label: 'PUSH', icon: LucideSmartphone },
  ];

  protected unavailable(channel: NotificationChannel): boolean {
    return (channel === 'email' && !this.store.emailAvailable()) || (channel === 'push' && !this.store.pushAvailable());
  }

  /** Under a column title: `on`, `off` (push, not enabled here) or `setup needed`. */
  protected channelState(channel: NotificationChannel): string {
    if (this.unavailable(channel)) return 'setup needed';
    if (channel === 'push' && !this.store.pushSubscribed()) return 'off here';
    return 'on';
  }
  protected channelStateClass(channel: NotificationChannel): string {
    if (this.unavailable(channel)) return 'text-primary';
    return this.channelState(channel) === 'on' ? 'text-green' : 'text-faint';
  }

  protected readonly bannerTitle = computed(() => {
    const email = this.store.emailAvailable();
    const push = this.store.pushAvailable();
    if (!email && !push) return 'Email and push aren’t set up on this server';
    return email ? 'Push isn’t set up on this server' : 'Email isn’t set up on this server';
  });

  protected readonly canTogglePush = computed(
    () => this.store.pushSupported && this.store.pushAvailable() && !this.store.pushBusy() && this.store.pushPermission() !== 'denied',
  );

  protected readonly deviceHint = computed(() => {
    if (!this.store.pushAvailable()) return 'Push is not set up on this server yet (VAPID keys).';
    if (!this.store.pushSupported)
      return 'Install the app (or open the production build) to get system notifications. On iPhone, add it to the Home Screen first.';
    if (this.store.pushPermission() === 'denied') return 'Notifications are blocked for this site: allow them in the browser settings, then come back.';
    return 'Show notifications on this device, even when Trama is closed. Which events notify you is chosen above (Push).';
  });

  protected togglePush(on: boolean): void {
    void (on ? this.store.enablePush() : this.store.disablePush());
  }

  ngOnInit(): void {
    void this.store.loadSettings();
  }
}
