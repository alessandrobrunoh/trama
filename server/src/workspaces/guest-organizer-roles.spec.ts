import { describe, expect, it } from 'vitest';
import {
  accessesShareProject,
  applyTokenScope,
  effectiveMemberAccess,
  findWorkspaceRole,
  freshWorkspaceRoles,
  GUEST_ROLE_ID,
  normalizeWorkspaceRoles,
  ORGANIZER_ROLE_ID,
  roleAllows,
  roleHasAdminPower,
  type MemberAccess,
} from '../contracts/domain.js';
import { visibleMemberships } from './people-scope.js';

const roles = freshWorkspaceRoles();
const organizer = findWorkspaceRole(roles, ORGANIZER_ROLE_ID)!;
const guest = findWorkspaceRole(roles, GUEST_ROLE_ID)!;

const onProjects = (...projectIds: string[]): MemberAccess => ({
  projects: { all: false, projectIds },
  includeUnassigned: false,
  grants: [],
});

describe('organizer and guest default roles', () => {
  it('seeds both next to the old ranks', () => {
    expect(roles.map((role) => role.id)).toEqual(['owner', 'admin', 'member', 'viewer', 'organizer', 'guest']);
  });

  it('organizer runs projects and tasks but administers nothing', () => {
    expect(organizer.capabilities).toEqual(
      expect.arrayContaining(['manageProjects', 'createIssues', 'deleteIssues', 'inviteToProject']),
    );
    for (const cap of ['inviteMembers', 'manageIntegrations', 'manageAgents', 'manageTokens'] as const)
      expect(organizer.capabilities).not.toContain(cap);
    expect(roleHasAdminPower(organizer)).toBe(false);
    expect(roleAllows(organizer, { min: 'admin', neededGrant: null }, null)).toBe(false);
    expect(roleAllows(organizer, { capability: 'manageIntegrations', min: 'member', neededGrant: null }, null)).toBe(false);
    expect(roleAllows(organizer, { capability: 'inviteToProject', min: 'member', neededGrant: null }, null)).toBe(true);
  });

  it('who may share a project is a capability: owner, admin and organizer, not member or viewer', () => {
    const has = (id: string) => findWorkspaceRole(roles, id)!.capabilities.includes('inviteToProject');
    expect([has('owner'), has('admin'), has('organizer')]).toEqual([true, true, true]);
    expect([has('member'), has('viewer'), has('guest')]).toEqual([false, false, false]);
    // a write token never shares a project
    expect(applyTokenScope(organizer, 'write').capabilities).not.toContain('inviteToProject');
  });

  it('guest creates and updates tasks and comments, reads the rest, and manages nothing', () => {
    expect(guest.capabilities).toEqual(['createIssues']);
    expect(guest.grants).toEqual(
      expect.arrayContaining(['issues:view', 'issues:create', 'issues:update', 'comments:create', 'comments:update']),
    );
    for (const grant of ['issues:delete', 'projects:create', 'projects:update', 'milestones:update', 'comments:delete'] as const)
      expect(guest.grants).not.toContain(grant);
    expect(roleAllows(guest, { capability: 'manageProjects', min: 'member', neededGrant: null }, null)).toBe(false);
    expect(roleHasAdminPower(guest)).toBe(false);
  });

  it('a guest without a project list sees no project at all', () => {
    const none = effectiveMemberAccess(guest, null);
    expect(none?.projects).toEqual({ all: false, projectIds: [] });
    expect(none?.includeUnassigned).toBe(false);
    const allProjects = effectiveMemberAccess(guest, { projects: { all: true, projectIds: [] }, includeUnassigned: true, grants: [] });
    expect(allProjects?.projects.all).toBe(false);
    const listed = effectiveMemberAccess(guest, onProjects('pj_a'));
    expect(listed?.projects).toEqual({ all: false, projectIds: ['pj_a'] });
    expect(listed?.includeUnassigned).toBe(false);
    expect(listed?.grants).toEqual(guest.grants);
  });

  it('a stored roles list keeps working without them: the migration adds them, normalizing does not', () => {
    const stored = normalizeWorkspaceRoles(roles.filter((role) => role.id !== GUEST_ROLE_ID && role.id !== ORGANIZER_ROLE_ID));
    expect(stored.map((role) => role.id)).toEqual(['owner', 'admin', 'member', 'viewer']);
  });
});

describe('people a project-limited person can see', () => {
  const memberships = [
    { userId: 'owner', role: 'owner', access: null },
    { userId: 'member', role: 'member', access: null },
    { userId: 'limited-a', role: 'member', access: onProjects('pj_a', 'pj_c') },
    { userId: 'guest-a', role: 'guest', access: onProjects('pj_a') },
    { userId: 'guest-b', role: 'guest', access: onProjects('pj_b') },
    { userId: 'guest-none', role: 'guest', access: null },
  ];

  it('shows everybody to someone who sees every project', () => {
    expect(visibleMemberships(memberships, roles, null, 'member')).toHaveLength(memberships.length);
  });

  it('shows a guest only themselves and the people on their projects', () => {
    const seen = visibleMemberships(memberships, roles, effectiveMemberAccess(guest, onProjects('pj_a')), 'guest-a');
    expect(seen.map((row) => row.userId)).toEqual(['owner', 'member', 'limited-a', 'guest-a']);
  });

  it('does not tell a guest which other projects someone is on', () => {
    const seen = visibleMemberships(memberships, roles, effectiveMemberAccess(guest, onProjects('pj_a')), 'guest-a');
    expect(seen.find((row) => row.userId === 'limited-a')?.access?.projects.projectIds).toEqual(['pj_a']);
  });

  it('two lists share a project only when they overlap, and everybody shares with someone on every project', () => {
    expect(accessesShareProject(onProjects('pj_a'), onProjects('pj_b'))).toBe(false);
    expect(accessesShareProject(onProjects('pj_a'), onProjects('pj_a', 'pj_b'))).toBe(true);
    expect(accessesShareProject(onProjects('pj_a'), null)).toBe(true);
  });
});
