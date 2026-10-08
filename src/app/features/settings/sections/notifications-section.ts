import { ChangeDetectionStrategy, Component, inject, OnInit } from '@angular/core';
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
      <app-settings-group title="Send me a notification when…">
        @for (kind of kinds; track kind) {
          <app-settings-row [label]="meta[kind].label" [description]="meta[kind].description">
            <span class="flex items-center gap-4">
              @for (channel of channels; track channel.id) {
                <label class="flex items-center gap-2 text-xs" [class.opacity-50]="channel.id === 'email' && !store.emailAvailable()">
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
  ];

  ngOnInit(): void {
    void this.store.loadSettings();
  }
}
