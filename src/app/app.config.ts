import {
  ApplicationConfig,
  inject,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
} from '@angular/core';
import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import {
  provideRouter,
  withComponentInputBinding,
  withInMemoryScrolling,
  withRouterConfig,
} from '@angular/router';
import { provideLucideConfig } from '@lucide/angular';
import { toast } from '@spartan-ng/brain/sonner';
import { provideSpartanHlm } from '@spartan-ng/helm/utils';
import { routes } from './app.routes';
import { apiInterceptor } from './core/api/api.interceptor';
import { Notifier } from './core/notify/notifier';
import { LiveSync } from './core/sync/live-sync.service';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZonelessChangeDetection(),
    // Spartan: CDK overlays must not use the top-layer popover (keeps toasts above dialogs).
    provideSpartanHlm(),
    provideRouter(
      routes,
      withComponentInputBinding(),
      // Children inherit `:workspaceSlug` so pages can bind it as an input.
      withRouterConfig({ paramsInheritanceStrategy: 'always' }),
      withInMemoryScrolling({ scrollPositionRestoration: 'top' }),
    ),
    // Cookie session + X-Client-Id on writes for requests to /api.
    provideHttpClient(withFetch(), withInterceptors([apiInterceptor])),
    // Route core toasts (rollback errors, "no permission", session expiry) to Spartan sonner.
    // `<hlm-toaster />` (HlmToasterImports from ui/sonner) must be mounted once in the root template.
    provideAppInitializer(() => {
      inject(Notifier).use((kind, title, options) => {
        toast[kind](title, {
          description: options?.description,
          duration: options?.duration,
          action: options?.action ? { label: options.action.label, onClick: options.action.run } : undefined,
        });
      });
    }),
    // Instantiate LiveSync (SSE) up front; it connects whenever a workspace is loaded.
    provideAppInitializer(() => {
      inject(LiveSync);
    }),
    provideLucideConfig({ size: 16, strokeWidth: 1.75 }),
  ],
};
