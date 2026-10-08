import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { LucideDynamicIcon, LucideServerOff } from '@lucide/angular';
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
  host: { class: 'bg-background text-foreground relative isolate block min-h-full overflow-hidden' },
  template: `
    @if (!inShell()) {
      <div
        aria-hidden="true"
        class="bg-primary/10 pointer-events-none absolute top-[-18rem] left-1/2 -z-10 h-[32rem] w-[52rem] -translate-x-1/2 rounded-full blur-3xl"
      ></div>
      <a routerLink="/" class="absolute top-3 left-4 flex items-center gap-2 text-[13px] font-semibold tracking-tight sm:left-6">
        <span class="bg-foreground text-background flex size-5 items-center justify-center rounded-[5px] text-[13px] leading-none" aria-hidden="true">∇</span>
        Trama
      </a>
    }
    <div class="mx-auto flex min-h-full max-w-md flex-col items-center justify-center px-6 py-20 text-center" [class.min-h-svh]="!inShell()">
      @if (serverError()) {
        <span class="bg-muted text-muted-foreground mb-5 flex size-11 items-center justify-center rounded-xl">
          <svg [lucideIcon]="offIcon" [size]="20" [strokeWidth]="1.5"></svg>
        </span>
      } @else {
        <span class="text-muted-foreground/40 mb-3 font-mono text-6xl font-semibold tracking-tighter select-none" aria-hidden="true">404</span>
      }
      <h1 class="text-xl font-semibold tracking-tight">{{ heading() }}</h1>
      <p class="text-muted-foreground mt-2 text-[13px] leading-relaxed">{{ message() }}</p>

      <div class="mt-6 flex flex-wrap items-center justify-center gap-2">
        @if (serverError()) {
          <button hlmBtn size="sm" (click)="reload()">Try again</button>
        } @else if (home(); as h) {
          <a hlmBtn size="sm" [routerLink]="h">Go to overview</a>
        } @else {
          <a hlmBtn size="sm" routerLink="/">Go home</a>
        }
        @if (workspaces().length > 1 && !serverError()) {
          @for (w of otherWorkspaces(); track w.id) {
            <a hlmBtn size="sm" variant="outline" [routerLink]="['/', w.slug, 'overview']">Open {{ w.name }}</a>
          }
        }
        @if (!session.isAuthenticated() && !inShell()) {
          <a hlmBtn size="sm" variant="outline" routerLink="/login">Sign in</a>
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
    if (this.serverError()) return 'Cannot reach Trama';
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
