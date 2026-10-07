import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { LucideCircleAlert, LucideDynamicIcon } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmFieldImports } from '@spartan-ng/helm/field';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { HlmSpinner } from '@spartan-ng/helm/spinner';
import { ApiError } from '../../core/api/api-error';
import { SessionStore } from '../../core/session/session.store';
import { AuthShell } from './auth-shell';

export function slugify(v: string): string {
  return v
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38})[a-z0-9]$/;

@Component({
  selector: 'app-new-workspace-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, HlmButtonImports, HlmFieldImports, HlmInputImports, HlmSpinner, LucideDynamicIcon, AuthShell],
  template: `
    <app-auth-shell
      title="Create a workspace"
      [subtitle]="
        hasWorkspaces()
          ? 'A workspace holds the teams, workstreams and agents of one organisation.'
          : 'Welcome' + (firstName() ? ', ' + firstName() : '') + '. A workspace holds the teams, workstreams and agents of one organisation.'
      "
    >
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
          <label hlmFieldLabel for="ws-name">Workspace name</label>
          <input
            hlmInput
            id="ws-name"
            name="name"
            placeholder="Acme Engineering"
            autocomplete="organization"
            [ngModel]="name()"
            (ngModelChange)="onName($event)"
            [attr.aria-invalid]="nameError() ? 'true' : null"
            autofocus
          />
          @if (nameError(); as m) {
            <p class="text-destructive text-xs">{{ m }}</p>
          }
        </hlm-field>
        <hlm-field>
          <label hlmFieldLabel for="ws-slug">URL</label>
          <div class="flex items-center gap-1.5">
            <span class="text-muted-foreground shrink-0 font-mono text-xs">nabla/</span>
            <input
              hlmInput
              id="ws-slug"
              name="slug"
              class="font-mono"
              placeholder="acme"
              autocapitalize="off"
              spellcheck="false"
              [ngModel]="slug()"
              (ngModelChange)="onSlug($event)"
              [attr.aria-invalid]="slugError() ? 'true' : null"
            />
          </div>
          @if (slugError(); as m) {
            <p class="text-destructive text-xs">{{ m }}</p>
          } @else {
            <p class="text-muted-foreground text-xs">Lowercase letters, digits and dashes. You can change it later.</p>
          }
        </hlm-field>
        <button hlmBtn type="submit" size="lg" class="mt-1 w-full" [disabled]="busy()">
          @if (busy()) {
            <hlm-spinner />
          }
          Create workspace
        </button>
        @if (hasWorkspaces()) {
          <button hlmBtn type="button" variant="ghost" class="text-muted-foreground w-full" (click)="cancel()">Cancel</button>
        }
      </form>
      @if (!hasWorkspaces()) {
        <ng-container footer>
          Not {{ session.user()?.name ?? 'you' }}?
          <button type="button" class="text-foreground underline underline-offset-4" (click)="session.logout()">Sign out</button>
        </ng-container>
      }
    </app-auth-shell>
  `,
})
export class NewWorkspacePage {
  protected readonly session = inject(SessionStore);
  private readonly router = inject(Router);

  readonly workspaceSlug = input<string>();

  protected readonly alertIcon = LucideCircleAlert;
  protected readonly name = signal('');
  protected readonly slug = signal('');
  private readonly slugTouched = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  private readonly submitted = signal(false);
  private readonly serverSlugError = signal<string | null>(null);

  protected readonly hasWorkspaces = computed(() => this.session.workspaces().length > 0);
  protected readonly firstName = computed(() => this.session.user()?.name.split(/\s+/)[0] ?? '');

  protected onName(v: string): void {
    this.name.set(v);
    if (!this.slugTouched()) this.slug.set(slugify(v));
    this.serverSlugError.set(null);
  }
  protected onSlug(v: string): void {
    this.slugTouched.set(true);
    this.slug.set(v.toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 40));
    this.serverSlugError.set(null);
  }

  protected nameError(): string | null {
    return this.submitted() && !this.name().trim() ? 'Give your workspace a name.' : null;
  }
  protected slugError(): string | null {
    if (this.serverSlugError()) return this.serverSlugError();
    if (!this.submitted()) return null;
    return SLUG_RE.test(this.slug().replace(/^-+|-+$/g, '')) ? null : 'Use 3 to 40 lowercase letters, digits or dashes.';
  }

  protected cancel(): void {
    void this.router.navigateByUrl(this.session.defaultWorkspaceUrl());
  }

  protected async submit(ev: Event): Promise<void> {
    ev.preventDefault();
    this.submitted.set(true);
    this.error.set(null);
    if (this.nameError() || this.slugError()) return;
    this.busy.set(true);
    try {
      await this.session.createWorkspace(this.name().trim(), this.slug().replace(/^-+|-+$/g, ''));
    } catch (e) {
      const err = ApiError.from(e);
      if (err.isConflict) this.serverSlugError.set('That URL is already taken. Try another.');
      else this.error.set(err.message);
    } finally {
      this.busy.set(false);
    }
  }
}
