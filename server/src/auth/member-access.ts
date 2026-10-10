import { AsyncLocalStorage } from 'node:async_hooks';
import { ForbiddenException } from '@nestjs/common';
import type { ApiResource } from '../contracts/domain.js';
import type { MemberAccess, MemberAction, MemberGrant, MemberResource } from '../contracts/domain.js';

/** Set for the duration of a request. `null` means the caller's role is not narrowed. */
export const memberAccessStore = new AsyncLocalStorage<MemberAccess | null>();

export function currentAccess(): MemberAccess | null {
  return memberAccessStore.getStore() ?? null;
}

const API_TO_MEMBER: Partial<Record<ApiResource | string, MemberResource>> = {
  projects: 'projects',
  milestones: 'milestones',
  workstreams: 'workstreams',
  issues: 'issues',
  documents: 'documents',
  artifacts: 'artifacts',
  views: 'views',
  comments: 'comments',
  decisions: 'decisions',
  dependencies: 'dependencies',
  'input-requests': 'input-requests',
  customers: 'customers',
  'customer-intake': 'customers',
  'customer-requests': 'customers',
};

/** `POST …/<verb>` that changes something which already exists, rather than creating a row of that resource. */
const POST_UPDATE = new Set([
  'bulk', 'bulk-delete', 'accept', 'reject', 'supersede', 'cancel', 'archive', 'restore', 'reorder',
  'link', 'unlink', 'refresh', 'attach', 'detach', 'publish', 'criteria', 'merge', 'external-ref', 'read',
]);

