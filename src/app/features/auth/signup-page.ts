import { ChangeDetectionStrategy, Component, inject, input, signal } from '@angular/core';
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
  selector: 'app-signup-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, RouterLink, HlmButtonImports, HlmFieldImports, HlmInputImports, HlmSpinner, LucideDynamicIcon, AuthShell],
  template: `
    <app-auth-shell title="Create your account" subtitle="Next, you will create a workspace for your team.">
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
          <label hlmFieldLabel for="su-name">Name</label>
          <input
            hlmInput
            id="su-name"
            name="name"
            autocomplete="name"
            placeholder="Ada Lovelace"
            [(ngModel)]="name"
            [attr.aria-invalid]="nameError() ? 'true' : null"
            autofocus
          />
          @if (nameError(); as m) {
            <p class="text-destructive text-xs">{{ m }}</p>
          }
        </hlm-field>
        <hlm-field>
          <label hlmFieldLabel for="su-email">Email</label>
          <input
            hlmInput
            id="su-email"
            name="email"
            type="email"
            autocomplete="email"
            inputmode="email"
            placeholder="you@company.com"
            [(ngModel)]="email"
            [attr.aria-invalid]="emailError() ? 'true' : null"
          />
          @if (emailError(); as m) {
            <p class="text-destructive text-xs">{{ m }}</p>
          }
        </hlm-field>
        <hlm-field>
          <label hlmFieldLabel for="su-password">Password</label>
          <input
            hlmInput
            id="su-password"
            name="password"
            type="password"
            autocomplete="new-password"
            placeholder="At least 8 characters"
            [(ngModel)]="password"
            [attr.aria-invalid]="passwordError() ? 'true' : null"
          />
          @if (passwordError(); as m) {
            <p class="text-destructive text-xs">{{ m }}</p>
          } @else {
            <p class="text-muted-foreground text-xs">Use at least 8 characters.</p>
          }
        </hlm-field>
        <button hlmBtn type="submit" size="lg" class="mt-1 w-full" [disabled]="busy()">
          @if (busy()) {
            <hlm-spinner />
          }
          Create account
        </button>
      </form>
      <ng-container footer>
        Already have an account?
        <a
          class="text-foreground underline underline-offset-4"
          routerLink="/login"
          [queryParams]="next() ? { next: next() } : null"
          >Sign in</a
        >
      </ng-container>
    </app-auth-shell>
  `,
})
export class SignupPage {
  private readonly session = inject(SessionStore);

  readonly next = input<string>();
  readonly workspaceSlug = input<string>();

  protected readonly alertIcon = LucideCircleAlert;
  protected readonly name = signal('');
  protected readonly email = signal('');
  protected readonly password = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  private readonly submitted = signal(false);

  protected nameError(): string | null {
    return this.submitted() && !this.name().trim() ? 'Enter your name.' : null;
  }
  protected emailError(): string | null {
    if (!this.submitted()) return null;
    const v = this.email().trim();
    if (!v) return 'Enter your email.';
    return EMAIL_RE.test(v) ? null : 'That does not look like an email address.';
  }
  protected passwordError(): string | null {
    if (!this.submitted()) return null;
    return this.password().length < 8 ? 'Use at least 8 characters.' : null;
  }

  protected async submit(ev: Event): Promise<void> {
    ev.preventDefault();
    this.submitted.set(true);
    this.error.set(null);
    if (this.nameError() || this.emailError() || this.passwordError()) return;
    this.busy.set(true);
    try {
      await this.session.signup(this.name().trim(), this.email().trim(), this.password());
      // First run: no workspace yet → create one. Otherwise honour `next`.
      await this.session.goAfterAuth(this.session.workspaces().length ? this.next() : null);
    } catch (e) {
      const err = ApiError.from(e);
      this.error.set(
        err.isConflict ? 'An account with this email already exists. Try signing in.' : err.isNetwork ? 'Cannot reach the server. Try again in a moment.' : err.message,
      );
    } finally {
      this.busy.set(false);
    }
  }
}
