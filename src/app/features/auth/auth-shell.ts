import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import { LucideMonitor, LucideMoon, LucideSun, LucideDynamicIcon } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import { ThemeService } from '../../core/theme';

/**
 * Centered, calm frame for /login, /signup, /new-workspace.
 *   <app-auth-shell title="Sign in" subtitle="…"> form … <ng-container footer>…</ng-container> </app-auth-shell>
 */
@Component({
  selector: 'app-auth-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButtonImports, HlmTooltip, LucideDynamicIcon],
  host: { class: 'bg-background text-foreground relative isolate flex min-h-svh flex-col overflow-hidden' },
  template: `
    <!-- Soft light from above, like Linear's sign-in. Token-based so it follows the theme. -->
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

    <main class="flex flex-1 items-start justify-center px-4 pt-[min(10svh,4rem)] pb-12 sm:items-center sm:pt-0 sm:pb-24">
      <div class="w-full max-w-[21rem]">
        <div class="mb-8 flex flex-col items-center text-center">
          <span
            class="bg-foreground text-background mb-6 flex size-11 items-center justify-center rounded-xl text-2xl leading-none shadow-[var(--shadow-menu)]"
            aria-hidden="true"
            >∇</span
          >
          <h1 class="text-[22px] font-semibold tracking-tight">{{ title() }}</h1>
          @if (subtitle()) {
            <p class="text-muted-foreground mt-2 max-w-[19rem] text-[13px] leading-relaxed">{{ subtitle() }}</p>
          }
        </div>
        <ng-content />
        <div class="text-muted-foreground mt-8 text-center text-[13px] empty:hidden">
          <ng-content select="[footer]" />
        </div>
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
