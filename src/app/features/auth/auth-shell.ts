import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import { LucideMonitor, LucideMoon, LucideSun, LucideDynamicIcon } from '@lucide/angular';
import { RouterLink } from '@angular/router';
import { ThemeService } from '../../core/theme';
import { TramaLogo } from '../../shared/trama-logo';
import { SiteWeave } from '../landing/site-weave';

/**
 * Narrow centered column for /login, /register, /invite, /new-workspace, in the v3 site language: the
 * site header row (mark + wordmark, theme toggle), the weave divider, a mono kicker, a Newsreader title,
 * then the form. Hairlines instead of a card.
 *   <app-auth-shell kicker="SIGN IN" title="Sign in" subtitle="…"> form … <ng-container footer>…</ng-container> </app-auth-shell>
 */
@Component({
  selector: 'app-auth-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, LucideDynamicIcon, TramaLogo, SiteWeave],
  host: { class: 'bg-background text-foreground flex min-h-svh flex-col leading-normal' },
  template: `
    <header
      class="mx-auto flex h-16 w-full max-w-[1440px] items-center justify-between px-5 md:px-10 xl:px-[120px]"
    >
      <a routerLink="/" class="flex items-center gap-2.5" aria-label="Trama home">
        <app-trama-logo [size]="28" />
        <span class="font-title text-foreground text-[24px] leading-none">Trama</span>
      </a>
      <button
        type="button"
        class="text-faint hover:text-foreground -mr-2 inline-flex size-8 items-center justify-center transition-colors"
        [attr.aria-label]="'Theme: ' + theme.mode()"
        (click)="cycle()"
      >
        <svg [lucideIcon]="icon()" [size]="15"></svg>
      </button>
    </header>
    <app-site-weave />

    <main class="flex flex-1 items-start justify-center px-5 pt-14 pb-16 sm:pt-[min(14svh,112px)]">
      <div class="flex w-full max-w-[400px] flex-col gap-8">
        <div class="flex flex-col gap-3.5">
          @if (kicker()) {
            <div class="flex items-center gap-2.5">
              <span class="bg-primary size-2" aria-hidden="true"></span>
              <p class="text-faint font-mono text-[12px] tracking-[1.2px]">{{ kicker() }}</p>
            </div>
          }
          <h1
            class="font-title text-foreground text-[clamp(30px,5vw,40px)] leading-[1.1] tracking-[-0.019em]"
          >
            {{ title() }}
          </h1>
          @if (subtitle()) {
            <p class="text-muted-foreground text-[15px] leading-6">{{ subtitle() }}</p>
          }
        </div>
        <div class="flex flex-col"><ng-content /></div>
        <div
          class="border-border text-muted-foreground border-t pt-5 text-[13px] empty:hidden"
        >
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
  /** Mono kicker above the title ("SIGN IN"). */
  readonly kicker = input<string>();

  protected icon() {
    const m = this.theme.mode();
    return m === 'light' ? LucideSun : m === 'dark' ? LucideMoon : LucideMonitor;
  }
  protected cycle(): void {
    const m = this.theme.mode();
    this.theme.set(m === 'system' ? 'light' : m === 'light' ? 'dark' : 'system');
  }
}
