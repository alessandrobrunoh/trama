// Functional route guards (PLAN.md §5).
import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { SessionStore } from './session.store';

/** Signed in, else → /login?next=<url>. */
export const authGuard: CanActivateFn = async (_route, state) => {
  const session = inject(SessionStore);
  const router = inject(Router);
  await session.init();
  if (session.isAuthenticated()) return true;
  return router.createUrlTree(['/login'], {
    queryParams: state.url && state.url !== '/' ? { next: state.url } : {},
  });
};

/** Signed OUT only (login / signup); signed-in users go to their workspace. */
export const guestGuard: CanActivateFn = async (route) => {
  const session = inject(SessionStore);
  const router = inject(Router);
  await session.init();
  if (!session.isAuthenticated()) return true;
  const next = route.queryParamMap.get('next');
  return router.parseUrl(next && next.startsWith('/') && !next.startsWith('//') ? next : session.defaultWorkspaceUrl());
};

/** `/` → last used (or first) workspace, or /new-workspace. Always redirects. */
export const rootRedirectGuard: CanActivateFn = async () => {
  const session = inject(SessionStore);
  const router = inject(Router);
  await session.init();
  return router.parseUrl(session.isAuthenticated() ? session.defaultWorkspaceUrl() : '/login');
};

/**
 * On `/:workspaceSlug`: loads that workspace's snapshot (SessionStore.enterWorkspace).
 * Not a member / unknown → /404?workspace=<slug>. Server unreachable → /404?error=1.
 * Re-runs when `:workspaceSlug` changes. Requires authGuard before it.
 */
export const workspaceGuard: CanActivateFn = async (route) => {
  const session = inject(SessionStore);
  const router = inject(Router);
  const slug = route.paramMap.get('workspaceSlug') ?? '';
  const result = await session.enterWorkspace(slug);
  if (result === 'ok') return true;
  return router.createUrlTree(['/404'], {
    queryParams: result === 'error' ? { error: 1 } : { workspace: slug },
  });
};

/** Only allow the route when the active role is at least `minRole`; else → workspace overview. */
export function roleGuard(minRole: import('../contracts/domain').Role): CanActivateFn {
  return (route) => {
    const session = inject(SessionStore);
    const router = inject(Router);
    if (session.can(minRole)) return true;
    const slug = route.paramMap.get('workspaceSlug') ?? session.workspace()?.slug ?? '';
    return router.createUrlTree(['/', slug, 'overview']);
  };
}
