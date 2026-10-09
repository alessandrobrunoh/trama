import { inject, InjectionToken, type ValueProvider } from '@angular/core';

export interface HlmSidebarConfig {
  defaultOpen: boolean;
  sidebarWidth: string;
  sidebarWidthMobile: string;
  sidebarWidthIcon: string;
  sidebarCookieName: string;
  sidebarCookieMaxAge: number;
  sidebarKeyboardShortcut: string;
  mobileBreakpoint: string;
  closeMobileSidebarOnMenuButtonClick: boolean;
}

const defaultConfig: HlmSidebarConfig = {
  defaultOpen: true,
  sidebarWidth: '16rem',
  sidebarWidthMobile: '18rem',
  sidebarWidthIcon: '3rem',
  sidebarCookieName: 'sidebar_state',
  sidebarCookieMaxAge: 60 * 60 * 24 * 7, // 7 days in seconds
  sidebarKeyboardShortcut: 'b',
  // Tailwind's `md` starts AT 768px: a `max-width: 768px` query made exactly 768px neither desktop nor mobile.
  mobileBreakpoint: '767.98px',
  closeMobileSidebarOnMenuButtonClick: false,
};

const HlmSidebarConfigToken = new InjectionToken<HlmSidebarConfig>('HlmSidebarConfig');

export function provideHlmSidebarConfig(config: Partial<HlmSidebarConfig>): ValueProvider {
  return { provide: HlmSidebarConfigToken, useValue: { ...defaultConfig, ...config } };
}

export function injectHlmSidebarConfig(): HlmSidebarConfig {
  return inject(HlmSidebarConfigToken, { optional: true }) ?? defaultConfig;
}
