import { describe, expect, it, vi } from 'vitest';
import type {
  LegacySubjectRef,
  MemberAccess,
  MemberGrant,
} from '../contracts/domain.js';
import {
  ArtifactEntity,
  CommentEntity,
  CustomerEntity,
  CustomerRequestEntity,
  DecisionEntity,
  InputRequestEntity,
  IssueEntity,
  MilestoneEntity,
  ProjectEntity,
  ProjectUpdateEntity,
  ReleaseEntity,
  ReleasePipelineEntity,
} from '../database/entities/index.js';
import { EventVisibilityService } from './event-visibility.service.js';

const p1Rows = new Map<unknown, unknown[]>([
  [
    IssueEntity,
    [
      {
        id: 'iss_1',
        workspaceId: 'ws_1',
        projectId: 'pr_1',
        releaseId: 'rel_1',
      },
    ],
  ],
  [
    ProjectEntity,
    [
      {
        id: 'pr_1',
        workspaceId: 'ws_1',
        teamIds: ['tm_1'],
        repositoryIds: ['repo_1'],
      },
    ],
  ],
  [MilestoneEntity, [{ id: 'ms_1', workspaceId: 'ws_1', projectId: 'pr_1' }]],
  [
    ArtifactEntity,
    [{ id: 'ar_1', workspaceId: 'ws_1', projectId: 'pr_1', issueId: 'iss_1' }],
  ],
  [
    DecisionEntity,
    [
      {
        id: 'dc_1',
        workspaceId: 'ws_1',
        originIssueId: 'iss_1',
        relatedIssueIds: [],
      },
    ],
  ],
  [InputRequestEntity, [{ id: 'ir_1', workspaceId: 'ws_1', issueId: 'iss_1' }]],
  [CustomerEntity, [{ id: 'cus_1', workspaceId: 'ws_1' }]],
  [
    CustomerRequestEntity,
    [
      {
        id: 'cr_1',
        workspaceId: 'ws_1',
        customerId: 'cus_1',
        issueId: 'iss_1',
        projectId: null,
      },
    ],
  ],
  [
    ProjectUpdateEntity,
    [{ id: 'pu_1', workspaceId: 'ws_1', projectId: 'pr_1' }],
  ],
  [ReleaseEntity, [{ id: 'rel_1', workspaceId: 'ws_1', pipelineId: 'rp_1' }]],
  [ReleasePipelineEntity, [{ id: 'rp_1', workspaceId: 'ws_1' }]],
  [
    CommentEntity,
    [
      {
        id: 'cm_1',
        workspaceId: 'ws_1',
        subject: { type: 'issue', id: 'iss_1' },
      },
    ],
  ],
]);

function setup() {
  const getRepository = vi.fn((entity: unknown) => ({
    find: vi.fn(async () => p1Rows.get(entity) ?? []),
    findOneBy: vi.fn(
      async (where: { id: string }) =>
        (p1Rows.get(entity) ?? []).find(
          (row) => (row as { id: string }).id === where.id,
        ) ?? null,
    ),
  }));
  const service = new EventVisibilityService({ getRepository } as never);
  return { service, getRepository };
}

const VIEW_GRANTS: MemberGrant[] = [
  'projects:view',
  'issues:view',
  'milestones:view',
  'artifacts:view',
  'decisions:view',
  'input-requests:view',
  'customers:view',
  'documents:view',
  'comments:view',
];

function access(
  projectIds: string[],
  includeUnassigned = false,
  grants: MemberGrant[] = VIEW_GRANTS,
): MemberAccess {
  return {
    projects: { all: false, projectIds },
    includeUnassigned,
    grants,
  };
}

const refs: LegacySubjectRef[] = [
  { type: 'project', id: 'pr_1' },
  { type: 'issue', id: 'iss_1' },
  { type: 'milestone', id: 'ms_1' },
  { type: 'artifact', id: 'ar_1' },
  { type: 'decision', id: 'dc_1' },
  { type: 'input_request', id: 'ir_1' },
  { type: 'customer_request', id: 'cr_1' },
  { type: 'project_update', id: 'pu_1' },
  { type: 'team', id: 'tm_1' },
  { type: 'repository', id: 'repo_1' },
  { type: 'customer', id: 'cus_1' },
  { type: 'release', id: 'rel_1' },
  { type: 'release_pipeline', id: 'rp_1' },
  { type: 'document', id: 'doc_1' },
  { type: 'import', id: 'imp_1' },
];

