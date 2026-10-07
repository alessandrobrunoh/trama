import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { LucideCompass, LucideDynamicIcon, LucideServerOff } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { SessionStore } from '../../core/session/session.store';
import { Kbd } from '../../shared/kbd';

/**
 * 404. Rendered inside the shell (unknown page in a workspace: `workspaceSlug` is set) or standalone at
 * `/404?workspace=<slug>` (not a member / unknown workspace) and `/404?error=1` (server unreachable).
 */
@Component({
  selector: 'app-not-found-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, HlmButtonImports, LucideDynamicIcon, Kbd],
  host: { class: 'bg-background text-foreground block min-h-full' },
  template: `
    <div class="mx-auto flex min-h-full max-w-md flex-col items-center justify-center px-6 py-20 text-center" [class.min-h-svh]="!inShell()">
      <span class="bg-muted text-muted-foreground mb-4 flex size-10 items-center justify-center rounded-lg">
        <svg [lucideIcon]="serverError() ? offIcon : compass" [size]="20" [strokeWidth]="1.5"></svg>
      </span>
      <h1 class="text-lg font-semibold tracking-tight">{{ heading() }}</h1>
      <p class="text-muted-foreground mt-1.5 text-sm leading-snug">{{ message() }}</p>

      <div class="mt-6 flex flex-wrap items-center justify-center gap-2">
        @if (serverError()) {
          <button hlmBtn (click)="reload()">Try again</button>
        } @else if (home(); as h) {
          <a hlmBtn [routerLink]="h">Go to overview</a>
        } @else {
          <a hlmBtn routerLink="/">Go home</a>
        }
        @if (workspaces().length > 1 && !serverError()) {
          @for (w of otherWorkspaces(); track w.id) {
            <a hlmBtn variant="outline" [routerLink]="['/', w.slug, 'overview']">Open {{ w.name }}</a>
          }
        }
        @if (!session.isAuthenticated() && !inShell()) {
          <a hlmBtn variant="outline" routerLink="/login">Sign in</a>
        }
      </div>

      @if (inShell()) {
        <p class="text-muted-foreground mt-8 flex items-center gap-1.5 text-xs">
          Looking for something? Press <app-kbd keys="mod+k" /> to search.
        </p>
      }
    </div>
  `,
})
export class NotFoundPage {
  protected readonly session = inject(SessionStore);
  private readonly router = inject(Router);

  /** From the parent `:workspaceSlug` route segment (inside the shell). */
  readonly workspaceSlug = input<string>();
  /** `?workspace=<slug>` the guard could not open. */
  readonly workspace = input<string>();
  /** `?error=1` the server is unreachable. */
  readonly error = input<string>();

  protected readonly compass = LucideCompass;
  protected readonly offIcon = LucideServerOff;

  protected readonly inShell = computed(() => !!this.workspaceSlug() && !this.workspace() && !this.error());
  protected readonly serverError = computed(() => !!this.error());
  protected readonly workspaces = computed(() => this.session.workspaces());
  protected readonly otherWorkspaces = computed(() =>
    this.workspaces().filter((w) => w.slug !== (this.workspace() ?? this.workspaceSlug())).slice(0, 3),
  );

  protected readonly home = computed(() => {
    const slug = this.workspaceSlug();
    if (slug && this.inShell()) return ['/', slug, 'overview'];
    if (this.session.isAuthenticated() && this.workspaces().length) return [this.session.defaultWorkspaceUrl()];
    return null;
  });

  protected readonly heading = computed(() => {
    if (this.serverError()) return 'Cannot reach Nabla';
    if (this.workspace()) return 'Workspace not found';
    return 'Page not found';
  });

  protected readonly message = computed(() => {
    if (this.serverError()) return 'The server is not responding. Check your connection and try again in a moment.';
    if (this.workspace()) return `There is no workspace called "${this.workspace()}", or you are not a member of it.`;
    return 'This page does not exist, or it was moved. Check the address, or head back to your workspace.';
  });

  protected reload(): void {
    void this.router.navigateByUrl('/');
  }
}
