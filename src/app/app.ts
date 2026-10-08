import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { HlmToasterImports } from '@spartan-ng/helm/sonner';
import { Preferences } from './core/preferences';
import { AccentService, ThemeService } from './core/theme';

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
  // Instantiate early so font size, cursors, links and motion preferences are applied.
  protected readonly preferences = inject(Preferences);
  // Instantiate early so the workspace colour becomes the accent colour.
  protected readonly accent = inject(AccentService);
}
