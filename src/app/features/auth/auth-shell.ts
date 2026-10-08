import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import { LucideMonitor, LucideMoon, LucideSun, LucideDynamicIcon } from '@lucide/angular';
import { RouterLink } from '@angular/router';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import { ThemeService } from '../../core/theme';

/**
 * Centered, calm frame for /login, /register, /new-workspace.
 *   <app-auth-shell title="Sign in" subtitle="…"> form … <ng-container footer>…</ng-container> </app-auth-shell>
 */
@Component({
  selector: 'app-auth-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, HlmButtonImports, HlmTooltip, LucideDynamicIcon],
  host: { class: 'bg-background text-foreground relative isolate flex min-h-svh flex-col overflow-hidden' },
  template: `
    <!-- Soft light from above, using the active theme tokens. -->
    <div
      aria-hidden="true"
      class="bg-primary/10 pointer-events-none absolute top-[-18rem] left-1/2 -z-10 h-[32rem] w-[52rem] -translate-x-1/2 rounded-full blur-3xl"
    ></div>

    <header class="flex h-12 items-center justify-end px-4 sm:px-6">
      <button
        hlmBtn
        variant="ghost"
        size="icon-sm"
        class="text-muted-foreground"
        [hlmTooltip]="'Theme: ' + theme.mode()"
        position="bottom"
        aria-label="Change theme"
        (click)="cycle()"
      >
        <svg [lucideIcon]="icon()" [size]="15"></svg>
      </button>
    </header>

    <main class="flex flex-1 items-start justify-center px-4 pt-[min(7svh,3rem)] pb-12 sm:items-center sm:pt-0 sm:pb-20">
      <div class="w-full max-w-[25rem]">
        <a class="mb-7 flex justify-center" routerLink="/" aria-label="Trama home">
          <img src="/icons/trama-horizontal-black.svg" alt="Trama" class="h-10 w-auto dark:hidden" />
          <img src="/icons/trama-horizontal-white.svg" alt="Trama" class="hidden h-10 w-auto dark:block" />
        </a>
        <section class="border-border/70 bg-card/95 rounded-2xl border px-6 py-7 shadow-[var(--shadow-menu)] sm:px-8 sm:py-8">
          <div class="mb-7 flex flex-col items-center text-center">
            <h1 class="text-[22px] font-semibold tracking-tight">{{ title() }}</h1>
            @if (subtitle()) {
              <p class="text-muted-foreground mt-2 max-w-[20rem] text-[13px] leading-relaxed">{{ subtitle() }}</p>
            }
          </div>
          <ng-content />
          <div class="text-muted-foreground mt-6 border-border/60 border-t pt-5 text-center text-[13px] empty:hidden">
            <ng-content select="[footer]" />
          </div>
        </section>
        <p class="text-muted-foreground/70 mt-6 text-center text-[11px] tracking-wide">A clearer way to work together</p>
      </div>
    </main>
  `,
})
export class AuthShell {
  protected readonly theme = inject(ThemeService);
  readonly title = input.required<string>();
  readonly subtitle = input<string>();

  protected icon() {
    const m = this.theme.mode();
    return m === 'light' ? LucideSun : m === 'dark' ? LucideMoon : LucideMonitor;
  }
  protected cycle(): void {
    const m = this.theme.mode();
    this.theme.set(m === 'system' ? 'light' : m === 'light' ? 'dark' : 'system');
  }
}
