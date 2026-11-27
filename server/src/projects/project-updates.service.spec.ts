import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { PROJECT_UPDATE_BODY_MAX, type ActorRef } from '../contracts/domain.js';
import { ProjectUpdateEntity } from '../database/entities/index.js';
import { ProjectUpdatesService } from './project-updates.service.js';

const author: ActorRef = { type: 'user', id: 'us_author' };
const other: ActorRef = { type: 'user', id: 'us_other' };

function ctxOf(actor: ActorRef, capabilities: string[] = ['manageProjects']) {
  return { workspace: { id: 'ws_1' }, actor, role: 'member', capabilities } as never;
}

function stored(over: Partial<ProjectUpdateEntity> = {}): ProjectUpdateEntity {
  return {
    id: 'pu_1',
    workspaceId: 'ws_1',
    projectId: 'pj_1',
    author,
    body: 'Shipped the beta',
    health: null,
    createdAt: new Date(0),
    editedAt: null,
    ...over,
  } as ProjectUpdateEntity;
}

function setup(opts: { rows?: ProjectUpdateEntity[]; projectHealth?: string | null } = {}) {
  const rows = [...(opts.rows ?? [])];
  const repo = {
    create: vi.fn((value: Partial<ProjectUpdateEntity>) => value as ProjectUpdateEntity),
    save: vi.fn(async (row: ProjectUpdateEntity) => row),
    find: vi.fn(async () => rows),
    findOneBy: vi.fn(
      async (where: { id: string; projectId: string }) =>
        rows.find((row) => row.id === where.id && row.projectId === where.projectId) ?? null,
    ),
    delete: vi.fn(async () => undefined),
  };
  const projects = {
    get: vi.fn(async () => ({ id: 'pj_1', health: opts.projectHealth ?? null })),
    update: vi.fn(async () => undefined),
    resolveHealth: vi.fn(async (_ws: string, value: string) => {
      if (value === 'bogus') throw new BadRequestException('Unknown health "bogus"');
      return value === 'red' ? 'off_track' : value;
    }),
  };
  const events = { record: vi.fn(async () => undefined), publish: vi.fn() };
  const service = new ProjectUpdatesService(repo as never, projects as never, events as never);
  return { service, repo, projects, events, rows };
}

