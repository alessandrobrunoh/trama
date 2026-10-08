import { Routes } from '@angular/router';
import { AppShell } from './layout/app-shell';
import { authGuard, guestGuard, rootRedirectGuard, workspaceGuard } from './core/session/guards';

/**
 * Routes per PLAN.md §5. Every page is a lazy standalone component; route params and query
 * params are bound to component inputs (`withComponentInputBinding()`), and parent params are
 * inherited (`paramsInheritanceStrategy: 'always'`), so any page can declare
 * `workspaceSlug = input<string>()`.
 *
 * Workstream detail tabs use the `tab` QUERY param (`?tab=artifacts`), not child routes:
 * overview (default) | artifacts | decisions | graph | activity | context | stats.
 *
 * Reserved top-level paths (cannot be workspace slugs): login, signup, new-workspace, 404.
 */
export const routes: Routes = [
  {
    path: 'login',
    title: 'Sign in · Trama',
    canActivate: [guestGuard],
    loadComponent: () => import('./features/auth/login-page').then((m) => m.LoginPage),
  },
  {
    path: 'signup',
    title: 'Create account · Trama',
    canActivate: [guestGuard],
    loadComponent: () => import('./features/auth/signup-page').then((m) => m.SignupPage),
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
    loadComponent: () =>
      import('./features/not-found/not-found-page').then((m) => m.NotFoundPage),
  },
  // `/` → last used (or first) workspace, /new-workspace if none, /login if signed out.
  { path: '', pathMatch: 'full', canActivate: [rootRedirectGuard], children: [] },
  {
    path: ':workspaceSlug',
    component: AppShell,
    canActivate: [authGuard, workspaceGuard],
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'overview' },
      {
        path: 'overview',
        title: 'Overview · Trama',
        loadComponent: () => import('./features/overview/overview-page').then((m) => m.OverviewPage),
      },
      {
        path: 'assistant',
        title: 'Assistant · Trama',
        loadComponent: () =>
          import('./features/ai/assistant-page').then((m) => m.AssistantPage),
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
        loadComponent: () => import('./features/activity/activity-page').then((m) => m.ActivityPage),
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
      {
        path: 'timeline',
        title: 'Timeline · Trama',
        loadComponent: () => import('./features/timeline/timeline-page').then((m) => m.TimelinePage),
      },
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
          import('./features/repositories/repository-list-page').then((m) => m.RepositoryListPage),
      },
      {
        path: 'projects/:id',
        title: 'Project · Trama',
        loadComponent: () =>
          import('./features/repositories/repository-detail-page').then(
            (m) => m.RepositoryDetailPage,
          ),
      },
      { path: 'repositories', pathMatch: 'full', redirectTo: 'projects' },
      { path: 'repositories/:id', redirectTo: 'projects/:id' },
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
    loadComponent: () =>
      import('./features/not-found/not-found-page').then((m) => m.NotFoundPage),
  },
];
