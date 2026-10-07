import { ChangeDetectionStrategy, Component, inject, input, isDevMode, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { LucideCircleAlert, LucideDynamicIcon } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmFieldImports } from '@spartan-ng/helm/field';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { HlmSpinner } from '@spartan-ng/helm/spinner';
import { ApiError } from '../../core/api/api-error';
import { SessionStore } from '../../core/session/session.store';
import { AuthShell } from './auth-shell';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

@Component({
  selector: 'app-login-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, RouterLink, HlmButtonImports, HlmFieldImports, HlmInputImports, HlmSpinner, LucideDynamicIcon, AuthShell],
  template: `
    <app-auth-shell title="Sign in to Nabla" subtitle="Coordination for teams of humans and coding agents.">
      <form (submit)="submit($event)" novalidate class="flex flex-col gap-4">
        @if (error(); as e) {
          <div
            role="alert"
            class="border-destructive/30 bg-destructive/5 text-destructive flex items-start gap-2 rounded-md border px-2.5 py-2 text-sm"
          >
            <svg [lucideIcon]="alertIcon" [size]="15" class="mt-0.5 shrink-0"></svg>
            <span>{{ e }}</span>
          </div>
        }
        <hlm-field>
          <label hlmFieldLabel for="login-email">Email</label>
          <input
            hlmInput
            id="login-email"
            name="email"
            type="email"
            autocomplete="email"
            inputmode="email"
            placeholder="you@company.com"
            [(ngModel)]="email"
            [attr.aria-invalid]="emailError() ? 'true' : null"
            autofocus
          />
          @if (emailError(); as m) {
            <p class="text-destructive text-xs">{{ m }}</p>
          }
        </hlm-field>
        <hlm-field>
          <label hlmFieldLabel for="login-password">Password</label>
          <input
            hlmInput
            id="login-password"
            name="password"
            type="password"
            autocomplete="current-password"
            placeholder="••••••••"
            [(ngModel)]="password"
            [attr.aria-invalid]="passwordError() ? 'true' : null"
          />
          @if (passwordError(); as m) {
            <p class="text-destructive text-xs">{{ m }}</p>
          }
        </hlm-field>
        <button hlmBtn type="submit" size="lg" class="mt-1 w-full" [disabled]="busy()">
          @if (busy()) {
            <hlm-spinner />
          }
          Sign in
        </button>
        @if (demo) {
          <button hlmBtn type="button" variant="ghost" class="text-muted-foreground w-full" (click)="fillDemo()">
            Use the demo account
          </button>
        }
      </form>
      <ng-container footer>
        New to Nabla?
        <a
          class="text-foreground underline underline-offset-4"
          routerLink="/signup"
          [queryParams]="next() ? { next: next() } : null"
          >Create an account</a
        >
      </ng-container>
    </app-auth-shell>
  `,
})
export class LoginPage {
  private readonly session = inject(SessionStore);

  /** Query param `?next=` (a same-origin path to return to). */
  readonly next = input<string>();
  readonly workspaceSlug = input<string>();

  protected readonly alertIcon = LucideCircleAlert;
  protected readonly demo = isDevMode();
  protected readonly email = signal('');
  protected readonly password = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  private readonly submitted = signal(false);

  protected emailError(): string | null {
    if (!this.submitted()) return null;
    const v = this.email().trim();
    if (!v) return 'Enter your email.';
    return EMAIL_RE.test(v) ? null : 'That does not look like an email address.';
  }
  protected passwordError(): string | null {
    return this.submitted() && !this.password() ? 'Enter your password.' : null;
  }

  protected fillDemo(): void {
    this.email.set('demo@nabla.dev');
    this.password.set('nabla-demo');
    this.error.set(null);
  }

  protected async submit(ev: Event): Promise<void> {
    ev.preventDefault();
    this.submitted.set(true);
    this.error.set(null);
    if (this.emailError() || this.passwordError()) return;
    this.busy.set(true);
    try {
      await this.session.login(this.email().trim(), this.password());
      await this.session.goAfterAuth(this.next());
    } catch (e) {
      const err = ApiError.from(e);
      this.error.set(
        err.status === 401 ? 'Incorrect email or password.' : err.isNetwork ? 'Cannot reach the server. Try again in a moment.' : err.message,
      );
    } finally {
      this.busy.set(false);
    }
  }
}
