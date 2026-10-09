// Functional route guards (PLAN.md §5).
import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { UiStore } from '../stores/ui.store';
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

/** Signed OUT only (login / register); signed-in users go to their workspace. */
export const guestGuard: CanActivateFn = async (route) => {
  const session = inject(SessionStore);
  const router = inject(Router);
  await session.init();
  if (!session.isAuthenticated()) return true;
  const next = route.queryParamMap.get('next');
  return router.parseUrl(
    next && next.startsWith('/') && !next.startsWith('//') ? next : session.defaultWorkspaceUrl(),
  );
};

/**
 * On `/:workspaceSlug`: loads that workspace's snapshot (SessionStore.enterWorkspace).
 * Not a member / unknown → /404?workspace=<slug>. Server unreachable → /404?error=1.
 * Re-runs when `:workspaceSlug` changes. Requires authGuard before it.
 */
export const workspaceGuard: CanActivateFn = async (route, state) => {
  const session = inject(SessionStore);
  const router = inject(Router);
  const slug = route.paramMap.get('workspaceSlug') ?? '';
  const result = await session.enterWorkspace(slug);
  if (result === 'ok') return true;
  // A 401 while loading the snapshot clears the session. Do not leave that as a 404 inside the app.
  if (!session.isAuthenticated()) {
    return router.createUrlTree(['/login'], {
      queryParams: state.url && state.url !== '/' ? { next: state.url } : {},
    });
  }
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

/** Where an installed app opens (`start_url`) and where its home-screen shortcuts point. */
const LAUNCH_SECTIONS = new Set(['inbox', 'my-work', 'issues', 'workstreams', 'projects', 'overview']);

/**
 * `/a/launch?go=inbox|my-work|issues|new-issue|search`: the PWA entry point. Signed in, it opens the last
 * workspace (on `go`, when given); signed out, it asks to sign in first. The landing page at `/` is for the
 * web, not for the installed app. (`a` is too short to be a workspace slug, so this path cannot collide.)
 */
export const launchGuard: CanActivateFn = async (route, state) => {
  const session = inject(SessionStore);
  const router = inject(Router);
  const ui = inject(UiStore);
  await session.init();
  if (!session.isAuthenticated()) {
    return router.createUrlTree(['/login'], { queryParams: { next: state.url } });
  }
  const go = route.queryParamMap.get('go') ?? '';
  const base = session.defaultWorkspaceUrl();
  if (base === '/new-workspace') return router.parseUrl(base);
  const slug = base.split('/')[1];
  if (go === 'new-issue') ui.openCreate('issue');
  else if (go === 'search') ui.openModal('search');
  return router.parseUrl(LAUNCH_SECTIONS.has(go) ? `/${slug}/${go}` : base);
};