function actionFor(method: string, routePath: string, nestedIsOwnResource: boolean): MemberAction {
  const verb = method.toUpperCase();
  if (verb === 'GET' || verb === 'HEAD' || verb === 'OPTIONS') return 'view';
  if (verb === 'DELETE') return 'delete';
  if (verb === 'PUT' || verb === 'PATCH') return 'update';
  const rest = routePath.replace(/^.*\/w\/:slug/, '');
  const last = rest.split('/').filter(Boolean).pop() ?? '';
  if (last === 'bulk-delete') return 'delete';
  if (last.startsWith(':') || POST_UPDATE.has(last)) return 'update';
  // `POST /projects/:id/updates` creates a child that is not its own resource: it edits the project.
  if (!nestedIsOwnResource && /\/:[^/]+\//.test(rest)) return 'update';
  return 'create';
}

/**
 * The member grant a workspace route needs, or null when the route is not work this table covers
 * (members, teams, tokens, settings, search, snapshot). Those stay gated only by the role.
 * Create and edit are separate: `POST /issues` is `issues:create`, `PATCH /issues/:id` is `issues:update`.
 */
export function requiredMemberGrant(method: string, routePath: string): MemberGrant | null {
  const match = /\/w\/:slug(?:\/([^/]+))?(.*)$/.exec(routePath);
  if (!match?.[1]) return null;
  const nested = /^\/:[^/]+\/([^/]+)/.exec(match[2] ?? '')?.[1];
  const nestedResource = nested ? API_TO_MEMBER[nested] : undefined;
  const resource = nestedResource ?? API_TO_MEMBER[match[1]];
  if (!resource) return null;
  return `${resource}:${actionFor(method, routePath, !!nestedResource)}`;
}

export function projectHidden(access: MemberAccess | null | undefined, projectId: string | null | undefined): boolean {
  if (!access || access.projects.all) return false;
  if (projectId == null || projectId === '') return !access.includeUnassigned;
  return !access.projects.projectIds.includes(projectId);
}

/** 403 when this request's project is outside the caller's access. No-op when access is not narrowed. */
export function assertCanUseProject(projectId: string | null | undefined): void {
  if (projectHidden(currentAccess(), projectId)) throw new ForbiddenException('Outside the projects you can access');
}

interface Where {
  andWhere(sql: string, params?: Record<string, unknown>): unknown;
}

/** Adds a project filter to a list query. `column` is `id` for projects and `projectId` everywhere else. */
export function applyProjectScope(qb: Where, alias: string, column: string): void {
  const access = currentAccess();
  if (!access || access.projects.all) return;
  const col = `${alias}.${column}`;
  const ids = access.projects.projectIds;
  if (!ids.length) {
    qb.andWhere(access.includeUnassigned ? `${col} IS NULL` : '1 = 0');
    return;
  }
  const params = { memberProjectIds: ids };
  qb.andWhere(
    access.includeUnassigned ? `(${col} IN (:...memberProjectIds) OR ${col} IS NULL)` : `${col} IN (:...memberProjectIds)`,
    params,
  );
}

/**
 * Hides rows whose workstream belongs to a project the caller cannot see.
 * A null workstream id stays only when unassigned work is included.
 */
export function applyWorkstreamScope(qb: Where, alias: string, workstreamColumn: string): void {
  const access = currentAccess();
  if (!access || access.projects.all) return;
  const col = `${alias}.${workstreamColumn}`;
  const ids = access.projects.projectIds;
  const projectTest = ids.length
    ? `(ws_scope."projectId" IN (:...memberProjectIds) OR (ws_scope."projectId" IS NULL AND :memberUnassigned = true))`
    : `(ws_scope."projectId" IS NULL AND :memberUnassigned = true)`;
  qb.andWhere(
    `(
      (${col} IS NULL AND :memberUnassigned = true)
      OR EXISTS (
        SELECT 1 FROM "workstreams" ws_scope
        WHERE ws_scope."id" = ${col} AND ws_scope."workspaceId" = ${alias}."workspaceId" AND ${projectTest}
      )
    )`,
    { memberProjectIds: ids.length ? ids : ['__none__'], memberUnassigned: access.includeUnassigned },
  );
}

export function canView(resource: MemberResource, access: MemberAccess | null = currentAccess()): boolean {
  return !access || access.grants.includes(`${resource}:view`);
}

function allows(access: MemberAccess | null, resource: MemberResource): boolean {
  return canView(resource, access);
}

interface Ref {
  type: string;
  id: string;
}

export interface AccessSnapshot {
  projects: { id: string }[];
  workstreams: { id: string; projectId?: string | null }[];
  milestones: { id: string; projectId: string }[];
  issues: { id: string; projectId?: string | null }[];
  artifacts: { id: string; projectId?: string | null; workstreamId?: string | null; issueId?: string | null }[];
  decisions: { id: string; originWorkstreamId?: string | null }[];
  inputRequests: { id: string; workstreamId: string }[];
  dependencies: { fromType: string; fromId: string; toType: string; toId: string }[];
  comments: { subject: Ref }[];
  commentIndex?: { subject: Ref }[];
  customers: unknown[];
  customerRequests: { id: string; projectId?: string | null; issueId?: string | null }[];
  events: { subject: Ref; workstreamId?: string | null }[];
  attention: { workstreamId?: string; issueId?: string; artifactId?: string; decisionId?: string; inputRequestId?: string }[];
  views: unknown[];
}

/** Drops everything the caller's access cannot view. `null` access returns the snapshot unchanged. */
export function scopeSnapshot<T extends AccessSnapshot>(snapshot: T, access: MemberAccess | null): T {
  if (!access) return snapshot;
  const projectOk = (projectId: string | null | undefined) => !projectHidden(access, projectId);
  const projects = allows(access, 'projects') ? snapshot.projects.filter((row) => projectOk(row.id)) : [];
  const workstreams = allows(access, 'workstreams')
    ? snapshot.workstreams.filter((row) => projectOk(row.projectId))
    : [];
  const issues = allows(access, 'issues') ? snapshot.issues.filter((row) => projectOk(row.projectId)) : [];
  const milestones = allows(access, 'milestones') ? snapshot.milestones.filter((row) => projectOk(row.projectId)) : [];
  const workstreamIds = new Set(workstreams.map((row) => row.id));
  const issueIds = new Set(issues.map((row) => row.id));
  const projectIds = new Set(projects.map((row) => row.id));
  const milestoneIds = new Set(milestones.map((row) => row.id));
  const artifacts = allows(access, 'artifacts')
    ? snapshot.artifacts.filter((row) => {
        if (row.projectId && !projectOk(row.projectId)) return false;
        if (row.workstreamId && !workstreamIds.has(row.workstreamId)) return false;
        if (row.issueId && !issueIds.has(row.issueId)) return false;
        if (!row.projectId && !row.workstreamId && !row.issueId) return access.includeUnassigned;
        return true;
      })
    : [];
  const decisions = allows(access, 'decisions')
    ? snapshot.decisions.filter((row) => !row.originWorkstreamId || workstreamIds.has(row.originWorkstreamId))
    : [];
  const inputRequests = allows(access, 'input-requests')
    ? snapshot.inputRequests.filter((row) => workstreamIds.has(row.workstreamId))
    : [];
  const artifactIds = new Set(artifacts.map((row) => row.id));
  const decisionIds = new Set(decisions.map((row) => row.id));
  const inputIds = new Set(inputRequests.map((row) => row.id));
  const visible = new Map<string, Set<string>>([
    ['project', projectIds],
    ['workstream', workstreamIds],
    ['issue', issueIds],
    ['milestone', milestoneIds],
    ['artifact', artifactIds],
    ['decision', decisionIds],
    ['input_request', inputIds],
  ]);
  const refOk = (ref: Ref) => {
    const set = visible.get(ref.type);
    return set ? set.has(ref.id) : true;
  };
  const customersOk = allows(access, 'customers');
  const customerRequests = customersOk
    ? snapshot.customerRequests.filter((row) => {
        if (row.projectId && !projectOk(row.projectId)) return false;
        if (row.issueId && !issueIds.has(row.issueId)) return false;
        return true;
      })
    : [];
  const requestIds = new Set(customerRequests.map((row) => row.id));
  visible.set('customer_request', requestIds);
  const commentsOk = allows(access, 'comments');
  return {
    ...snapshot,
    projects,
    workstreams,
    issues,
    milestones,
    artifacts,
    decisions,
    inputRequests,
    customers: customersOk ? snapshot.customers : [],
    customerRequests,
    dependencies: allows(access, 'dependencies')
      ? snapshot.dependencies.filter((row) => refOk({ type: row.fromType, id: row.fromId }) && refOk({ type: row.toType, id: row.toId }))
      : [],
    comments: commentsOk ? snapshot.comments.filter((row) => refOk(row.subject)) : [],
    ...(snapshot.commentIndex ? { commentIndex: commentsOk ? snapshot.commentIndex.filter((row) => refOk(row.subject)) : [] } : {}),
    views: allows(access, 'views') ? snapshot.views : [],
    events: snapshot.events.filter((row) => refOk(row.subject)),
    attention: snapshot.attention.filter((row) => {
      if (row.workstreamId && !workstreamIds.has(row.workstreamId)) return false;
      if (row.issueId && !issueIds.has(row.issueId)) return false;
      if (row.artifactId && !artifactIds.has(row.artifactId)) return false;
      if (row.decisionId && !decisionIds.has(row.decisionId)) return false;
      if (row.inputRequestId && !inputIds.has(row.inputRequestId)) return false;
      return true;
    }),
  };
}