describe('ProjectUpdatesService.create', () => {
  it('trims the body, stores the author and records the post', async () => {
    const { service, repo, events, projects } = setup();

    const row = await service.create(ctxOf(author), 'pj_1', { body: '  Shipped the beta \n' });

    expect(row).toMatchObject({
      workspaceId: 'ws_1',
      projectId: 'pj_1',
      author,
      body: 'Shipped the beta',
      health: null,
      editedAt: null,
    });
    expect(row.id).toMatch(/^pu_/);
    expect(repo.save).toHaveBeenCalledOnce();
    expect(projects.update).not.toHaveBeenCalled();
    expect(events.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'project.update_posted',
        subject: { type: 'project', id: 'pj_1' },
        data: expect.objectContaining({ updateId: row.id, excerpt: 'Shipped the beta', health: null }),
      }),
      { type: 'created', entity: 'project_update', id: row.id },
    );
  });

  it('rejects an empty and an over-long body without writing', async () => {
    const { service, repo } = setup();

    await expect(service.create(ctxOf(author), 'pj_1', { body: '  \n ' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      service.create(ctxOf(author), 'pj_1', { body: 'x'.repeat(PROJECT_UPDATE_BODY_MAX + 1) }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await service.create(ctxOf(author), 'pj_1', { body: 'x'.repeat(PROJECT_UPDATE_BODY_MAX) });
    expect(repo.save).toHaveBeenCalledOnce();
  });

  it('rejects an unknown health before anything is written', async () => {
    const { service, repo, projects } = setup();

    await expect(
      service.create(ctxOf(author), 'pj_1', { body: 'Hi', health: 'bogus' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.save).not.toHaveBeenCalled();
    expect(projects.update).not.toHaveBeenCalled();
  });

  it('sets the project health through ProjectsService.update when a health is reported', async () => {
    const { service, projects } = setup({ projectHealth: 'on_track' });

    const row = await service.create(ctxOf(author), 'pj_1', { body: 'Slipping', health: 'red' });

    expect(row.health).toBe('off_track');
    expect(projects.update).toHaveBeenCalledWith('ws_1', author, 'pj_1', { health: 'off_track' });
  });

  it('leaves the project alone when it already has that health', async () => {
    const { service, projects } = setup({ projectHealth: 'at_risk' });

    await service.create(ctxOf(author), 'pj_1', { body: 'Still risky', health: 'at_risk' });

    expect(projects.update).not.toHaveBeenCalled();
  });

  it('does not write when the project is not visible', async () => {
    const { service, repo, projects } = setup();
    projects.get.mockRejectedValueOnce(new NotFoundException('Project "pj_1" not found'));

    await expect(service.create(ctxOf(author), 'pj_1', { body: 'Hi' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(repo.save).not.toHaveBeenCalled();
  });
});

describe('ProjectUpdatesService.list', () => {
  it('checks that the project is visible before reading', async () => {
    const { service, repo, projects } = setup({ rows: [stored()] });

    expect(await service.list('ws_1', 'pj_1')).toHaveLength(1);
    expect(repo.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: 'ws_1', projectId: 'pj_1' },
        order: { createdAt: 'DESC', id: 'DESC' },
      }),
    );

    projects.get.mockRejectedValueOnce(new NotFoundException('Project "pj_2" not found'));
    repo.find.mockClear();
    await expect(service.list('ws_1', 'pj_2')).rejects.toBeInstanceOf(NotFoundException);
    expect(repo.find).not.toHaveBeenCalled();
  });
});

describe('ProjectUpdatesService.update', () => {
  it('lets the author edit the text, marks it edited and never touches the project', async () => {
    const { service, repo, projects, events } = setup({ rows: [stored()] });

    const row = await service.update(ctxOf(author), 'pj_1', 'pu_1', { body: ' Shipped the beta, really ' });

    expect(row.body).toBe('Shipped the beta, really');
    expect(row.editedAt).toBeInstanceOf(Date);
    expect(repo.save).toHaveBeenCalledOnce();
    expect(projects.update).not.toHaveBeenCalled();
    expect(events.publish).toHaveBeenCalledWith(
      'ws_1',
      { type: 'updated', entity: 'project_update', id: 'pu_1' },
      undefined,
      { type: 'project', id: 'pj_1' },
    );
  });

  it('changes the reported health of the update without changing the project health', async () => {
    const { service, projects } = setup({ rows: [stored({ health: 'on_track' })] });

    const row = await service.update(ctxOf(author), 'pj_1', 'pu_1', { health: 'at_risk' });
    expect(row.health).toBe('at_risk');
    const cleared = await service.update(ctxOf(author), 'pj_1', 'pu_1', { health: null });
    expect(cleared.health).toBeNull();
    expect(projects.update).not.toHaveBeenCalled();
    await expect(
      service.update(ctxOf(author), 'pj_1', 'pu_1', { health: 'bogus' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses anyone but the author, even with manageProjects', async () => {
    const { service, repo } = setup({ rows: [stored()] });

    await expect(
      service.update(ctxOf(other, ['manageProjects']), 'pj_1', 'pu_1', { body: 'Hijacked' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('validates the new body like a new post', async () => {
    const { service } = setup({ rows: [stored()] });

    await expect(service.update(ctxOf(author), 'pj_1', 'pu_1', { body: '   ' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      service.update(ctxOf(author), 'pj_1', 'pu_1', { body: 'x'.repeat(PROJECT_UPDATE_BODY_MAX + 1) }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('does not mark an unchanged update as edited', async () => {
    const { service, repo, events } = setup({ rows: [stored()] });

    const row = await service.update(ctxOf(author), 'pj_1', 'pu_1', { body: 'Shipped the beta' });

    expect(row.editedAt).toBeNull();
    expect(repo.save).not.toHaveBeenCalled();
    expect(events.publish).not.toHaveBeenCalled();
  });

  it('is a 404 for an update of another project', async () => {
    const { service } = setup({ rows: [stored({ projectId: 'pj_other' })] });

    await expect(service.update(ctxOf(author), 'pj_1', 'pu_1', { body: 'x' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('ProjectUpdatesService.remove', () => {
  it('lets the author delete their own update, even without manageProjects', async () => {
    const { service, repo, events } = setup({ rows: [stored()] });

    await service.remove(ctxOf(author, []), 'pj_1', 'pu_1');

    expect(repo.delete).toHaveBeenCalledWith({ id: 'pu_1' });
    expect(events.publish).toHaveBeenCalledWith(
      'ws_1',
      { type: 'deleted', entity: 'project_update', id: 'pu_1' },
      undefined,
      { type: 'project', id: 'pj_1' },
    );
  });

  it('lets anyone with manageProjects delete someone else’s update', async () => {
    const { service, repo } = setup({ rows: [stored()] });

    await service.remove(ctxOf(other, ['manageProjects']), 'pj_1', 'pu_1');

    expect(repo.delete).toHaveBeenCalledOnce();
  });

  it('refuses someone else without manageProjects', async () => {
    const { service, repo, events } = setup({ rows: [stored()] });

    await expect(service.remove(ctxOf(other, ['createIssues']), 'pj_1', 'pu_1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(repo.delete).not.toHaveBeenCalled();
    expect(events.publish).not.toHaveBeenCalled();
  });

  it('is a 404 for a missing update', async () => {
    const { service } = setup();

    await expect(service.remove(ctxOf(author), 'pj_1', 'pu_missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
