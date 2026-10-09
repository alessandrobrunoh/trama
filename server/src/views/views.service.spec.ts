import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceContext } from '../auth/request-context.js';
import { CreateViewDto, UpdateViewDto } from './views.controller.js';
import {
  VIEW_ENTITIES,
  VIEW_LAYOUTS,
  viewLayoutProblem,
} from './view-rules.js';
import { SavedViewEntity } from '../database/entities/index.js';
import { ViewsService } from './views.service.js';

const errorsOf = async (cls: new () => object, plain: object) =>
  (await validate(plainToInstance(cls, plain))).map((e) => e.property);

describe('view rules', () => {
  it('accepts project views and the timeline layout', () => {
    expect(VIEW_ENTITIES).toContain('project');
    expect(VIEW_LAYOUTS).toContain('timeline');
  });

  it('allows the timeline only for workstream and project views', () => {
    expect(viewLayoutProblem('workstream', 'timeline')).toBeNull();
    expect(viewLayoutProblem('project', 'timeline')).toBeNull();
    expect(viewLayoutProblem('issue', 'timeline')).toMatch(/timeline/);
    expect(viewLayoutProblem('decision', 'timeline')).toMatch(/timeline/);
    expect(viewLayoutProblem('issue', 'board')).toBeNull();
    expect(viewLayoutProblem('project', 'list')).toBeNull();
  });
});

describe('view DTOs', () => {
  it('validates a project timeline view', async () => {
    expect(
      await errorsOf(CreateViewDto, {
        name: 'Roadmap',
        entity: 'project',
        layout: 'timeline',
      }),
    ).toEqual([]);
    expect(
      await errorsOf(CreateViewDto, {
        name: 'Q4',
        entity: 'workstream',
        layout: 'timeline',
        filters: [{ field: 'projectId', op: 'in', value: ['pj_1'] }],
      }),
    ).toEqual([]);
  });

  it('rejects unknown entities and layouts', async () => {
    expect(
      await errorsOf(CreateViewDto, { name: 'x', entity: 'execution' }),
    ).toContain('entity');
    expect(
      await errorsOf(CreateViewDto, {
        name: 'x',
        entity: 'issue',
        layout: 'gantt',
      }),
    ).toContain('layout');
    expect(
      await errorsOf(UpdateViewDto, { entity: 'project', layout: 'timeline' }),
    ).toEqual([]);
    expect(await errorsOf(UpdateViewDto, { layout: 'calendar' })).toContain(
      'layout',
    );
  });
});

describe('ViewsService layout/entity validation', () => {
  const ctx = {
    userId: 'u1',
    role: 'member',
    workspace: { id: 'w1' },
  } as unknown as WorkspaceContext;
  const events = { publish: vi.fn() };
  const entityOf = (row: Record<string, unknown>) =>
    Object.assign(new SavedViewEntity(), {
      sharing: { visibility: 'private', grants: [] },
      publicTokenHash: null,
      publicTokenEnc: null,
      ...row,
    });
  const make = (row?: Record<string, unknown>) => {
    const repo = {
      create: vi.fn((v: object) => entityOf(v as Record<string, unknown>)),
      save: vi.fn(async (v: object) => v),
      findOneBy: vi.fn(async () => (row ? entityOf(row) : null)),
    };
    return {
      repo,
      service: new ViewsService(events as never, repo as never, {} as never),
    };
  };

  it('creates a project timeline view', async () => {
    const { repo, service } = make();
    await service.create(ctx, {
      name: ' Roadmap ',
      entity: 'project',
      layout: 'timeline',
    });
    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Roadmap',
        entity: 'project',
        layout: 'timeline',
      }),
    );
  });

  it('refuses a timeline of issues', async () => {
    const { repo, service } = make();
    await expect(
      service.create(ctx, { name: 'x', entity: 'issue', layout: 'timeline' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('checks the resulting combination on update', async () => {
    const row = {
      id: 'v1',
      workspaceId: 'w1',
      ownerId: 'u1',
      shared: false,
      entity: 'workstream',
      layout: 'timeline',
    };
    const a = make({ ...row });
    await expect(
      a.service.update(ctx, 'v1', { entity: 'issue' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    const b = make({ ...row });
    await expect(
      b.service.update(ctx, 'v1', { entity: 'project' }),
    ).resolves.toMatchObject({ entity: 'project', layout: 'timeline' });
    const c = make({ ...row, entity: 'issue', layout: 'list' });
    await expect(
      c.service.update(ctx, 'v1', { layout: 'timeline' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
