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
  host: { class: 'bg-background text-foreground flex min-h-svh flex-col' },
  template: `
    <header class="flex h-12 items-center justify-between px-4 sm:px-6">
      <span class="flex items-center gap-2 text-sm font-semibold tracking-tight">
        <span
          class="bg-foreground text-background flex size-5 items-center justify-center rounded-[5px] text-[13px] leading-none"
          aria-hidden="true"
          >∇</span
        >
        Nabla
      </span>
      <button
        hlmBtn
        variant="ghost"
        size="icon"
        [hlmTooltip]="'Theme: ' + theme.mode()"
        position="bottom"
        aria-label="Change theme"
        (click)="cycle()"
      >
        <svg [lucideIcon]="icon()" [size]="15"></svg>
      </button>
    </header>

    <main class="flex flex-1 items-start justify-center px-4 pt-[min(14svh,6rem)] pb-12 sm:items-center sm:pt-0 sm:pb-24">
      <div class="w-full max-w-[22rem]">
        <div class="mb-6">
          <h1 class="text-xl font-semibold tracking-tight">{{ title() }}</h1>
          @if (subtitle()) {
            <p class="text-muted-foreground mt-1.5 text-sm leading-snug">{{ subtitle() }}</p>
          }
        </div>
        <ng-content />
        <div class="text-muted-foreground mt-6 text-center text-sm empty:hidden">
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
