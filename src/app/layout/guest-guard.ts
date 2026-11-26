import { inject } from '@angular/core';
import { Router, type CanActivateChildFn } from '@angular/router';
import { TramaStore } from '../core/stores/trama.store';
import { guestMayOpenSettings, resolveSettingsSection } from '../features/settings/settings-nav';
import { guestMayOpen } from './nav';

/**
 * Keeps a guest inside what they have. A page the sidebar does not offer them (saved views, statistics, Ask,
 * connecting an agent, workspace settings) sends them back to the Inbox, or to their Profile for a settings
 * section. The server refuses the same requests; this only makes the app say so gracefully, not with an error.
 * Everyone else passes. Runs after `workspaceGuard`, so the role is known.
 */
export const guestRouteGuard: CanActivateChildFn = (_route, state) => {
  const store = inject(TramaStore);
  if (!store.isGuest()) return true;
  const router = inject(Router);
  const [slug, segment, section] = state.url.split(/[?#]/)[0].split('/').filter(Boolean);
  if (segment === 'settings') {
    return guestMayOpenSettings(resolveSettingsSection(section))
      ? true
      : router.createUrlTree(['/', slug, 'settings', 'profile']);
  }
  return guestMayOpen(segment) ? true : router.createUrlTree(['/', slug, 'inbox']);
};
