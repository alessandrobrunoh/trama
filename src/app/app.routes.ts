import { inject } from '@angular/core';
import { Router, Routes, type ActivatedRouteSnapshot } from '@angular/router';
import { AppShell } from './layout/app-shell';
import { authGuard, guestGuard, launchGuard, workspaceGuard } from './core/session/guards';

/**
 * Routes per PLAN.md §5. Every page is a lazy standalone component; route params and query
 * params are bound to component inputs (`withComponentInputBinding()`), and parent params are
 * inherited (`paramsInheritanceStrategy: 'always'`), so any page can declare
 * `workspaceSlug = input<string>()`.
 *
 * Workstream detail tabs use the `tab` QUERY param (`?tab=artifacts`), not child routes:
 * overview (default) | artifacts | decisions | graph | activity | context | stats.
 *
 * Reserved top-level paths (cannot be workspace slugs): login, register, signup, invite, shared, blog, roadmap,
 * changelog, brand, new-workspace, 404.
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
      {
        path: 'overview',
        title: 'Overview · Trama',
        loadComponent: () =>
          import('./features/overview/overview-page').then((m) => m.OverviewPage),
      },
      {
        path: 'assistant',
        title: 'Assistant · Trama',
        loadComponent: () => import('./features/ai/assistant-page').then((m) => m.AssistantPage),
      },
      {
        path: 'notifications',
        title: 'Notifications · Trama',
        loadComponent: () =>
          import('./features/notifications/notifications-page').then((m) => m.NotificationsPage),
      },
      {
        path: 'stats',
        title: 'Statistics · Trama',
        loadComponent: () => import('./features/stats/stats-page').then((m) => m.StatsPage),
      },
      {
        path: 'attention',
        title: 'My Attention · Trama',
        loadComponent: () =>
          import('./features/attention/attention-page').then((m) => m.AttentionPage),
      },
      {
        path: 'my-work',
        title: 'My Work · Trama',
        loadComponent: () => import('./features/my-work/my-work-page').then((m) => m.MyWorkPage),
      },
      {
        path: 'activity',
        title: 'Activity · Trama',
        loadComponent: () =>
          import('./features/activity/activity-page').then((m) => m.ActivityPage),
      },
      {
        path: 'issues',
        title: 'Issues · Trama',
        loadComponent: () => import('./features/issues/issue-page').then((m) => m.IssuePage),
      },
      {
        path: 'issues/:key',
        title: 'Issue · Trama',
        loadComponent: () =>
          import('./features/issues/issue-detail-page').then((m) => m.IssueDetailPage),
      },
      {
        path: 'customers',
        title: 'Customers · Trama',
        loadComponent: () =>
          import('./features/customers/customer-list-page').then((m) => m.CustomerListPage),
      },
      {
        path: 'customers/inbox',
        title: 'Customer request inbox · Trama',
        loadComponent: () =>
          import('./features/customers/customer-inbox-page').then((m) => m.CustomerInboxPage),
      },
      {
        path: 'customers/:id',
        title: 'Customer · Trama',
        loadComponent: () =>
          import('./features/customers/customer-detail-page').then((m) => m.CustomerDetailPage),
      },
      {
        path: 'workstreams',
        title: 'Workstreams · Trama',
        loadComponent: () =>
          import('./features/workstreams/workstream-list-page').then((m) => m.WorkstreamListPage),
      },
      {
        path: 'workstreams/:key',
        title: 'Workstream · Trama',
        loadComponent: () =>
          import('./features/workstreams/workstream-detail-page').then(
            (m) => m.WorkstreamDetailPage,
          ),
      },
      // The timeline is a layout of saved views now (views/:id with layout "timeline"); keep old links working.
      { path: 'timeline', pathMatch: 'full', redirectTo: 'views' },
      {
        path: 'graph',
        title: 'Graph · Trama',
        loadComponent: () => import('./features/graph/graph-page').then((m) => m.GraphPage),
      },
      {
        path: 'decisions',
        title: 'Decisions · Trama',
        loadComponent: () =>
          import('./features/decisions/decision-list-page').then((m) => m.DecisionListPage),
      },
      {
        path: 'decisions/:key',
        title: 'Decision · Trama',
        loadComponent: () =>
          import('./features/decisions/decision-detail-page').then((m) => m.DecisionDetailPage),
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
        // Repositories used to live under /projects: send old links (`rp_…` ids) to /repositories.
        canActivate: [
          (route: ActivatedRouteSnapshot) => {
            const id = route.paramMap.get('id') ?? '';
            return id.startsWith('rp_')
              ? inject(Router).createUrlTree([
                  '/',
                  route.paramMap.get('workspaceSlug') ?? '',
                  'repositories',
                  id,
                ])
              : true;
          },
        ],
        loadComponent: () =>
          import('./features/projects/project-detail-page').then((m) => m.ProjectDetailPage),
      },
      {
        path: 'repositories',
        title: 'Repositories · Trama',
        loadComponent: () =>
          import('./features/repositories/repository-list-page').then((m) => m.RepositoryListPage),
      },
      {
        path: 'repositories/:id',
        title: 'Repository · Trama',
        loadComponent: () =>
          import('./features/repositories/repository-detail-page').then(
            (m) => m.RepositoryDetailPage,
          ),
      },
      {
        path: 'teams',
        title: 'Teams · Trama',
        loadComponent: () => import('./features/teams/team-list-page').then((m) => m.TeamListPage),
      },
      {
        path: 'teams/:key',
        title: 'Team · Trama',
        loadComponent: () =>
          import('./features/teams/team-detail-page').then((m) => m.TeamDetailPage),
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
