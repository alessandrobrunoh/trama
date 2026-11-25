import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { LucideDynamicIcon, LucideServerOff } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { SessionStore } from '../../core/session/session.store';
import { Kbd } from '../../shared/kbd';
import { TramaLogo } from '../../shared/trama-logo';
import { SiteWeave } from '../landing/site-weave';

/**
 * 404. Rendered inside the shell (unknown page in a workspace: `workspaceSlug` is set) or standalone at
 * `/404?workspace=<slug>` (not a member / unknown workspace) and `/404?error=1` (server unreachable).
 */
@Component({
  selector: 'app-not-found-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, HlmButtonImports, LucideDynamicIcon, Kbd, TramaLogo, SiteWeave],
  host: { class: 'bg-background text-foreground relative block min-h-full overflow-hidden leading-normal' },
  template: `
    @if (!inShell()) {
      <header
        class="mx-auto flex h-16 w-full max-w-[1440px] items-center px-5 md:px-10 xl:px-[120px]"
      >
        <a routerLink="/" class="flex items-center gap-2.5" aria-label="Trama home">
          <app-trama-logo [size]="28" />
          <span class="font-title text-foreground text-[24px] leading-none">Trama</span>
        </a>
      </header>
      <app-site-weave />
    }
    <div
      class="mx-auto flex min-h-full w-full max-w-[1440px] flex-col items-start justify-center gap-5 px-5 py-16 md:px-10 xl:px-[120px]"
      [class]="inShell() ? '' : 'min-h-[calc(100svh-89px)]'"
    >
      <div class="flex items-center gap-2.5">
        <span class="bg-primary size-2" aria-hidden="true"></span>
        <p class="text-faint font-mono text-[12px] tracking-[1.2px]">
          {{ serverError() ? 'OFFLINE' : 'ERROR · 404' }}
        </p>
      </div>
      @if (serverError()) {
        <svg [lucideIcon]="offIcon" [size]="28" [strokeWidth]="1.5" class="text-faint"></svg>
      }
      <h1
        class="font-title text-foreground max-w-[720px] text-[clamp(40px,6vw,72px)] leading-none tracking-[-0.021em]"
      >
        {{ heading() }}
      </h1>
      <p class="text-muted-foreground max-w-[520px] text-[16px] leading-[26px]">{{ message() }}</p>

      <div class="mt-2 flex flex-wrap items-center gap-3">
        @if (serverError()) {
          <button hlmBtn size="sm" (click)="reload()">Try again</button>
        } @else if (home(); as h) {
          <a hlmBtn size="sm" [routerLink]="h">Go to inbox</a>
        } @else {
          <a hlmBtn size="sm" routerLink="/">Go home</a>
        }
        @if (workspaces().length > 1 && !serverError()) {
          @for (w of otherWorkspaces(); track w.id) {
            <a hlmBtn size="sm" variant="outline" [routerLink]="['/', w.slug, 'inbox']">Open {{ w.name }}</a>
          }
        }
        @if (!session.isAuthenticated() && !inShell()) {
          <a hlmBtn size="sm" variant="outline" routerLink="/login">Sign in</a>
        }
      </div>

      @if (inShell()) {
        <p class="text-faint mt-6 flex items-center gap-1.5 font-mono text-[11px]">
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
    if (slug && this.inShell()) return ['/', slug, 'inbox'];
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
