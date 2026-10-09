import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { LucideDynamicIcon, LucideRefreshCw, LucideX, LucideWaypoints } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import { ApiClient } from '../../core/api/api-client';
import { ApiError } from '../../core/api/api-error';
import { EXTERNAL_PROVIDER_META, type ExternalRef, type ExternalStateType, type Issue } from '../../core/contracts/domain';
import { Notifier } from '../../core/notify/notifier';
import { NablaStore } from '../../core/stores/nabla.store';
import { relativeTime } from '../../core/format';
import { PropertyRow } from '../../shared/property-row';
import { ProviderIcon } from '../../shared/provider-icon';

const DOT: Record<ExternalStateType, string> = {
  open: 'bg-status-planned',
  in_progress: 'bg-status-working',
  done: 'bg-status-shipped',
  canceled: 'bg-status-canceled',
};

/**
 * "Tracker" row of the issue page: the GitHub / Linear issue this one was imported from or is linked to, with its
 * status as a read-only mirror (the Trama status never follows it). Links are made by URL; refreshing reads the
 * tracker again with the credential an admin saved in Settings → Import.
 */
@Component({
  selector: 'app-issue-external-ref',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButtonImports, HlmInputImports, HlmTooltip, LucideDynamicIcon, PropertyRow, ProviderIcon],
  host: { class: 'block' },
  template: `
    <app-property-row label="Tracker" [icon]="trackerIcon">
      @if (ref(); as r) {
        <a
          [href]="r.url"
          target="_blank"
          rel="noopener noreferrer"
          class="hover:bg-hover focus-visible:ring-ring flex min-w-0 items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-[13px] outline-none focus-visible:ring-2"
          [hlmTooltip]="tooltip(r)"
        >
          @if (r.provider === 'github') { <app-provider-icon provider="github" /> }
          <span class="shrink-0 font-medium">{{ providerLabel(r) }}</span>
          <span class="text-muted-foreground shrink-0 font-mono text-xs">{{ r.key }}</span>
          @if (r.state) {
            <span class="flex min-w-0 items-center gap-1 text-xs">
              <span class="size-1.5 shrink-0 rounded-full" [class]="dot(r)"></span>
              <span class="truncate">{{ r.state }}</span>
            </span>
          }
        </a>
        @if (canEdit()) {
          <button type="button" class="text-muted-foreground hover:text-foreground shrink-0 disabled:opacity-50" aria-label="Refresh the external status" hlmTooltip="Refresh status" [disabled]="busy()" (click)="refresh()">
            <svg [lucideIcon]="refreshIcon" [size]="13" [class.animate-spin]="busy()"></svg>
          </button>
          <button type="button" class="text-muted-foreground hover:text-foreground shrink-0" aria-label="Unlink the external issue" hlmTooltip="Unlink" [disabled]="busy()" (click)="unlink()">
            <svg [lucideIcon]="unlinkIcon" [size]="13"></svg>
          </button>
        }
      } @else if (canEdit()) {
        @if (linking()) {
          <form class="flex min-w-0 flex-1 items-center gap-1.5" (submit)="link($event)">
            <input
              hlmInput
              class="h-7 min-w-0 flex-1 text-[13px]"
              placeholder="https://github.com/owner/repo/issues/12"
              aria-label="URL of the GitHub or Linear issue"
              [value]="url()"
              (input)="url.set($any($event.target).value)"
              (keydown.escape)="linking.set(false)"
            />
            <button hlmBtn type="submit" size="sm" class="h-7" [disabled]="!url().trim() || busy()">{{ busy() ? 'Linking…' : 'Link' }}</button>
          </form>
        } @else {
          <button type="button" class="text-muted-foreground hover:bg-hover hover:text-foreground h-7 min-w-0 truncate rounded-md px-1.5 text-left text-[13px] whitespace-nowrap" (click)="linking.set(true)">
            Link GitHub or Linear issue…
          </button>
        }
      } @else {
        <span class="text-muted-foreground px-1.5 text-[13px]">—</span>
      }
    </app-property-row>
  `,
})
export class IssueExternalRef {
  private readonly api = inject(ApiClient);
  private readonly store = inject(NablaStore);
  private readonly notify = inject(Notifier);

  readonly issue = input.required<Issue>();
  readonly canEdit = input(false);

  protected readonly trackerIcon = LucideWaypoints;
  protected readonly refreshIcon = LucideRefreshCw;
  protected readonly unlinkIcon = LucideX;

  private readonly slug = computed(() => this.store.slug() ?? '');
  protected readonly ref = computed(() => this.issue().externalRef ?? null);
  protected readonly linking = signal(false);
  protected readonly url = signal('');
  protected readonly busy = signal(false);

  protected providerLabel(r: ExternalRef): string {
    return EXTERNAL_PROVIDER_META[r.provider].label;
  }
  protected dot(r: ExternalRef): string {
    return DOT[r.stateType ?? 'open'];
  }
  protected tooltip(r: ExternalRef): string {
    const when = r.syncedAt ? `Status read ${relativeTime(r.syncedAt)}` : 'Status not read yet';
    return `${r.origin === 'import' ? 'Imported from' : 'Linked to'} ${this.providerLabel(r)}. ${when}. Read-only: it does not change this issue’s status.`;
  }

  protected async link(event: Event): Promise<void> {
    event.preventDefault();
    const url = this.url().trim();
    if (!url) return;
    await this.run(() => this.api.issues.externalRef.link(this.slug(), this.issue().key, url), 'Linked to the external issue', 'Could not link the issue', () => {
      this.linking.set(false);
      this.url.set('');
    });
  }
  protected refresh(): Promise<void> {
    return this.run(() => this.api.issues.externalRef.refresh(this.slug(), this.issue().key), 'Status refreshed', 'Could not refresh the status');
  }
  protected unlink(): Promise<void> {
    return this.run(() => this.api.issues.externalRef.unlink(this.slug(), this.issue().key), 'Unlinked', 'Could not unlink the issue');
  }

  private async run(call: () => Promise<Issue>, ok: string, failure: string, after?: () => void): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      await call();
      after?.();
      this.notify.success(ok);
      await this.store.refetch();
    } catch (e) {
      this.notify.error(failure, { description: ApiError.from(e).message });
    } finally {
      this.busy.set(false);
    }
  }
}
