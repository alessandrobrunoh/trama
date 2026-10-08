import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { HlmToasterImports } from '@spartan-ng/helm/sonner';
import { ThemeService } from './core/theme';

@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, HlmToasterImports],
  template: `
    <router-outlet />
    <hlm-toaster position="bottom-right" [theme]="theme.resolved()" />
  `,
})
export class App {
  // Instantiate early so the saved theme is applied and ⌘J / system changes are tracked.
  protected readonly theme = inject(ThemeService);
}
