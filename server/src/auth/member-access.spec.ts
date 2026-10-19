import { describe, expect, it } from 'vitest';
import {
  accessWithin,
  effectiveMemberAccess,
  normalizeMemberAccess,
  roleGrants,
} from '../contracts/domain.js';
import {
  projectHidden,
  requiredMemberGrant,
  scopeSnapshot,
  type AccessSnapshot,
} from './member-access.js';

describe('requiredMemberGrant', () => {
  it('splits creating an issue from editing one', () => {
    expect(requiredMemberGrant('POST', '/api/w/:slug/issues')).toBe(
      'issues:create',
    );
    expect(requiredMemberGrant('PATCH', '/api/w/:slug/issues/:idOrKey')).toBe(
      'issues:update',
    );
    expect(requiredMemberGrant('DELETE', '/api/w/:slug/issues/:idOrKey')).toBe(
      'issues:delete',
    );
    expect(requiredMemberGrant('GET', '/api/w/:slug/issues')).toBe(
      'issues:view',
    );
    expect(requiredMemberGrant('POST', '/api/w/:slug/issues/bulk')).toBe(
      'issues:update',
    );
    expect(
      requiredMemberGrant('POST', '/api/w/:slug/issues/:idOrKey/comments'),
    ).toBe('comments:create');
    expect(
      requiredMemberGrant(
        'POST',
        '/api/w/:slug/issues/:idOrKey/artifacts/upload',
      ),
    ).toBe('artifacts:create');
    expect(
      requiredMemberGrant('POST', '/api/w/:slug/projects/:id/artifacts/upload'),
    ).toBe('artifacts:create');
    expect(requiredMemberGrant('GET', '/api/w/:slug/uploads/:id')).toBeNull();
  });

  it('leaves workspace administration to the role', () => {
    expect(requiredMemberGrant('POST', '/api/w/:slug/members')).toBeNull();
    expect(requiredMemberGrant('GET', '/api/w/:slug/snapshot')).toBeNull();
    expect(requiredMemberGrant('PATCH', '/api/w/:slug/settings')).toBeNull();
  });
});

describe('normalizeMemberAccess', () => {
  const member = roleGrants('member');
  const viewer = roleGrants('viewer');

  it('stores no extras and every project as nothing on top of the role', () => {
    expect(
      normalizeMemberAccess(
        { projects: { all: true }, grants: member },
        member,
      ),
    ).toBeNull();
    expect(normalizeMemberAccess(null, member)).toBeNull();
  });

  it('keeps an action the role does not have, and implies view when the role lacks it', () => {
    const access = normalizeMemberAccess(
      { projects: { all: true }, grants: ['issues:create'] },
      viewer,
    );
    expect(access?.grants).toEqual(['issues:create']);
    const fromScratch = normalizeMemberAccess(
      { grants: ['issues:create'] },
      [],
    );
    expect(fromScratch?.grants).toContain('issues:create');
    expect(fromScratch?.grants).toContain('issues:view');
    expect(fromScratch?.grants).not.toContain('issues:update');
  });

  it('drops an extra the role already includes', () => {
    const access = normalizeMemberAccess(
      { grants: ['issues:view', 'issues:create'] },
      viewer,
    );
    expect(access?.grants).toEqual(['issues:create']);
  });

  it('refuses to hand out a role or projects the caller does not have', () => {
    const stored = normalizeMemberAccess(
      {
        projects: { all: false, projectIds: ['pj_1'] },
        includeUnassigned: false,
        grants: ['issues:create'],
      },
      viewer,
    )!;
    const caller = effectiveMemberAccess(
      { owner: false, grants: viewer },
      stored,
    )!;
    expect(accessWithin(null, caller, viewer)).toBe(false);
    expect(accessWithin(stored, caller, viewer)).toBe(true);
    expect(
      normalizeMemberAccess({ projects: { all: true }, grants: [] }, viewer),
    ).toBeNull();
    expect(accessWithin(null, caller, member)).toBe(false);
  });
});

describe('effectiveMemberAccess', () => {
  const member = { owner: false, grants: roleGrants('member') };
  const viewerRole = { owner: false, grants: roleGrants('viewer') };

  it('is unlimited for owners and for a member with the full default role', () => {
    expect(
      effectiveMemberAccess({ owner: true, grants: roleGrants('owner') }, null),
    ).toBeNull();
    expect(effectiveMemberAccess(member, null)).toBeNull();
  });

  it('adds an extra on top of a viewer, who otherwise only views', () => {
    const access = effectiveMemberAccess(viewerRole, {
      projects: { all: true, projectIds: [] },
      includeUnassigned: true,
      grants: ['issues:create', 'issues:view'],
    });
    expect(access?.grants).toContain('issues:view');
    expect(access?.grants).toContain('issues:create');
    expect(access?.grants).not.toContain('issues:update');
  });
});

describe('project scope', () => {
  const limited = normalizeMemberAccess(
    {
      projects: { all: false, projectIds: ['pj_1'] },
      includeUnassigned: false,
      grants: ['issues:view'],
    },
    roleGrants('viewer'),
  )!;

  it('hides other projects and unassigned work', () => {
    expect(projectHidden(limited, 'pj_1')).toBe(false);
    expect(projectHidden(limited, 'pj_2')).toBe(true);
    expect(projectHidden(limited, null)).toBe(true);
    expect(projectHidden(null, 'pj_2')).toBe(false);
  });

  it('removes hidden projects and directly assigned issues from a snapshot', () => {
    const snapshot: AccessSnapshot = {
      projects: [{ id: 'pj_1' }, { id: 'pj_2' }],
      milestones: [
        { id: 'ms_1', projectId: 'pj_1' },
        { id: 'ms_2', projectId: 'pj_2' },
      ],
      issues: [
        { id: 'in_1', projectId: 'pj_1', parentId: 'in_2' },
        { id: 'in_2', projectId: 'pj_2' },
        { id: 'in_3', projectId: null },
      ],
      artifacts: [],
      decisions: [{ id: 'dc_1', originIssueId: 'in_2' }],
      inputRequests: [{ id: 'ir_1', issueId: 'in_2' }],
      comments: [
        { subject: { type: 'issue', id: 'in_2' } },
        { subject: { type: 'issue', id: 'in_1' } },
      ],
      customers: [{ id: 'cu_1' }],
      customerRequests: [{ id: 'cr_1', projectId: 'pj_2', issueId: null }],
      events: [
        { subject: { type: 'issue', id: 'in_2' } },
        { subject: { type: 'issue', id: 'in_1' } },
      ],
      views: [],
    };
    const scoped = scopeSnapshot(snapshot, {
      ...limited,
      grants: roleGrants('member'),
    });
    expect(scoped.projects.map((p) => p.id)).toEqual(['pj_1']);
    expect(scoped.issues.map((i) => i.id)).toEqual(['in_1']);
    expect(scoped.issues[0].parentId).toBeNull();
    expect(scoped.comments.map((c) => c.subject.id)).toEqual(['in_1']);
    expect(scoped.customerRequests).toEqual([]);
    expect(scoped.decisions).toEqual([]);
    expect(scoped.inputRequests).toEqual([]);
    expect(scoped.events.map((e) => e.subject.id)).toEqual(['in_1']);
  });
});
