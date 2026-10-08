import { ChangeDetectionStrategy, Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideCircleAlert, LucideDynamicIcon } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmSpinner } from '@spartan-ng/helm/spinner';
import { ApiClient } from '../../core/api/api-client';
import { ApiError } from '../../core/api/api-error';
import type { InvitePreview } from '../../core/contracts/domain';
import { ROLE_META } from '../../core/meta';
import { Notifier } from '../../core/notify/notifier';
import { SessionStore } from '../../core/session/session.store';
import { AuthShell } from './auth-shell';

/**
 * `/invite/:token`: the page behind an invitation link. Public: shows who invited you to which
 * workspace, then asks you to create an account or sign in (the account must use the invited email),
 * and finally joins the workspace.
 */
@Component({
  selector: 'app-invite-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, HlmButtonImports, HlmSpinner, LucideDynamicIcon, AuthShell],
  template: `
    @if (state() === 'loading') {
      <app-auth-shell title="Opening your invitation…">
        <div class="flex justify-center py-6"><hlm-spinner /></div>
      </app-auth-shell>
    } @else if (invite(); as inv) {
      <app-auth-shell [title]="'Join ' + inv.workspaceName" [subtitle]="subtitle()">
        <div class="flex flex-col gap-4">
          @if (error(); as e) {
            <div
              role="alert"
              class="border-destructive/30 bg-destructive/5 text-destructive flex items-start gap-2 rounded-md border px-2.5 py-2 text-sm"
            >
              <svg [lucideIcon]="alertIcon" [size]="15" class="mt-0.5 shrink-0"></svg>
              <span>{{ e }}</span>
            </div>
          }

          <dl class="bg-muted/40 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-lg border px-3.5 py-3 text-[13px]">
            <dt class="text-muted-foreground">Invited email</dt>
            <dd class="min-w-0 truncate font-medium">{{ inv.email }}</dd>
            <dt class="text-muted-foreground">Role</dt>
            <dd class="font-medium">{{ roleLabel() }}</dd>
          </dl>

          @if (!session.isAuthenticated()) {
            <a hlmBtn size="lg" class="w-full" routerLink="/register" [queryParams]="authQuery()">Create an account</a>
            <a hlmBtn size="lg" variant="outline" class="w-full" routerLink="/login" [queryParams]="authQuery()">
              I already have an account
            </a>
          } @else if (matches()) {
            <button hlmBtn size="lg" class="w-full" [disabled]="busy()" (click)="accept()">
              @if (busy()) {
                <hlm-spinner />
              }
              Accept invitation
            </button>
          } @else {
            <p class="text-muted-foreground text-[13px] leading-relaxed">
              You are signed in as <strong class="text-foreground font-medium">{{ session.user()?.email }}</strong>, but this invitation is for
              <strong class="text-foreground font-medium">{{ inv.email }}</strong>. Sign in with that account to join.
            </p>
            <button hlmBtn size="lg" variant="outline" class="w-full" (click)="switchAccount()">Sign out and switch account</button>
          }
        </div>
      </app-auth-shell>
    } @else {
      <app-auth-shell title="This invitation is no longer valid" subtitle="It may have expired, been used already, or been withdrawn.">
        <div class="flex flex-col gap-3">
          <p class="text-muted-foreground text-[13px] leading-relaxed">Ask the person who invited you to send a new one.</p>
          <a hlmBtn size="lg" variant="outline" class="w-full" routerLink="/">{{ session.isAuthenticated() ? 'Go to Trama' : 'Back to the home page' }}</a>
        </div>
      </app-auth-shell>
    }
  `,
})
export class InvitePage implements OnInit {
  private readonly api = inject(ApiClient);
  private readonly notifier = inject(Notifier);
  protected readonly session = inject(SessionStore);

  /** Route param. */
  readonly token = input.required<string>();

  protected readonly alertIcon = LucideCircleAlert;
  protected readonly state = signal<'loading' | 'ready' | 'invalid'>('loading');
  protected readonly invite = signal<InvitePreview | null>(null);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly roleLabel = computed(() => {
    const role = this.invite()?.role;
    return role ? ROLE_META[role].label : '';
  });
  protected readonly subtitle = computed(() => {
    const by = this.invite()?.invitedByName;
    return by ? `${by} invited you to collaborate on Trama.` : 'You were invited to collaborate on Trama.';
  });
  /** The signed-in account is the one that was invited. */
  protected readonly matches = computed(() => {
    const email = this.session.user()?.email.toLowerCase();
    return !!email && email === this.invite()?.email.toLowerCase();
  });
  /** Sent to sign in / sign up so they return here, with the invited address filled in. */
  protected readonly authQuery = computed(() => ({
    next: `/invite/${this.token()}`,
    email: this.invite()?.email ?? '',
  }));

  async ngOnInit(): Promise<void> {
    const [, preview] = await Promise.all([
      this.session.init(),
      this.api.inviteLinks.preview(this.token()).catch(() => null),
    ]);
    this.invite.set(preview);
    this.state.set(preview ? 'ready' : 'invalid');
  }

  protected async accept(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const joined = await this.api.inviteLinks.accept(this.token());
      this.notifier.success(`You joined ${joined.workspace.name}`);
      await this.session.switchWorkspace(joined.workspace.slug);
    } catch (e) {
      const err = ApiError.from(e);
      this.error.set(err.isNotFound ? 'This invitation is no longer valid.' : err.message);
    } finally {
      this.busy.set(false);
    }
  }

  protected async switchAccount(): Promise<void> {
    await this.session.logout();
  }
}