describe('EventVisibilityService', () => {
  it('keeps visible events for every current subject type and allows workspace-level events only as unassigned', async () => {
    const { service } = setup();
    const events = refs.map((subject) => ({ subject }));

    const visible = await service.filterEvents(
      'ws_1',
      events,
      access(['pr_1'], true),
    );
    expect(visible.map((event) => event.subject)).toEqual(refs);

    const withoutUnassigned = await service.filterEvents(
      'ws_1',
      events.slice(-2),
      access(['pr_1'], false),
    );
    expect(withoutUnassigned).toEqual([]);
  });

  it('drops hidden, legacy-unresolved, and unknown subjects rather than treating them as unassigned', async () => {
    const { service } = setup();
    const events = [
      { subject: { type: 'project', id: 'pr_1' } as LegacySubjectRef },
      { subject: { type: 'workstream', id: 'wk_1' } as LegacySubjectRef },
      { subject: { type: 'issue', id: 'iss_missing' } as LegacySubjectRef },
    ];

    expect(
      await service.filterEvents('ws_1', events, access(['pr_2'], true)),
    ).toEqual([]);
  });

  it('does not infer unassigned visibility for deleted objects with unresolved hidden owners', async () => {
    const { service } = setup();
    const events = [
      {
        subject: { type: 'artifact', id: 'ar_deleted' } as LegacySubjectRef,
        data: { projectId: null, issueId: 'iss_missing' },
      },
      {
        subject: { type: 'decision', id: 'dc_deleted' } as LegacySubjectRef,
        data: { title: 'Deleted decision' },
      },
      {
        subject: { type: 'customer', id: 'cus_deleted' } as LegacySubjectRef,
        data: { name: 'Deleted customer' },
      },
    ];

    expect(
      await service.filterEvents('ws_1', events, access(['pr_1'], true)),
    ).toEqual([]);
  });

  it('treats an issue-owned artifact with projectId null as scoped to its issue', async () => {
    const { service } = setup();
    const events = [
      {
        subject: { type: 'artifact', id: 'ar_deleted' } as LegacySubjectRef,
        data: { projectId: null, issueId: 'iss_1' },
      },
    ];
    expect(
      await service.filterEvents('ws_1', events, access(['pr_1'], false)),
    ).toEqual(events);
  });

  it('requires resource grants and comments access before exposing excerpts', async () => {
    const { service } = setup();
    const issueEvent = {
      subject: { type: 'issue', id: 'iss_1' } as LegacySubjectRef,
    };
    const commentEvent = {
      subject: { type: 'issue', id: 'iss_1' } as LegacySubjectRef,
      type: 'comment.created',
      data: { excerpt: 'private excerpt' },
    };
    const viewGrants = access(['pr_1']).grants;

    expect(
      await service.filterEvents(
        'ws_1',
        [issueEvent],
        access(['pr_1'], false, []),
      ),
    ).toEqual([]);
    expect(
      await service.filterEvents(
        'ws_1',
        [commentEvent],
        access(
          ['pr_1'],
          false,
          viewGrants.filter((grant) => grant !== 'comments:view'),
        ),
      ),
    ).toEqual([]);
    expect(
      await service.filterEvents('ws_1', [commentEvent], access(['pr_1'])),
    ).toEqual([commentEvent]);
  });

  it('uses the original comment subject for live comment messages', async () => {
    const { service } = setup();
    const live = { entity: 'comment', id: 'cm_1', type: 'updated' };

    await expect(
      service.isLiveVisible('ws_1', live, access(['pr_1']), {
        type: 'issue',
        id: 'iss_1',
      }),
    ).resolves.toBe(true);
    await expect(
      service.isLiveVisible('ws_1', live, access(['pr_2']), {
        type: 'issue',
        id: 'iss_1',
      }),
    ).resolves.toBe(false);
    await expect(
      service.isLiveVisible('ws_1', live, access(['pr_1'])),
    ).resolves.toBe(true);
  });
});
