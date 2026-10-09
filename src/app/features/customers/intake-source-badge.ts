import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import {
  LucideDynamicIcon,
  LucideHash,
  LucideInbox,
  LucideLifeBuoy,
  LucideMail,
  LucideMessageCircle,
  LucideWebhook,
  type LucideIcon,
} from '@lucide/angular';
import { INTAKE_PROVIDER_META, normalizeHttpUrl, type IntakeProvider } from '../../core/contracts/domain';

export const INTAKE_ICONS: Record<IntakeProvider, LucideIcon> = {
  intercom: LucideMessageCircle,
  zendesk: LucideLifeBuoy,
  front: LucideInbox,
  slack: LucideHash,
  email: LucideMail,
  generic: LucideWebhook,
};

export const intakeLabel = (provider: IntakeProvider): string => INTAKE_PROVIDER_META[provider]?.label ?? provider;

/**
 * Where a customer request came from: a small source badge (Intercom, Zendesk, …), linking to the external
 * ticket when there is a safe http(s) URL.
 *   <app-intake-source-badge provider="zendesk" [url]="request.sourceUrl" [ticket]="request.externalId" />
 */
@Component({
  selector: 'app-intake-source-badge',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideDynamicIcon],
  host: { class: 'inline-flex' },
  template: `
    @if (href(); as link) {
      <a
        [href]="link"
        target="_blank"
        rel="noopener noreferrer nofollow"
        class="text-muted-foreground hover:text-foreground bg-muted/60 inline-flex max-w-full items-center gap-1 rounded border px-1.5 py-px text-[11px] leading-4"
        [title]="'Open in ' + label()"
      >
        <svg [lucideIcon]="icon()" [size]="11" class="shrink-0"></svg>
        <span class="truncate">{{ label() }}{{ ticket() ? ' · ' + shortTicket() : '' }}</span>
      </a>
    } @else {
      <span class="text-muted-foreground bg-muted/60 inline-flex max-w-full items-center gap-1 rounded border px-1.5 py-px text-[11px] leading-4">
        <svg [lucideIcon]="icon()" [size]="11" class="shrink-0"></svg>
        <span class="truncate">{{ label() }}{{ ticket() ? ' · ' + shortTicket() : '' }}</span>
      </span>
    }
  `,
})
export class IntakeSourceBadge {
  readonly provider = input.required<IntakeProvider>();
  /** External ticket / conversation link. Only plain http(s) is rendered as an anchor. */
  readonly url = input<string | null | undefined>();
  /** External ticket id, shown after the name. */
  readonly ticket = input<string | null | undefined>();

  protected readonly label = computed(() => intakeLabel(this.provider()));
  protected readonly icon = computed(() => INTAKE_ICONS[this.provider()] ?? LucideWebhook);
  protected readonly href = computed(() => (this.url() ? normalizeHttpUrl(this.url()!) : null));
  protected readonly shortTicket = computed(() => {
    const t = this.ticket() ?? '';
    return t.length > 14 ? `${t.slice(0, 13)}…` : t;
  });
}
