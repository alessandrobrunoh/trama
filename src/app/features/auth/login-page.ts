import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { LucideCircleAlert, LucideDynamicIcon, LucideSparkles } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmFieldImports } from '@spartan-ng/helm/field';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { HlmSpinner } from '@spartan-ng/helm/spinner';
import { ApiClient } from '../../core/api/api-client';
import { ApiError } from '../../core/api/api-error';
import { SessionStore } from '../../core/session/session.store';
import { AuthShell } from './auth-shell';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

@Component({
  selector: 'app-login-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    RouterLink,
    HlmButtonImports,
    HlmFieldImports,
    HlmInputImports,
    HlmSpinner,
    LucideDynamicIcon,
    AuthShell,
  ],
  template: `
    <app-auth-shell
      kicker="SIGN IN"
      title="Sign in to Trama"
      subtitle="Coordination for teams of humans and coding agents."
    >
      <form (submit)="submit($event)" novalidate class="flex flex-col gap-4">
        @if (demo()) {
          <aside
            aria-labelledby="demo-login-title"
            class="bg-card border-border mb-1 flex flex-col gap-3 border p-4"
          >
            <div class="flex items-center gap-2">
              <svg [lucideIcon]="demoIcon" [size]="14" class="text-primary"></svg>
              <h2 id="demo-login-title" class="text-foreground font-mono text-[11px] tracking-[1.2px]">
                TRY THE SAMPLE WORKSPACE
              </h2>
            </div>
            <p class="text-muted-foreground text-[13px] leading-5">
              No sign-up needed. Use the shared demo account to explore Trama.
            </p>
            <div
              class="bg-background border-border grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border px-2.5 py-2 text-xs"
            >
              <span class="text-faint font-mono text-[10.5px]">EMAIL</span>
              <code class="text-foreground font-mono">demo@trama.dev</code>
              <span class="text-faint font-mono text-[10.5px]">PASSWORD</span>
              <code class="text-foreground font-mono">trama-demo</code>
            </div>
            <p class="text-faint font-mono text-[10.5px] leading-4">
              Shared workspace: please don't add personal or sensitive data.
            </p>
            <button hlmBtn type="button" size="sm" variant="outline" class="w-full" (click)="fillDemo()">
              Fill in demo credentials
            </button>
          </aside>
        }
        @if (error(); as e) {
          <div
            role="alert"
            class="bg-red/10 border-red/40 text-red flex items-start gap-2 border px-2.5 py-2 text-[13px]"
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
            autocomplete="username"
            inputmode="email"
            placeholder="you@company.com"
            [(ngModel)]="email"
            [attr.aria-invalid]="emailError() ? 'true' : null"
            required
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
            required
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
      </form>
      <ng-container footer>
        New to Trama?
        <a
          class="text-foreground underline underline-offset-4"
          routerLink="/register"
          [queryParams]="authQuery()"
          >Create an account</a
        >
      </ng-container>
    </app-auth-shell>
  `,
})
export class LoginPage implements OnInit {
  private readonly session = inject(SessionStore);
  private readonly api = inject(ApiClient);

  /** Query param `?next=` (a same-origin path to return to). */
  readonly next = input<string>();
  /** `?email=` from an invitation link: prefilled, still editable. */
  readonly emailHint = input<string>(undefined, { alias: 'email' });
  readonly workspaceSlug = input<string>();
  /** Query params kept when switching between sign in and sign up. */
  protected readonly authQuery = computed(() => {
    const q: Record<string, string> = {};
    if (this.next()) q['next'] = this.next()!;
    if (this.emailHint()) q['email'] = this.emailHint()!;
    return Object.keys(q).length ? q : null;
  });

  protected readonly alertIcon = LucideCircleAlert;
  protected readonly demoIcon = LucideSparkles;
  /** Set from `GET /api/config`, which reads the API's `DEMO_LOGIN` variable. */
  protected readonly demo = signal(false);
  protected readonly email = signal('');
  protected readonly password = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  private readonly submitted = signal(false);

  ngOnInit(): void {
    const hint = this.emailHint();
    if (hint) this.email.set(hint);
    void this.loadDemoLogin();
  }

  private async loadDemoLogin(): Promise<void> {
    try {
      this.demo.set((await this.api.publicConfig()).demoLogin);
    } catch {
      this.demo.set(false);
    }
  }

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
    this.email.set('demo@trama.dev');
    this.password.set('trama-demo');
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
        err.status === 401
          ? 'Incorrect email or password.'
          : err.isNetwork
            ? 'Cannot reach the server. Try again in a moment.'
            : err.message,
      );
    } finally {
      this.busy.set(false);
    }
  }
}
