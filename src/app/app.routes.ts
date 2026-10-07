import { Routes } from '@angular/router';
import { AppShell } from './layout/app-shell';
import { authGuard, guestGuard, rootRedirectGuard, workspaceGuard } from './core/session/guards';

/**
 * Routes per PLAN.md §5. Every page is a lazy standalone component; route params and query
 * params are bound to component inputs (`withComponentInputBinding()`), and parent params are
 * inherited (`paramsInheritanceStrategy: 'always'`), so any page can declare
 * `workspaceSlug = input<string>()`.
 *
 * Workstream detail tabs use the `tab` QUERY param (`?tab=executions`), not child routes:
 * overview (default) | executions | artifacts | decisions | graph | activity | context.
 *
 * Reserved top-level paths (cannot be workspace slugs): login, signup, new-workspace, 404.
 */
export const routes: Routes = [
  {
    path: 'login',
    title: 'Sign in · Nabla',
    canActivate: [guestGuard],
    loadComponent: () => import('./features/auth/login-page').then((m) => m.LoginPage),
  },
  {
    path: 'signup',
    title: 'Create account · Nabla',
    canActivate: [guestGuard],
    loadComponent: () => import('./features/auth/signup-page').then((m) => m.SignupPage),
  },
  {
    path: 'new-workspace',
    title: 'New workspace · Nabla',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./features/auth/new-workspace-page').then((m) => m.NewWorkspacePage),
  },
  {
    path: '404',
    title: 'Not found · Nabla',
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
        title: 'Overview · Nabla',
        loadComponent: () => import('./features/overview/overview-page').then((m) => m.OverviewPage),
      },
      {
        path: 'attention',
        title: 'My Attention · Nabla',
        loadComponent: () =>
          import('./features/attention/attention-page').then((m) => m.AttentionPage),
      },
      {
        path: 'intake',
        title: 'Intake · Nabla',
        loadComponent: () => import('./features/intake/intake-page').then((m) => m.IntakePage),
      },
      {
        path: 'intake/:key',
        title: 'Intake · Nabla',
        loadComponent: () =>
          import('./features/intake/intake-detail-page').then((m) => m.IntakeDetailPage),
      },
      {
        path: 'workstreams',
        title: 'Workstreams · Nabla',
        loadComponent: () =>
          import('./features/workstreams/workstream-list-page').then((m) => m.WorkstreamListPage),
      },
      {
        path: 'workstreams/:key',
        title: 'Workstream · Nabla',
        loadComponent: () =>
          import('./features/workstreams/workstream-detail-page').then(
            (m) => m.WorkstreamDetailPage,
          ),
      },
      {
        path: 'executions/:id',
        title: 'Execution · Nabla',
        loadComponent: () =>
          import('./features/executions/execution-detail-page').then(
            (m) => m.ExecutionDetailPage,
          ),
      },
      {
        path: 'graph',
        title: 'Graph · Nabla',
        loadComponent: () => import('./features/graph/graph-page').then((m) => m.GraphPage),
      },
      {
        path: 'decisions',
        title: 'Decisions · Nabla',
        loadComponent: () =>
          import('./features/decisions/decision-list-page').then((m) => m.DecisionListPage),
      },
      {
        path: 'decisions/:key',
        title: 'Decision · Nabla',
        loadComponent: () =>
          import('./features/decisions/decision-detail-page').then((m) => m.DecisionDetailPage),
      },
      {
        path: 'repositories',
        title: 'Repositories · Nabla',
        loadComponent: () =>
          import('./features/repositories/repository-list-page').then((m) => m.RepositoryListPage),
      },
      {
        path: 'repositories/:id',
        title: 'Repository · Nabla',
        loadComponent: () =>
          import('./features/repositories/repository-detail-page').then(
            (m) => m.RepositoryDetailPage,
          ),
      },
      {
        path: 'teams',
        title: 'Teams · Nabla',
        loadComponent: () => import('./features/teams/team-list-page').then((m) => m.TeamListPage),
      },
      {
        path: 'teams/:key',
        title: 'Team · Nabla',
        loadComponent: () =>
          import('./features/teams/team-detail-page').then((m) => m.TeamDetailPage),
      },
      {
        path: 'views',
        title: 'Views · Nabla',
        loadComponent: () => import('./features/views/view-list-page').then((m) => m.ViewListPage),
      },
      {
        path: 'views/:id',
        title: 'View · Nabla',
        loadComponent: () =>
          import('./features/views/view-detail-page').then((m) => m.ViewDetailPage),
      },
      { path: 'settings', pathMatch: 'full', redirectTo: 'settings/profile' },
      {
        path: 'settings/:section',
        title: 'Settings · Nabla',
        loadComponent: () =>
          import('./features/settings/settings-page').then((m) => m.SettingsPage),
      },
      {
        path: '**',
        title: 'Not found · Nabla',
        loadComponent: () =>
          import('./features/not-found/not-found-page').then((m) => m.NotFoundPage),
      },
    ],
  },
  {
    path: '**',
    title: 'Not found · Nabla',
    loadComponent: () =>
      import('./features/not-found/not-found-page').then((m) => m.NotFoundPage),
  },
];
