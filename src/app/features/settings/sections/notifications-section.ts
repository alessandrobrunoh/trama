import { ChangeDetectionStrategy, Component, computed, inject, OnInit } from '@angular/core';
import { HlmSwitchImports } from '@spartan-ng/helm/switch';
import {
  NOTIFICATION_KINDS,
  NOTIFICATION_KIND_META,
  type NotificationChannel,
  type NotificationKind,
} from '../../../core/contracts/domain';
import { NotificationsStore } from '../../../core/stores/notifications.store';
import { SECTION_KIT } from './section-kit';

/** What Trama tells you about, and where. Personal: the same in every workspace. */
@Component({
  selector: 'app-notifications-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmSwitchImports, ...SECTION_KIT],
  host: { class: 'flex flex-col gap-10' },
  template: `
    <div>
      <app-section-header
        title="Notifications"
        description="Choose what Trama tells you about, and where. These settings follow you across workspaces."
      />
      @if (!store.emailAvailable()) {
        <app-readonly-note>
          Email is not set up on this server (<code class="font-mono">SMTP_URL</code>), so email notifications are not sent yet. In-app notifications work.
        </app-readonly-note>
      }
      <app-settings-group title="This device">
        <app-settings-row label="System notifications" [description]="deviceHint()">
          <hlm-switch
            [checked]="store.pushSubscribed()"
            [disabled]="!canTogglePush()"
            (checkedChange)="togglePush($event)"
            aria-label="System notifications on this device"
          />
        </app-settings-row>
      </app-settings-group>
      <app-settings-group title="Send me a notification when…">
        @for (kind of kinds; track kind) {
          <app-settings-row [label]="meta[kind].label" [description]="meta[kind].description">
            <span class="flex items-center gap-4">
              @for (channel of channels; track channel.id) {
                <label class="flex items-center gap-2 text-xs" [class.opacity-50]="unavailable(channel.id)">
                  <span class="text-muted-foreground">{{ channel.label }}</span>
                  <hlm-switch
                    [checked]="store.settings()[kind][channel.id]"
                    (checkedChange)="store.setChannel(kind, channel.id, $event)"
                    [aria-label]="meta[kind].label + ': ' + channel.label"
                  />
                </label>
              }
            </span>
          </app-settings-row>
        }
      </app-settings-group>
    </div>
  `,
})
export class NotificationsSection implements OnInit {
  protected readonly store = inject(NotificationsStore);

  protected readonly kinds: readonly NotificationKind[] = NOTIFICATION_KINDS;
  protected readonly meta = NOTIFICATION_KIND_META;
  protected readonly channels: readonly { id: NotificationChannel; label: string }[] = [
    { id: 'inApp', label: 'In-app' },
    { id: 'email', label: 'Email' },
    { id: 'push', label: 'Push' },
  ];

  protected unavailable(channel: NotificationChannel): boolean {
    return (channel === 'email' && !this.store.emailAvailable()) || (channel === 'push' && !this.store.pushAvailable());
  }

  protected readonly canTogglePush = computed(
    () => this.store.pushSupported && this.store.pushAvailable() && !this.store.pushBusy() && this.store.pushPermission() !== 'denied',
  );

  protected readonly deviceHint = computed(() => {
    if (!this.store.pushAvailable()) return 'Push is not set up on this server yet (VAPID keys).';
    if (!this.store.pushSupported)
      return 'Install the app (or open the production build) to get system notifications. On iPhone, add it to the Home Screen first.';
    if (this.store.pushPermission() === 'denied') return 'Notifications are blocked for this site: allow them in the browser settings, then come back.';
    return 'Show notifications on this device, even when Trama is closed. Which events notify you is chosen below (Push).';
  });

  protected togglePush(on: boolean): void {
    void (on ? this.store.enablePush() : this.store.disablePush());
  }

  ngOnInit(): void {
    void this.store.loadSettings();
  }
}
