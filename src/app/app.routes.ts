import { inject } from '@angular/core';
import { Router, type Route, type Routes, type ActivatedRouteSnapshot } from '@angular/router';
import { AppShell } from './layout/app-shell';
import { authGuard, guestGuard, launchGuard, workspaceGuard } from './core/session/guards';

/** `/:workspace/<old path>` → `/:workspace/inbox?tab=<tab>`; other query params are dropped. */
function redirectInbox(path: string, tab: string): Route {
  return {
    path,
    pathMatch: 'full',
    canActivate: [
      (route: ActivatedRouteSnapshot) =>
        inject(Router).createUrlTree(['/', route.paramMap.get('workspaceSlug') ?? '', 'inbox'], {
          queryParams: { tab },
        }),
    ],
    children: [],
  };
}

/**
 * Routes per PLAN.md §5. Every page is a lazy standalone component; route params and query
 * params are bound to component inputs (`withComponentInputBinding()`), and parent params are
 * inherited (`paramsInheritanceStrategy: 'always'`), so any page can declare
 * `workspaceSlug = input<string>()`.
 *
 * Reserved top-level paths (cannot be workspace slugs): login, register, signup, invite, shared, blog, roadmap,
 * changelog, compare, why, brand, new-workspace, 404.
 */
export const routes: Routes = [
  {
    path: 'login',
    title: 'Sign in · Trama',
    canActivate: [guestGuard],
    loadComponent: () => import('./features/auth/login-page').then((m) => m.LoginPage),
  },
  {
    path: 'register',
    title: 'Create account · Trama',
    canActivate: [guestGuard],
    loadComponent: () => import('./features/auth/signup-page').then((m) => m.SignupPage),
  },
  // Old links: /signup → /register (query params such as `next` are kept).
  { path: 'signup', pathMatch: 'full', redirectTo: 'register' },
  {
    // Public on purpose: shows the invitation, then asks to sign in or sign up (see InvitePage).
    path: 'invite/:token',
    title: 'Join a workspace · Trama',
    loadComponent: () => import('./features/auth/invite-page').then((m) => m.InvitePage),
  },
  {
    // Public on purpose: a saved view shared by link ("anyone with the link"). Read-only, no app chrome.
    path: 'shared/:token',
    title: 'Shared view · Trama',
    loadComponent: () => import('./features/views/public-view-page').then((m) => m.PublicViewPage),
  },
  {
    path: 'blog',
    title: 'Blog · Trama',
    loadComponent: () => import('./features/blog/blog-index-page').then((m) => m.BlogIndexPage),
  },
  {
    path: 'blog/:slug',
    title: (route) =>
      import('./features/blog/blog-posts').then(
        (m) =>
          `${m.findPost(route.paramMap.get('slug') ?? '')?.title ?? 'Post not found'} · Trama Blog`,
      ),
    loadComponent: () => import('./features/blog/blog-post-page').then((m) => m.BlogPostPage),
  },
  {
    path: 'roadmap',
    title: 'Roadmap · Trama',
    loadComponent: () => import('./features/roadmap/roadmap-page').then((m) => m.RoadmapPage),
  },
  {
    path: 'changelog',
    title: 'Changelog · Trama',
    loadComponent: () => import('./features/changelog/changelog-page').then((m) => m.ChangelogPage),
  },
  {
    path: 'compare',
    title: 'Compare · Trama',
    loadComponent: () => import('./features/compare/compare-page').then((m) => m.ComparePage),
  },
  {
    path: 'why',
    title: 'Why Trama · Trama',
    loadComponent: () => import('./features/why/why-page').then((m) => m.WhyPage),
  },
  {
    path: 'brand',
    title: 'Brand · Trama',
    loadComponent: () => import('./features/brand/brand-page').then((m) => m.BrandPage),
  },
  {
    path: 'new-workspace',
    title: 'New workspace · Trama',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./features/auth/new-workspace-page').then((m) => m.NewWorkspacePage),
  },
  {
    path: '404',
    title: 'Not found · Trama',
    loadComponent: () => import('./features/not-found/not-found-page').then((m) => m.NotFoundPage),
  },
  // PWA entry point (start_url and home-screen shortcuts), see launchGuard.
  { path: 'a/launch', canActivate: [launchGuard], children: [] },
  // `/` is always the public landing page, regardless of session state.
  {
    path: '',
    pathMatch: 'full',
    title: 'Trama · Coordination for humans and coding agents',
    loadComponent: () => import('./features/landing/landing-page').then((m) => m.LandingPage),
  },
  {
    path: ':workspaceSlug',
    component: AppShell,
    canActivate: [authGuard, workspaceGuard],
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'overview' },
      // Home (v3): what I work on now, what is next, what needs me. Kept at /overview so links stay valid.
      {
        path: 'overview',
        title: 'Home · Trama',
        loadComponent: () =>
          import('./features/home/home-page').then((m) => m.HomePage),
      },
      {
        path: 'assistant',
        title: 'Assistant · Trama',
        loadComponent: () => import('./features/ai/assistant-page').then((m) => m.AssistantPage),
      },
      {
        path: 'inbox',
        title: 'Inbox · Trama',
        loadComponent: () => import('./features/inbox/inbox-page').then((m) => m.InboxPage),
      },
      // My Attention, Notifications and My Work became tabs of the Inbox; old links keep working.
      redirectInbox('attention', 'needs-you'),
      redirectInbox('notifications', 'updates'),
      redirectInbox('my-work', 'tasks'),
      {
        path: 'connect',
        title: 'Connect your agent · Trama',
        loadComponent: () =>
          import('./features/onboarding/connect-agent-page').then((m) => m.ConnectAgentPage),
      },
      {
        path: 'stats',
        title: 'Statistics · Trama',
        loadComponent: () => import('./features/stats/stats-page').then((m) => m.StatsPage),
      },
      {
        path: 'activity',
        title: 'Activity · Trama',
        loadComponent: () =>
          import('./features/activity/activity-page').then((m) => m.ActivityPage),
      },
      {
        path: 'tasks',
        title: 'Tasks · Trama',
        loadComponent: () => import('./features/issues/issue-page').then((m) => m.IssuePage),
      },
      {
        // The same task table, fixed to the board layout (v3 sidebar "Board").
        path: 'board',
        title: 'Board · Trama',
        data: { layout: 'board' },
        loadComponent: () => import('./features/issues/issue-page').then((m) => m.IssuePage),
      },
      {
        path: 'tasks/:key',
        title: 'Task · Trama',
        loadComponent: () =>
          import('./features/issues/issue-detail-page').then((m) => m.IssueDetailPage),
      },
      // Old shared links: /issues and /issues/:key keep working.
      { path: 'issues', pathMatch: 'full', redirectTo: 'tasks' },
      { path: 'issues/:key', redirectTo: 'tasks/:key' },
      { path: 'roadmap', pathMatch: 'full', redirectTo: 'timeline' },
      {
        path: 'timeline',
        title: 'Timeline · Trama',
        loadComponent: () =>
          import('./features/timeline/timeline-page').then((m) => m.TimelinePage),
      },
      {
        path: 'timer',
        title: 'Timer · Trama',
        loadComponent: () => import('./features/timer/timer-page').then((m) => m.TimerPage),
      },
      {
        path: 'projects',
        title: 'Projects · Trama',
        loadComponent: () =>
          import('./features/projects/project-list-page').then((m) => m.ProjectListPage),
      },
      {
        path: 'projects/:id',
        title: 'Project · Trama',
        loadComponent: () =>
          import('./features/projects/project-detail-page').then((m) => m.ProjectDetailPage),
      },
      {
        path: 'views',
        title: 'Views · Trama',
        loadComponent: () => import('./features/views/view-list-page').then((m) => m.ViewListPage),
      },
      {
        path: 'views/:id',
        title: 'View · Trama',
        loadComponent: () =>
          import('./features/views/view-detail-page').then((m) => m.ViewDetailPage),
      },
      { path: 'settings', pathMatch: 'full', redirectTo: 'settings/profile' },
      {
        path: 'settings/:section',
        title: 'Settings · Trama',
        loadComponent: () =>
          import('./features/settings/settings-page').then((m) => m.SettingsPage),
      },
      {
        path: '**',
        title: 'Not found · Trama',
        loadComponent: () =>
          import('./features/not-found/not-found-page').then((m) => m.NotFoundPage),
      },
    ],
  },
  {
    path: '**',
    title: 'Not found · Trama',
    loadComponent: () => import('./features/not-found/not-found-page').then((m) => m.NotFoundPage),
  },
];
