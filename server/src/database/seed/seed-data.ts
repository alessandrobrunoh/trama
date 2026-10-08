import { addMockHistoryToSeed } from '../mock-history.js';
import { SeedBuilder, SYSTEM, agent, team, user, type SeedData } from './builder.js';

export const DEMO_EMAIL = 'demo@nabla.dev';
export const DEMO_PASSWORD = 'nabla-demo';

/**
 * The "Acme" demo workspace: 14 workstreams covering every derived status, executions with
 * subthreads and dependencies, artifacts, decisions (ADR-1…23), issues, comments, views and
 * ~6 weeks of event history, all relative to `now`. Stored `status` values follow PLAN.md §2
 * so the UI is right before the status engine runs.
 */
export function createSeed(now: number, passwordHash: string, opts: { mockHistory?: boolean } = {}): SeedData {
  const b = new SeedBuilder(now);
  const ws = b.workspaceId;
  b.data.workspace = { id: ws, name: 'Acme', slug: 'acme', createdAt: b.at(60) };

  // ───────── people
  const ale = b.user('Alessandro Bruno', DEMO_EMAIL, 212, passwordHash, 'owner', 60);
  const maya = b.user('Maya Chen', 'maya@acme.dev', 158, passwordHash, 'admin', 60);
  const jonas = b.user('Jonas Weber', 'jonas@acme.dev', 28, passwordHash, 'member', 58);
  const priya = b.user('Priya Nair', 'priya@acme.dev', 320, passwordHash, 'member', 58);
  const tomas = b.user('Tomas Silva', 'tomas@acme.dev', 96, passwordHash, 'member', 57);
  const elena = b.user('Elena Rossi', 'elena@acme.dev', 262, passwordHash, 'viewer', 50);

  const delta = b.agent('Delta', 'delta', 'Delta threads running in isolated dev environments', ale);
  const claude = b.agent('Claude Code', 'claude_code', 'Claude Code sessions for implementation and refactors', maya);
  const codex = b.agent('Codex', 'codex', 'Codex agent for reviews, migrations and test generation', jonas);
  const cursor = b.agent('Cursor', 'cursor', 'Cursor background agent for UI work', priya);

  // ───────── teams
  const PLAT = b.team('Platform', 'PLAT', '#6366f1', 'Developer platform, shared libraries and cross-cutting initiatives', [ale, maya]);
  const API = b.team('Backend', 'API', '#0ea5e9', 'Public API and core services', [jonas, ale]);
  const WEB = b.team('Web', 'WEB', '#14b8a6', 'Web client and design system', [priya, ale]);
  const SEC = b.team('Security', 'SEC', '#ef4444', 'Application security and compliance', [tomas]);
  const PAY = b.team('Payments', 'PAY', '#f59e0b', 'Checkout, billing and payment providers', [jonas, maya]);
  const AUTH = b.team('Identity', 'AUTH', '#8b5cf6', 'Authentication, sessions and access control', [maya, jonas, ale]);
  const INF = b.team('Infra', 'INF', '#64748b', 'Infrastructure, CI and observability', [tomas, maya]);

  // ───────── repositories
  const rApi = b.repo('github', 'acme/api', [API, PLAT]);
  const rWeb = b.repo('github', 'acme/web', [WEB]);
  const rAuth = b.repo('github', 'acme/auth-service', [AUTH]);
  const rInfra = b.repo('github', 'acme/infra', [INF]);
  const rPay = b.repo('github', 'acme/payments', [PAY]);
  b.repo('gitlab', 'acme-internal/mobile-app', [WEB, API]);

  b.data.integrations.push(
    { id: 'ic_github_acme', workspaceId: ws, provider: 'github', account: 'acme', baseUrl: null, secret: null, webhookSecret: null, status: 'connected', lastSyncAt: b.at(0, 1), lastError: null, config: {}, createdAt: b.at(55) },
    { id: 'ic_delta_dev', workspaceId: ws, provider: 'delta', account: 'delta.dev', baseUrl: 'https://delta.dev', secret: null, webhookSecret: null, status: 'connected', lastSyncAt: b.at(0, 3), lastError: null, config: {}, createdAt: b.at(54) },
    { id: 'ic_gitlab_internal', workspaceId: ws, provider: 'gitlab', account: 'acme-internal', baseUrl: 'https://gitlab.com', secret: null, webhookSecret: null, status: 'error', lastSyncAt: b.at(3), lastError: '401 Unauthorized: personal access token expired', config: {}, createdAt: b.at(40) },
  );

  const S = (h: string) => `https://delta.dev/t/${h}`;

  // ───────── projects (planning level; workstreams below carry them out)
  const pAuth = b.project({
    name: 'Auth hardening', summary: 'Safer sessions and key management across api, web and auth-service.',
    color: '#8b5cf6', status: 'in_progress', priority: 'high', lead: maya, teams: [AUTH, SEC], start: 25, target: 20, created: 26, createdBy: maya,
  });
  const pCheckout = b.project({
    name: 'Checkout v2', summary: 'A faster, server-driven checkout that matches the new brand.',
    color: '#f59e0b', status: 'in_progress', priority: 'high', lead: priya, teams: [WEB, PAY, PLAT], start: 40, target: 30, created: 41, createdBy: priya,
  });

  // ═══════════════════════════ AUTH-42 — needs_input ═══════════════════════════
  const auth42 = b.workstream({
    key: 'AUTH-42', project: pAuth,
    title: 'Improve refresh token rotation',
    objective: 'Users remain authenticated while refresh tokens rotate safely.',
    context:
      'Support reports (BUG-142, BUG-139) show users randomly redirected to login. Root cause: two refresh paths with no shared replay detection and no rotation grace window. We want deterministic, replay-safe rotation across api, web and auth-service.',
    owner: AUTH, participating: [API, WEB, SEC], accountable: maya, repos: [rAuth, rApi, rWeb], priority: 'high', labels: ['auth', 'reliability'],
    criteria: [
      ['Existing sessions survive rotation', 'met'],
      ['Token replay is rejected', 'met'],
      ['Integration tests pass', 'in_progress'],
      ['Metrics are available', 'pending'],
    ],
    path: ['draft', 'planned', 'working', 'needs_input'], start: 20, target: 6, created: 21, createdBy: maya,
  });
  const a42e1 = b.execution(auth42, {
    title: 'Investigate the current authentication flow', description: 'Map every login/refresh/logout path and where tokens are validated.', team: AUTH, repos: [rAuth, rApi],
    performers: [agent(delta)], provider: 'delta', state: 'completed', session: S('auth-flow-8f21'), created: 20, done: 17,
    notes: [[19, 'Mapped login, refresh and logout paths across api and auth-service'], [18, 'Found two refresh paths that do not share replay detection']],
  });
  const a42e2 = b.execution(auth42, {
    title: 'Implement backend rotation', description: 'Rotate on every use, detect replay, revoke the token family on replay.', team: API, repos: [rAuth, rApi],
    performers: [agent(delta)], provider: 'delta', state: 'running', deps: [a42e1], session: S('rotation-backend-31c7'), branch: 'auth-42/rotation-backend', created: 16,
    note: 'Rotation store and replay detection merged (#182). Wiring metrics next.',
    notes: [[12, 'Token family model drafted, awaiting store migration'], [6, 'Replay detection merged in #182'], [1, 'Wiring metrics next']],
  });
  const a42e2a = b.execution(auth42, {
    title: 'Rotation token store migration', parent: a42e2, team: API, repos: [rAuth], performers: [user(jonas)], provider: 'human', state: 'completed', created: 15, done: 12,
    notes: [[13, 'Migration applied on staging, backfill finished']],
  });
  const a42e2b = b.execution(auth42, {
    title: 'Replay detection and tests', parent: a42e2, team: AUTH, repos: [rAuth], performers: [agent(claude)], provider: 'claude_code', state: 'completed', deps: [a42e2a],
    session: 'https://claude.ai/code/session_a42rd', branch: 'auth-42/replay-detection', created: 13, done: 9, notes: [[10, '14 integration tests added, all green locally']],
  });
  const a42e3 = b.execution(auth42, {
    title: 'Update the web client', description: 'Handle rotated tokens transparently in the HTTP layer.', team: WEB, repos: [rWeb], performers: [user(priya)], provider: 'human', state: 'in_review',
    deps: [a42e2b], branch: 'auth-42/web-refresh', created: 9, notes: [[3, 'PR #187 opened, interceptor retries once on 401']],
  });
  const a42e4 = b.execution(auth42, {
    title: 'Frontend integration: session TTL handling', team: WEB, repos: [rWeb], performers: [agent(claude)], provider: 'claude_code', state: 'needs_input',
    session: 'https://claude.ai/code/session_a42ttl', created: 5, note: 'Waiting for a decision on the refresh token TTL.', notes: [[1, 'Blocked on decision: what should the refresh token TTL be?']],
  });
  b.execution(auth42, {
    title: 'Security review', team: SEC, repos: [rAuth], performers: [agent(codex), team(SEC)], provider: 'codex', state: 'running', deps: [a42e2b], created: 3,
    notes: [[2, 'Reviewing token family revocation and cookie flags']],
  });
  b.input(auth42, { execution: a42e4, question: 'Refresh token TTL?', options: ['7 days sliding', '30 days absolute', '90 days absolute'], by: agent(claude), assignee: ale, created: 1 });
  b.input(auth42, { execution: a42e4, question: 'Should we revoke all sessions on password change?', by: agent(claude), assignee: maya, created: 0.4 });
  b.input(auth42, { execution: a42e2, question: 'Should replay of a rotated token revoke the whole token family?', options: ['Revoke the token only', 'Revoke the whole family'], by: agent(delta), assignee: maya, created: 14, answer: { text: 'Revoke the whole family and force a re-login.', by: maya, daysAgo: 13 } });
  b.artifact(auth42, { kind: 'pull_request', provider: 'github', title: 'Implement refresh token rotation', execution: a42e2b, repo: rAuth, externalId: '#182', url: 'https://github.com/acme/auth-service/pull/182', state: 'merged', ci: 'passing', review: 'approved', by: agent(claude), created: 11, updated: 8 });
  b.artifact(auth42, { kind: 'pull_request', provider: 'github', title: 'Update web refresh handling', execution: a42e3, repo: rWeb, externalId: '#187', url: 'https://github.com/acme/web/pull/187', state: 'open', ci: 'passing', review: 'requested', by: user(priya), created: 3, updated: 1 });
  b.artifact(auth42, { kind: 'document', provider: 'docs', title: 'Refresh token rotation strategy', externalId: 'ADR-21', url: 'https://docs.acme.dev/adr/021', state: 'published', by: agent(delta), created: 12 });
  b.artifact(auth42, { kind: 'test_report', provider: 'ci', title: 'Auth integration suite #1182', repo: rAuth, externalId: 'run-1182', state: 'failed', by: SYSTEM, created: 2 });
  b.criterionEvents(auth42, 'AUTH-42', [
    { daysAgo: 12, text: 'Existing sessions survive rotation', state: 'met', by: maya },
    { daysAgo: 8, text: 'Token replay is rejected', state: 'met', by: maya },
    { daysAgo: 4, text: 'Integration tests pass', state: 'in_progress', by: jonas },
  ]);
  b.comment({ type: 'workstream', id: auth42 }, auth42, user(tomas), 'Security: replay must revoke the whole token family, not just the replayed token.', 14);
  b.comment({ type: 'workstream', id: auth42 }, auth42, user(maya), 'Agreed, that is what #182 does. Adding it to the criteria.', 13);
  b.comment({ type: 'execution', id: a42e4 }, auth42, agent(claude), 'The web client needs to know the TTL to schedule silent refresh. Asked in the input request.', 1);

  // ═══════════════════════════ WEB-81 — in_review ═══════════════════════════
  const web81 = b.workstream({
    key: 'WEB-81', project: pCheckout, title: 'Checkout redesign', objective: 'A faster, accessible checkout that matches the new brand and keeps conversion tracking intact.',
    context: 'Checkout is the highest-drop-off flow. Design delivered v3 in Figma; engineering to ship behind the existing feature flag.',
    owner: WEB, participating: [PAY], accountable: ale, repos: [rWeb], priority: 'high', labels: ['checkout', 'design'],
    criteria: [['Matches the approved Figma spec', 'met'], ['Lighthouse accessibility score >= 95', 'in_progress'], ['Conversion analytics events keep parity', 'pending']],
    path: ['draft', 'planned', 'working', 'in_review'], target: 9, created: 18, createdBy: priya,
  });
  const w81e1 = b.execution(web81, { title: 'Implement checkout layout', team: WEB, repos: [rWeb], performers: [agent(cursor)], provider: 'cursor', state: 'in_review', branch: 'web-81/checkout-redesign', created: 14, notes: [[5, 'All steps implemented, PR #922 ready for review']] });
  b.execution(web81, { title: 'Accessibility audit', team: WEB, repos: [rWeb], performers: [user(priya)], provider: 'human', state: 'running', created: 6, notes: [[1, 'Fixed focus order on the payment step, 3 findings left']] });
  b.execution(web81, { title: 'Visual regression baseline', team: WEB, repos: [rWeb], performers: [agent(codex)], provider: 'codex', state: 'completed', created: 10, done: 7 });
  b.artifact(web81, { kind: 'pull_request', provider: 'github', title: 'Redesign checkout flow', execution: w81e1, repo: rWeb, externalId: '#922', url: 'https://github.com/acme/web/pull/922', state: 'open', ci: 'passing', review: 'requested', by: agent(cursor), created: 4, updated: 0.5 });
  b.artifact(web81, { kind: 'design', provider: 'figma', title: 'Checkout v3', url: 'https://figma.com/file/checkout-v3', state: 'published', by: user(elena), created: 17 });
  b.artifact(web81, { kind: 'build', provider: 'ci', title: 'Storybook build #4410', repo: rWeb, externalId: 'build-4410', state: 'succeeded', ci: 'passing', by: SYSTEM, created: 1 });
  b.criterionEvents(web81, 'WEB-81', [{ daysAgo: 9, text: 'Matches the approved Figma spec', state: 'met', by: priya }, { daysAgo: 2, text: 'Lighthouse accessibility score >= 95', state: 'in_progress', by: priya }]);
  b.comment({ type: 'workstream', id: web81 }, web81, user(elena), 'Spacing on the order summary still differs from the spec on mobile.', 3);
  b.comment({ type: 'workstream', id: web81 }, web81, user(priya), 'Fixed in the latest push, thanks.', 2);

  // ═══════════════════════════ INF-31 — blocked (CI failing) ═══════════════════════════
  const inf31 = b.workstream({
    key: 'INF-31', title: 'Distributed tracing', objective: 'Every public API request produces a trace that spans api, auth-service and payments.',
    context: 'Incident INC-8 took four hours to localise because we had no cross-service traces.',
    owner: INF, participating: [API, PLAT], accountable: ale, repos: [rInfra, rApi], priority: 'urgent', labels: ['observability'],
    criteria: [['Traces visible for 100% of public API requests', 'in_progress'], ['p99 overhead below 3 ms', 'pending'], ['Sampling configurable per service', 'pending']],
    path: ['draft', 'planned', 'working', 'blocked'], target: 4, created: 15, createdBy: tomas,
  });
  b.execution(inf31, { title: 'Provision OpenTelemetry collector', team: INF, repos: [rInfra], performers: [user(tomas)], provider: 'human', state: 'completed', created: 14, done: 10 });
  const i31e2 = b.execution(inf31, { title: 'Instrument API services with spans', team: API, repos: [rApi], performers: [agent(claude)], provider: 'claude_code', state: 'running', branch: 'inf-31/spans', session: 'https://claude.ai/code/session_inf31', created: 8, note: 'Spans for 14/22 routes. CI failing on collector config lint.', notes: [[4, 'Instrumented order and payment routes'], [1, 'CI failing on collector config lint']] });
  b.execution(inf31, { title: 'Export dashboards and alerts', team: INF, repos: [rInfra], performers: [agent(delta)], provider: 'delta', state: 'queued', deps: [i31e2], created: 3 });
  b.artifact(inf31, { kind: 'pull_request', provider: 'github', title: 'Add OTel collector deployment', repo: rInfra, externalId: '#318', url: 'https://github.com/acme/infra/pull/318', state: 'open', ci: 'failing', review: 'none', by: user(tomas), created: 7, updated: 1 });
  b.artifact(inf31, { kind: 'build', provider: 'ci', title: 'CI #8231 collector-lint', repo: rInfra, externalId: 'build-8231', state: 'failed', ci: 'failing', by: SYSTEM, created: 1 });
  b.artifact(inf31, { kind: 'pull_request', provider: 'github', title: 'Instrument order routes with spans', execution: i31e2, repo: rApi, externalId: '#1204', url: 'https://github.com/acme/api/pull/1204', state: 'draft', ci: 'pending', review: 'none', by: agent(claude), created: 4 });
  b.comment({ type: 'workstream', id: inf31 }, inf31, user(tomas), 'Collector lint fails because the exporter endpoint is templated in Helm. Fixing the values file.', 1);

  // ═══════════════════════════ AUTH-39 — shipped (deployment healthy) ═══════════════════════════
  const auth39 = b.workstream({
    key: 'AUTH-39', project: pAuth, title: 'Rotate JWT signing keys', objective: 'Signing keys rotate automatically every 90 days with zero downtime.',
    owner: AUTH, participating: [INF], accountable: maya, repos: [rAuth], priority: 'medium', labels: ['auth', 'security'],
    criteria: [['JWKS endpoint serves current and previous keys', 'met'], ['Rotation runs from a scheduled job', 'met'], ['Runbook published', 'met']],
    path: ['draft', 'planned', 'working', 'in_review', 'ready_to_land', 'shipped'], created: 28, shipped: 0.12, createdBy: maya,
  });
  const a39e1 = b.execution(auth39, { title: 'Implement key rotation job', team: AUTH, repos: [rAuth], performers: [agent(claude)], provider: 'claude_code', state: 'completed', created: 26, done: 14 });
  b.execution(auth39, { title: 'Write rotation runbook', team: AUTH, performers: [user(maya)], provider: 'human', state: 'completed', created: 20, done: 12 });
  b.artifact(auth39, { kind: 'pull_request', provider: 'github', title: 'Add scheduled JWT key rotation', execution: a39e1, repo: rAuth, externalId: '#171', url: 'https://github.com/acme/auth-service/pull/171', state: 'merged', ci: 'passing', review: 'approved', by: agent(claude), created: 16, updated: 6 });
  b.artifact(auth39, { kind: 'deployment', provider: 'delta', title: 'auth-service staging deploy', repo: rAuth, externalId: 'staging/auth-2026-10-07', state: 'healthy', env: 'staging', by: SYSTEM, created: 0.15, updated: 0.12 });
  b.artifact(auth39, { kind: 'release', provider: 'github', title: 'auth-service v2.14.0', repo: rAuth, externalId: 'v2.14.0', url: 'https://github.com/acme/auth-service/releases/tag/v2.14.0', state: 'published', by: user(maya), created: 0.1 });

  // ═══════════════════════════ INF-27 — shipped ═══════════════════════════
  const inf27 = b.workstream({
    key: 'INF-27', title: 'Migrate CI runners to ARM', objective: 'All CI pipelines run on ARM runners at 30% lower cost.',
    owner: INF, accountable: tomas, repos: [rInfra], priority: 'medium', labels: ['ci', 'cost'],
    criteria: [['All pipelines green on ARM', 'met'], ['Cost report shows >= 25% savings', 'met']],
    path: ['draft', 'planned', 'working', 'in_review', 'shipped'], created: 40, shipped: 20, createdBy: tomas,
  });
  b.execution(inf27, { title: 'Build ARM runner image', team: INF, repos: [rInfra], performers: [agent(delta)], provider: 'delta', state: 'completed', created: 38, done: 28 });
  b.execution(inf27, { title: 'Migrate pipelines', team: INF, repos: [rInfra], performers: [user(tomas)], provider: 'human', state: 'completed', created: 30, done: 21 });
  b.artifact(inf27, { kind: 'pull_request', provider: 'github', title: 'Switch CI to ARM runners', repo: rInfra, externalId: '#290', url: 'https://github.com/acme/infra/pull/290', state: 'merged', ci: 'passing', review: 'approved', by: user(tomas), created: 26, updated: 21 });
  b.artifact(inf27, { kind: 'deployment', provider: 'ci', title: 'Runner fleet rollout', repo: rInfra, externalId: 'production/runners-arm', state: 'healthy', env: 'production', by: SYSTEM, created: 21, updated: 20 });

  // ═══════════════════════════ PLAT-7 — Checkout rewrite (multi-team, working) ═══════════════════════════
  const plat7 = b.workstream({
    key: 'PLAT-7', project: pCheckout, title: 'Checkout rewrite', objective: 'Replace the legacy checkout with a server-driven flow owned jointly by Payments, Identity, Web and Infra.',
    context: 'The legacy checkout duplicates pricing logic in three places and cannot support 3DS2 or saved methods. One workstream coordinates all four teams.',
    owner: PLAT, participating: [PAY, AUTH, WEB, INF], accountable: maya, repos: [rApi, rWeb, rPay, rAuth], priority: 'urgent', labels: ['checkout', 'multi-team'],
    criteria: [['Server-side cart and pricing is the single source of truth', 'in_progress'], ['3DS2 challenge flow supported', 'in_progress'], ['Load test passes at 3x Black Friday traffic', 'pending'], ['Legacy checkout removed', 'pending']],
    path: ['draft', 'planned', 'working'], target: 20, created: 30, createdBy: ale,
  });
  const p7e2 = b.execution(plat7, { title: 'PAY: Payment intent API contract', team: PAY, repos: [rPay, rApi], performers: [user(jonas)], provider: 'human', state: 'completed', created: 28, done: 20 });
  const p7e1 = b.execution(plat7, { title: 'PAY: Payments implementation', team: PAY, repos: [rPay], performers: [agent(codex), team(PAY)], provider: 'codex', state: 'running', branch: 'plat-7/payment-intents', session: 'https://delta.dev/t/payments-impl-ab12', created: 25, notes: [[10, 'Payment intent service scaffolded'], [3, 'Idempotency done, 3DS challenge in progress']], note: 'Idempotency done, 3DS challenge in progress' });
  b.execution(plat7, { title: 'Idempotency key middleware', parent: p7e1, team: PAY, repos: [rPay], performers: [agent(codex)], provider: 'codex', state: 'completed', created: 18, done: 8 });
  b.execution(plat7, { title: '3DS challenge flow', parent: p7e1, team: PAY, repos: [rPay], performers: [agent(codex)], provider: 'codex', state: 'running', created: 8, notes: [[2, 'Challenge redirect works against the test PSP']] });
  b.execution(plat7, { title: 'AUTH: Authentication integration', team: AUTH, repos: [rAuth], performers: [agent(claude)], provider: 'claude_code', state: 'running', deps: [p7e2], created: 18, notes: [[5, 'Checkout sessions now carry the step-up claim']] });
  b.execution(plat7, { title: 'WEB: Checkout UI', team: WEB, repos: [rWeb], performers: [agent(cursor), user(priya)], provider: 'cursor', state: 'running', deps: [p7e2], created: 16, notes: [[4, 'Address and shipping steps wired to the new API']] });
  b.execution(plat7, { title: 'INF: Staging environment and load tests', team: INF, repos: [rInfra], performers: [user(tomas)], provider: 'human', state: 'queued', deps: [p7e2], created: 10 });
  b.dependency('workstream', inf27, 'workstream', plat7, plat7, 29);
  b.artifact(plat7, { kind: 'pull_request', provider: 'github', title: 'Payment intent service', execution: p7e1, repo: rPay, externalId: '#455', url: 'https://github.com/acme/payments/pull/455', state: 'draft', ci: 'pending', review: 'none', by: agent(codex), created: 12 });
  b.artifact(plat7, { kind: 'document', provider: 'docs', title: 'Checkout rewrite RFC', url: 'https://docs.acme.dev/rfc/checkout-rewrite', state: 'published', by: user(ale), created: 29 });
  b.comment({ type: 'workstream', id: plat7 }, plat7, user(ale), 'Weekly sync: Payments and Identity are on track, Infra load tests start once the intent API is deployed to staging.', 5);

  // ═══════════════════════════ PAY-22 — blocked (dependency on AUTH-42) ═══════════════════════════
  const pay22 = b.workstream({
    key: 'PAY-22', project: pCheckout, title: 'Saved payment methods migration', objective: 'Migrate stored cards to network tokens without re-entering details.',
    owner: PAY, participating: [AUTH], accountable: jonas, repos: [rPay], priority: 'high', labels: ['payments'],
    criteria: [['All stored cards migrated to network tokens', 'pending'], ['No customer re-authentication required', 'pending']],
    path: ['draft', 'planned', 'blocked'], created: 12, createdBy: jonas,
  });
  b.execution(pay22, { title: 'Migrate stored cards to network tokens', team: PAY, repos: [rPay], performers: [agent(codex)], provider: 'codex', state: 'queued', created: 10 });
  b.dependency('workstream', auth42, 'workstream', pay22, pay22, 11);
  b.comment({ type: 'workstream', id: pay22 }, pay22, user(jonas), 'Cannot start until AUTH-42 lands: token migration reuses the new rotation primitives.', 9);

  // ═══════════════════════════ SEC-9 — ready_to_land ═══════════════════════════
  const sec9 = b.workstream({
    key: 'SEC-9', title: 'Dependency vulnerability sweep', objective: 'No critical or high CVEs in production dependencies, with an enforced remediation SLA.',
    owner: SEC, participating: [API, WEB], accountable: tomas, repos: [rApi, rWeb], priority: 'high', labels: ['security', 'deps'],
    criteria: [['No critical CVEs in production dependencies', 'met'], ['Renovate policy documents the SLA', 'in_progress']],
    path: ['draft', 'planned', 'working', 'in_review', 'ready_to_land'], target: 3, created: 9, createdBy: tomas,
  });
  const s9e1 = b.execution(sec9, { title: 'Upgrade vulnerable transitive dependencies', team: SEC, repos: [rApi, rWeb], performers: [agent(codex)], provider: 'codex', state: 'in_review', branch: 'sec-9/deps', created: 8, notes: [[2, 'All criticals resolved, PRs approved']] });
  b.execution(sec9, { title: 'Write CVE triage policy', team: SEC, performers: [user(tomas)], provider: 'human', state: 'completed', created: 7, done: 4 });
  b.artifact(sec9, { kind: 'pull_request', provider: 'github', title: 'Bump vulnerable dependencies (api)', execution: s9e1, repo: rApi, externalId: '#901', url: 'https://github.com/acme/api/pull/901', state: 'open', ci: 'passing', review: 'approved', by: agent(codex), created: 4, updated: 0.3 });
  b.artifact(sec9, { kind: 'pull_request', provider: 'github', title: 'Bump vulnerable dependencies (web)', execution: s9e1, repo: rWeb, externalId: '#915', url: 'https://github.com/acme/web/pull/915', state: 'merged', ci: 'passing', review: 'approved', by: agent(codex), created: 4, updated: 1 });
  b.criterionEvents(sec9, 'SEC-9', [{ daysAgo: 1, text: 'No critical CVEs in production dependencies', state: 'met', by: tomas }]);

  // ═══════════════════════════ SEC-11 — needs_input (proposed decision) ═══════════════════════════
  const sec11 = b.workstream({
    key: 'SEC-11', title: 'Audit log retention policy', objective: 'Define and implement how long audit logs are kept, and where.',
    owner: SEC, participating: [PLAT], accountable: ale, repos: [rApi], priority: 'medium', labels: ['compliance'],
    criteria: [['Retention policy approved', 'in_progress'], ['Cold storage lifecycle configured', 'pending']],
    path: ['draft', 'planned', 'needs_input'], created: 7, createdBy: tomas,
  });
  b.execution(sec11, { title: 'Draft retention options', team: SEC, performers: [agent(claude)], provider: 'claude_code', state: 'completed', created: 6, done: 3, notes: [[3, 'Three options compared on cost and compliance coverage']] });
  b.execution(sec11, { title: 'Cost estimate for cold storage', team: INF, performers: [user(tomas)], provider: 'human', state: 'queued', created: 3 });

  // ═══════════════════════════ API-58 — working ═══════════════════════════
  const api58 = b.workstream({
    key: 'API-58', title: 'Rate limiting for the public API', objective: 'Protect the public API with per-key rate limits and clear 429 responses.',
    owner: API, participating: [SEC], accountable: jonas, repos: [rApi], priority: 'high', labels: ['api', 'reliability'],
    criteria: [['Per-key limits enforced at the gateway', 'in_progress'], ['429 responses include Retry-After', 'pending'], ['Limits documented', 'pending']],
    path: ['draft', 'planned', 'working'], target: 12, created: 10, createdBy: jonas,
  });
  const a58e1 = b.execution(api58, { title: 'Token bucket middleware', team: API, repos: [rApi], performers: [agent(claude)], provider: 'claude_code', state: 'running', branch: 'api-58/rate-limit', session: 'https://claude.ai/code/session_api58', created: 6, notes: [[2, 'Redis-backed bucket working, adding burst allowance']], note: 'Redis-backed bucket working, adding burst allowance' });
  b.execution(api58, { title: 'Load test limits', team: API, repos: [rApi], performers: [agent(delta)], provider: 'delta', state: 'queued', created: 4 });
  b.execution(api58, { title: 'Document limits for API consumers', team: API, performers: [user(jonas)], provider: 'human', state: 'queued', created: 4 });
  b.input(api58, { execution: a58e1, question: 'Should limits be per API key or per IP?', options: ['Per API key', 'Per IP', 'Both'], by: agent(claude), assignee: jonas, created: 6, answer: { text: 'Per API key, with a coarse per-IP backstop.', by: jonas, daysAgo: 5 } });

  // ═══════════════════════════ API-57 — blocked (merge conflict) ═══════════════════════════
  const api57 = b.workstream({
    key: 'API-57', title: 'Webhook retries with backoff', objective: 'Outgoing webhooks retry with exponential backoff and never deliver duplicates.',
    owner: API, accountable: jonas, repos: [rApi], priority: 'medium', labels: ['webhooks'],
    criteria: [['Retries use exponential backoff, max 8 attempts', 'met'], ['Deliveries are idempotent', 'in_progress']],
    path: ['draft', 'planned', 'working', 'in_review', 'blocked'], created: 14, createdBy: jonas,
  });
  const a57e1 = b.execution(api57, { title: 'Retry scheduler', team: API, repos: [rApi], performers: [agent(claude)], provider: 'claude_code', state: 'in_review', branch: 'api-57/retries', created: 12, notes: [[2, 'Rebased onto main twice; conflicts keep coming back from the queue refactor']] });
  b.artifact(api57, { kind: 'pull_request', provider: 'github', title: 'Webhook retries with exponential backoff', execution: a57e1, repo: rApi, externalId: '#889', url: 'https://github.com/acme/api/pull/889', state: 'open', ci: 'passing', review: 'changes_requested', conflicts: true, by: agent(claude), created: 6, updated: 1 });

  // ═══════════════════════════ WEB-77 — planned ═══════════════════════════
  const web77 = b.workstream({
    key: 'WEB-77', title: 'Design system tokens migration', objective: 'All components consume semantic design tokens so theming (light, dark, brand) is a config change.',
    owner: WEB, accountable: priya, repos: [rWeb], priority: 'medium', labels: ['design-system'],
    criteria: [['No hard-coded colors in components', 'pending'], ['Dark mode derived from tokens', 'pending'], ['Token docs published', 'pending']],
    path: ['draft', 'planned'], target: 30, created: 5, createdBy: priya,
  });
  b.execution(web77, { title: 'Inventory hard-coded colors', team: WEB, repos: [rWeb], performers: [agent(cursor)], provider: 'cursor', state: 'queued', created: 4 });
  b.execution(web77, { title: 'Codemod to semantic tokens', team: WEB, repos: [rWeb], performers: [agent(codex)], provider: 'codex', state: 'queued', created: 4 });

  // ═══════════════════════════ API-61 — draft ═══════════════════════════
  const api61 = b.workstream({
    key: 'API-61', title: 'GraphQL gateway spike', objective: 'Evaluate whether a GraphQL gateway in front of the public API is worth the operational cost.',
    owner: API, accountable: jonas, priority: 'low', labels: ['spike'], path: ['draft'], created: 3, createdBy: jonas,
  });

  // ═══════════════════════════ PAY-15 — canceled ═══════════════════════════
  const pay15 = b.workstream({
    key: 'PAY-15', title: 'Legacy invoice export', objective: 'Export historical invoices to CSV for finance.',
    context: 'Superseded by the billing platform migration; finance now uses the vendor export.',
    owner: PAY, accountable: jonas, repos: [rPay], priority: 'low', labels: ['finance'], path: ['draft', 'planned'], override: 'canceled', created: 35, createdBy: jonas,
  });
  b.execution(pay15, { title: 'Export CSV endpoint', team: PAY, repos: [rPay], performers: [agent(codex)], provider: 'codex', state: 'canceled', created: 33, done: 20 });

  // ───────── decisions (ADR-1 … ADR-23)
  const adr = (n: number, title: string, statement: string, rationale: string, tags: string[], o: { by?: typeof SYSTEM; decidedBy?: string; created: number; decided?: number; origin?: string; related?: string[]; status?: 'accepted' | 'rejected' | 'proposed' | 'superseded'; superseded?: string; originExecution?: string }) =>
    b.decision({ number: n, title, statement, rationale, status: o.status ?? 'accepted', origin: o.origin, originExecution: o.originExecution, related: o.related, by: o.by ?? user(maya), decidedBy: o.status === 'proposed' ? undefined : (o.decidedBy ?? maya), created: o.created, decided: o.status === 'proposed' ? undefined : (o.decided ?? o.created - 1), superseded: o.superseded, tags });
  adr(1, 'Use PostgreSQL 17 as the primary datastore', 'All services use PostgreSQL 17; no new datastores without an ADR.', 'One operational model, strong consistency, JSONB covers semi-structured needs.', ['data'], { created: 58, decidedBy: ale, by: user(ale) });
  adr(2, 'TypeScript strict mode across all services', 'Every service compiles with `strict: true`.', 'Catches a class of null bugs before runtime; agents write safer code with strict types.', ['typescript'], { created: 57, decidedBy: ale, by: user(ale) });
  adr(3, 'Trunk-based development with short-lived branches', 'Branches live less than three days and merge to main behind flags.', 'Reduces merge conflicts, which are costly with parallel agents.', ['process'], { created: 56, decidedBy: ale, by: user(ale) });
  (() => {
    const a4 = adr(4, 'Use JWT access tokens with 7-day expiry', 'Web sessions use a single JWT access token with a 7-day expiry.', 'Simple to implement and stateless.', ['auth'], { created: 55, related: [auth42], status: 'superseded' });
    const a11 = adr(11, 'Use rotating refresh tokens with short-lived access tokens', 'Access tokens live 15 minutes; a refresh token is rotated on every use.', 'Limits the blast radius of a leaked token while keeping sessions seamless.', ['auth'], { created: 40, related: [auth42], status: 'superseded' });
    const a21 = adr(21, 'Use rotating refresh tokens with a 30-day absolute TTL', 'Refresh tokens rotate on every use and expire 30 days after the session started, regardless of activity.', 'Avoid indefinite sessions while retaining seamless renewal.', ['auth', 'security'], { by: agent(delta), created: 13, decided: 12, origin: auth42, related: [auth42, pay22], originExecution: a42e1 });
    const rows = b.data.decisions;
    rows.find((d) => d.id === a4)!.supersededById = a11;
    rows.find((d) => d.id === a11)!.supersededById = a21;
    b.superseded(a4, 'ADR-11', 39, maya);
    b.superseded(a11, 'ADR-21', 12, maya);
    return a21;
  })();
  adr(5, 'Idempotency keys required on all payment mutations', 'Every payment-mutating endpoint requires an Idempotency-Key header.', 'Retries from clients and agents must never double-charge.', ['payments'], { created: 50, origin: plat7, related: [plat7], by: user(jonas), decidedBy: maya });
  adr(6, 'Feature flags via the env-backed flag service', 'Risky changes ship behind flags from the flag service, never from ad-hoc env checks.', 'Central audit trail, and flags can be flipped without a deploy.', ['process'], { created: 49, decidedBy: ale, by: user(ale) });
  adr(7, 'Structured JSON logging with trace ids', 'All services log JSON lines including trace and span ids.', 'Required to correlate logs with traces.', ['observability'], { created: 47, related: [inf31], by: user(tomas), decidedBy: maya });
  adr(8, 'Angular for the web client', 'The web client is built with Angular and Tailwind.', 'Strong conventions suit a large team and agent-written code.', ['web'], { created: 46, decidedBy: ale, by: user(priya) });
  adr(9, 'Rate limiting at the gateway, not in services', 'Per-key rate limits are enforced by the API gateway layer.', 'One implementation, consistent responses, services stay simple.', ['api'], { created: 30, origin: api58, related: [api58], by: user(jonas), decidedBy: maya });
  adr(10, 'Event-sourced audit log', 'Security-relevant actions append to an immutable event log.', 'Tamper-evident history and replay for investigations.', ['security'], { created: 44, related: [sec11], by: user(tomas), decidedBy: maya });
  adr(12, 'Use OpenTelemetry for distributed tracing', 'Services export traces via OpenTelemetry to a central collector.', 'Vendor-neutral and supported by every runtime we use.', ['observability'], { created: 14, origin: inf31, related: [inf31], by: agent(delta), decidedBy: tomas });
  adr(13, 'Run CI on ARM runners', 'All CI pipelines run on ARM runners by default.', '30% cost reduction with no test regressions.', ['ci'], { created: 35, origin: inf27, related: [inf27], by: user(tomas), decidedBy: maya });
  adr(14, 'Store money as integer minor units', 'All monetary values are integers in the smallest currency unit plus an ISO currency code.', 'Avoids floating point rounding errors.', ['payments'], { created: 45, related: [plat7, pay22], by: user(jonas), decidedBy: maya });
  adr(15, 'Webhook retries use exponential backoff, max 8 attempts', 'Failed deliveries retry with exponential backoff and jitter up to 8 attempts, then go to a dead-letter queue.', 'Protects customer endpoints and our queue.', ['api', 'webhooks'], { created: 12, origin: api57, related: [api57], by: agent(claude), decidedBy: jonas });
  adr(16, 'Design tokens are the source of truth for theming', 'Components consume semantic tokens only; raw colors are forbidden.', 'Enables light/dark/brand themes without component changes.', ['design-system'], { created: 5, origin: web77, related: [web77, web81], by: user(priya), decidedBy: ale });
  adr(17, 'Do not adopt GraphQL for the public API', 'The public API stays REST + OpenAPI.', 'Operational cost and caching complexity outweigh the benefits for our consumers.', ['api'], { created: 20, status: 'rejected', related: [api61], by: user(jonas), decidedBy: maya });
  adr(18, 'Signing keys rotate every 90 days', 'JWT signing keys rotate every 90 days; the JWKS publishes the current and previous key.', 'Limits exposure of any single key.', ['auth', 'security'], { created: 25, origin: auth39, related: [auth39], by: user(maya), decidedBy: tomas });
  adr(19, 'Checkout state lives server-side', 'Cart, pricing and checkout step state are owned by the server; the client renders only.', 'Single source of truth for pricing and 3DS flows.', ['checkout'], { created: 28, origin: plat7, related: [plat7, web81], by: user(ale), decidedBy: maya });
  adr(20, 'Security findings are triaged within two business days', 'Every incoming security finding gets an owner and severity within two business days.', 'Predictable remediation SLAs.', ['security', 'process'], { created: 22, related: [sec9], by: user(tomas), decidedBy: ale });
  adr(22, 'Audit log retention: 400 days hot, 7 years cold', 'Keep audit logs queryable for 400 days, then archive to cold storage for 7 years.', 'Covers SOC 2 and the longest regulatory retention requirement we know of.', ['compliance', 'security'], { by: agent(claude), created: 3, origin: sec11, related: [sec11], status: 'proposed' });
  adr(23, 'Hash refresh tokens at rest with HMAC-SHA256', 'Refresh tokens are stored as HMAC-SHA256 digests keyed with a server secret, never in plaintext.', 'A database leak must not expose usable refresh tokens.', ['auth', 'security'], { by: agent(claude), created: 2, origin: auth42, related: [auth42], status: 'proposed' });

  // ───────── milestones (of the projects)
  b.syncProjectRepos();
  const ms42Replay = b.milestone(pAuth, { name: 'Replay detection', description: 'Shared replay detection across both refresh paths.', target: -2, sort: 0, created: 20 });
  const ms42Rollout = b.milestone(pAuth, { name: 'Rollout and metrics', description: 'Gradual rollout with rotation metrics in place.', target: 6, sort: 1, created: 20 });

  // ───────── issues
  const bug142 = b.issue({ kind: 'bug', number: 142, title: 'Users occasionally get redirected back to login', body: 'Several customers report being logged out after a few hours of normal use, with no error shown.', source: 'email', reporterName: 'Customer: Northwind', team: AUTH, priority: 'high', status: 'in_progress', workstreams: [auth42], milestones: [ms42Replay], estimate: 5, created: 24, moved: 21, movedBy: maya });
  b.issue({ kind: 'bug', number: 139, title: 'Session lost after Safari ITP cookie expiry', source: 'api', reporterName: 'Support: Zendesk #4412', team: AUTH, priority: 'medium', status: 'in_progress', workstreams: [auth42], milestones: [ms42Replay], estimate: 3, created: 27, moved: 21, movedBy: maya });
  b.issue({ kind: 'bug', number: 145, title: 'Refresh endpoint returns 500 under load', body: 'Seen during the load test on staging: bursts of 500s from /auth/refresh.', source: 'agent', team: AUTH, priority: 'high', status: 'in_progress', workstreams: [auth42], milestones: [ms42Rollout], estimate: 8, created: 8, moved: 7, movedBy: maya });
  b.issue({ kind: 'bug', number: 150, title: 'Checkout button misaligned on Safari 17', source: 'github', team: WEB, priority: 'medium', status: 'in_progress', workstreams: [web81], created: 16, moved: 15, movedBy: priya, url: 'https://github.com/acme/web/issues/1150' });
  b.issue({ kind: 'bug', number: 151, title: 'Coupon field loses focus on mobile', source: 'github', team: WEB, priority: 'low', status: 'backlog', created: 1, url: 'https://github.com/acme/web/issues/1161' });
  b.issue({ kind: 'bug', number: 148, title: 'Webhook retries sometimes deliver duplicate events', source: 'email', reporterName: 'Customer: Globex', team: API, priority: 'high', status: 'in_progress', workstreams: [api57], created: 15, moved: 14, movedBy: jonas });
  b.issue({ kind: 'feature', number: 31, title: 'Dark mode for checkout', source: 'manual', reporter: elena, team: WEB, priority: 'low', status: 'in_progress', workstreams: [web81], created: 17, moved: 16, movedBy: priya });
  b.issue({ kind: 'feature', number: 34, title: 'Bulk export of audit logs', source: 'email', reporterName: 'Customer: Initech', team: SEC, priority: 'medium', status: 'backlog', created: 2 });
  b.issue({ kind: 'incident', number: 8, title: 'Elevated 5xx on /v2/orders', body: 'p99 latency tripled for 40 minutes. Root cause unclear without cross-service traces.', source: 'api', team: INF, priority: 'urgent', status: 'in_progress', workstreams: [inf31], created: 16, moved: 15, movedBy: tomas });
  b.issue({ kind: 'incident', number: 9, title: 'Payment webhooks delayed by ~20 minutes', source: 'api', team: PAY, priority: 'high', status: 'backlog', created: 0.3 });
  b.issue({ kind: 'tech_debt', number: 12, title: 'Remove deprecated v1 sessions table', source: 'manual', reporter: maya, team: AUTH, priority: 'low', status: 'todo', created: 12, moved: 10, movedBy: maya });
  b.issue({ kind: 'tech_debt', number: 14, title: 'Replace moment with date-fns in web', source: 'manual', reporter: priya, team: WEB, priority: 'low', status: 'backlog', created: 4 });
  const fb20 = b.issue({ kind: 'feedback', number: 20, title: 'Customer asks for SSO with Okta', source: 'email', reporterName: 'Customer: Globex', team: AUTH, priority: 'medium', status: 'backlog', created: 6 });
  b.issue({ kind: 'feedback', number: 23, title: 'SAML SSO support', source: 'email', reporterName: 'Customer: Hooli', team: AUTH, priority: 'medium', status: 'canceled', duplicateOf: fb20, created: 5, moved: 4, movedBy: maya });
  b.issue({ kind: 'idea', number: 5, title: 'Agent-written changelog per workstream', source: 'manual', reporter: ale, team: PLAT, priority: 'none', status: 'backlog', created: 2 });
  b.issue({ kind: 'idea', number: 4, title: 'Public status page', source: 'manual', reporter: tomas, team: INF, priority: 'low', status: 'canceled', created: 30, moved: 28, movedBy: ale });
  b.issue({ kind: 'security', number: 6, title: 'Outdated lodash in api (CVE-2026-1182)', source: 'github', team: SEC, priority: 'high', status: 'in_review', workstreams: [sec9], created: 9, moved: 9, movedBy: tomas });
  b.issue({ kind: 'security', number: 7, title: 'No rate limit on password reset endpoint', source: 'agent', team: SEC, priority: 'high', status: 'done', workstreams: [api58], created: 10, moved: 9, movedBy: tomas });
  b.comment({ type: 'issue', id: bug142 }, null, user(maya), 'Linking this and BUG-139 to AUTH-42; same root cause (non-deterministic refresh).', 21);

  // ───────── decision comments
  b.comment({ type: 'decision', id: b.data.decisions.find((d) => d.number === 23)!.id! }, auth42, user(tomas), 'Good idea. Please also specify the key rotation story for the HMAC secret.', 1);
  b.comment({ type: 'artifact', id: b.data.artifacts.find((a) => a.externalId === '#889')!.id! }, api57, user(jonas), 'Please rebase on the queue refactor before the next review round.', 1);

  // ───────── saved views
  b.view(ale, 'Blocked work', 'workstream', { filters: [{ field: 'status', op: 'is', value: 'blocked' }], groupBy: 'ownerTeamId', layout: 'board', shared: true, created: 30 });
  b.view(ale, 'My active workstreams', 'workstream', { filters: [{ field: 'accountableUserId', op: 'is', value: ale }, { field: 'status', op: 'not_in', value: ['shipped', 'canceled'] }], sort: { field: 'priority', direction: 'asc' }, layout: 'list', shared: false, created: 25 });
  b.view(maya, 'Needs a decision', 'decision', { filters: [{ field: 'status', op: 'is', value: 'proposed' }], layout: 'list', shared: true, created: 20 });
  b.view(maya, 'Backlog issues', 'issue', { filters: [{ field: 'status', op: 'is', value: 'backlog' }], sort: { field: 'createdAt', direction: 'desc' }, layout: 'list', shared: true, created: 18 });
  b.view(ale, 'Agents at work', 'execution', { filters: [{ field: 'state', op: 'in', value: ['running', 'needs_input'] }, { field: 'provider', op: 'not_in', value: ['human'] }], groupBy: 'provider', layout: 'board', shared: false, created: 10 });

  // ───────── ~12 weeks of finished/running/canceled issues with estimates (statistics → Estimates & time)
  if (opts.mockHistory !== false) addMockHistoryToSeed(b.data, now);

  return b.data;
}
