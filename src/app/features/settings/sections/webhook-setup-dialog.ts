import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { LucideDynamicIcon, LucideTriangleAlert } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';
import type { WebhookSetup } from '../../../core/api/api.types';
import { GIT_PROVIDER_META, type GitProvider } from '../../../core/contracts/domain';
import { SECTION_KIT } from './section-kit';

const STEPS: Record<string, { where: string; steps: string[] }> = {
  github: {
    where: 'GitHub → repository (or organization) Settings → Webhooks → Add webhook',
    steps: [
      'Paste the payload URL below.',
      'Set Content type to application/json.',
      'Paste the secret.',
      'Choose “Let me select individual events” and tick the events listed below.',
      'Link the repositories here: events for unlinked repositories are ignored.',
    ],
  },
  gitlab: {
    where: 'GitLab → project Settings → Webhooks → Add new webhook',
    steps: [
      'Paste the URL below.',
      'Paste the secret into “Secret token”.',
      'Tick the triggers listed below and keep SSL verification on.',
      'Link the repositories here: events for unlinked repositories are ignored.',
    ],
  },
  bitbucket: {
    where: 'Bitbucket → repository Settings → Webhooks → Add webhook (or Workspace settings → Webhooks)',
    steps: [
      'Give it a title and paste the URL below.',
      'Tick “Use a secret” and paste the secret.',
      'Under Triggers choose “Choose from a full list of triggers” and tick the ones listed below: Pull request created, updated, approved, approval removed, merged and declined; and Repository → Build status created and updated.',
      'Link the repositories here: events for unlinked repositories are ignored.',
    ],
  },
};

/**
 * One-time webhook setup shown after connecting or rotating a secret. The secret is never
 * returned again, so the dialog insists on copying it.
 */
@Component({
  selector: 'app-webhook-setup-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmDialogImports, HlmButtonImports, LucideDynamicIcon, ...SECTION_KIT],
  template: `
    <hlm-dialog [state]="setup() ? 'open' : 'closed'" (closed)="closed.emit()">
      <hlm-dialog-content *hlmDialogPortal="let ctx" class="max-h-[90svh] overflow-y-auto sm:max-w-xl">
        @if (setup(); as s) {
          <hlm-dialog-header>
            <h2 hlmDialogTitle>{{ rotated() ? 'New webhook secret' : 'Set up the webhook' }}</h2>
            <p hlmDialogDescription>
              {{ rotated() ? 'The previous secret stopped working. Update it in ' + providerLabel() + '.' : 'Trama turns ' + providerLabel() + ' pull request and CI events into artifacts on your workstreams.' }}
            </p>
          </hlm-dialog-header>

          <div class="flex flex-col gap-4 text-[13px]">
            <div class="border-status-needs-input/30 bg-status-needs-input/10 text-status-needs-input flex items-start gap-2 rounded-md border px-3 py-2 text-xs">
              <svg [lucideIcon]="warn" [size]="14" class="mt-px shrink-0"></svg>
              <span>Copy the secret now. It is shown only once; rotate it later if you lose it.</span>
            </div>

            <div class="grid gap-1.5">
              <span class="text-muted-foreground text-xs font-medium">Payload URL</span>
              <app-copy-field [value]="s.url" label="Webhook URL" />
            </div>
            <div class="grid gap-1.5">
              <span class="text-muted-foreground text-xs font-medium">Secret</span>
              <app-copy-field [value]="s.secret" label="Webhook secret" />
            </div>
            <div class="grid gap-x-6 gap-y-3 sm:grid-cols-2">
              <div class="grid content-start gap-1.5">
                <span class="text-muted-foreground text-xs font-medium">Content type</span>
                <code class="font-mono text-xs">{{ s.contentType }}</code>
              </div>
              <div class="grid content-start gap-1.5">
                <span class="text-muted-foreground text-xs font-medium">{{ provider() === 'github' ? 'Events' : 'Triggers' }}</span>
                <div class="flex flex-wrap gap-1">
                  @for (e of s.events; track e) {
                    <code class="bg-muted rounded px-1.5 py-0.5 font-mono text-[11px]">{{ e }}</code>
                  }
                </div>
              </div>
            </div>

            @if (guide(); as g) {
              <div class="bg-muted/40 rounded-md border px-3 py-2.5">
                <p class="text-xs font-medium">{{ g.where }}</p>
                <ol class="text-muted-foreground mt-1.5 list-decimal space-y-0.5 pl-4 text-xs">
                  @for (step of g.steps; track step) {
                    <li>{{ step }}</li>
                  }
                </ol>
              </div>
            }
          </div>

          <hlm-dialog-footer>
            <button hlmBtn size="sm" hlmDialogClose>I've saved the secret</button>
          </hlm-dialog-footer>
        }
      </hlm-dialog-content>
    </hlm-dialog>
  `,
})
export class WebhookSetupDialog {
  readonly setup = input<WebhookSetup | null>(null);
  readonly provider = input<string>('github');
  /** True when shown after rotating (copy changes slightly). */
  readonly rotated = input(false);
  readonly closed = output<void>();

  protected readonly warn = LucideTriangleAlert;
  protected readonly guide = computed(() => STEPS[this.provider()] ?? null);
  protected readonly providerLabel = computed(() => GIT_PROVIDER_META[this.provider() as GitProvider]?.label ?? 'your git host');
}
