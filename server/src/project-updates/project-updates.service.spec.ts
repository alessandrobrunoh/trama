import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { DataSource, Repository } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceContext } from '../auth/request-context.js';
import {
  DEFAULT_PERMISSIONS,
  type ActorRef,
  type Role,
} from '../contracts/domain.js';
import {
  ProjectEntity,
  ProjectUpdateEntity,
} from '../database/entities/index.js';
import type { EventsService } from '../events/events.service.js';
import { ProjectUpdatesService } from './project-updates.service.js';

type Where = Record<string, unknown>;

/** Minimal in-memory stand-in for the two TypeORM repositories the service touches. */
function fakeRepo<T extends { id: string }>(rows: T[]) {
  const matches = (r: T, where: Where) =>
    Object.entries(where).every(
      ([k, v]) => (r as Record<string, unknown>)[k] === v,
    );
  return {
    rows,
    create: (x: Partial<T>) => x as T,
    save: async (x: T) => {
      const i = rows.findIndex((r) => r.id === x.id);
      if (i >= 0) rows[i] = x;
      else rows.push(x);
      return x;
    },
    findOneBy: async (where: Where) =>
      rows.find((r) => matches(r, where)) ?? null,
    find: async ({ where, take }: { where: Where; take?: number }) => {
      const found = rows
        .filter((r) => matches(r, where))
        .sort((a, b) => {
          const d =
            (b as unknown as { createdAt: Date }).createdAt.getTime() -
            (a as unknown as { createdAt: Date }).createdAt.getTime();
          return d || b.id.localeCompare(a.id);
        });
      return take ? found.slice(0, take) : found;
    },
    update: async (where: Where, patch: Partial<T>) => {
      for (const r of rows) if (matches(r, where)) Object.assign(r, patch);
    },
    delete: async (where: Where) => {
      for (const r of rows.filter((x) => matches(x, where)))
        rows.splice(rows.indexOf(r), 1);
    },
  };
}

const ACTOR_LEAD: ActorRef = { type: 'user', id: 'u_lead' };
const ACTOR_AUTHOR: ActorRef = { type: 'user', id: 'u_author' };
const ACTOR_OTHER: ActorRef = { type: 'user', id: 'u_other' };

function setup() {
  const project = {
    id: 'pj_1',
    workspaceId: 'ws_1',
    leadId: 'u_lead',
    health: null,
    lastUpdateAt: null,
  } as unknown as ProjectEntity;
  const projects = fakeRepo<ProjectEntity>([project]);
  const updates = fakeRepo<ProjectUpdateEntity>([]);
  const queries: string[] = [];
  const manager = {
    getRepository: (target: unknown) =>
      target === ProjectEntity ? projects : updates,
    query: async (sql: string) => void queries.push(sql),
  };
  const ds = {
    transaction: async <R>(cb: (m: typeof manager) => Promise<R>) =>
      cb(manager),
  } as unknown as DataSource;
  const events = { record: vi.fn(async () => ({})), publish: vi.fn() };
  const service = new ProjectUpdatesService(
    ds,
    events as unknown as EventsService,
    updates as unknown as Repository<ProjectUpdateEntity>,
    projects as unknown as Repository<ProjectEntity>,
  );
  return { service, project, updates, events, queries };
}

function ctx(actor: ActorRef, role: Role): WorkspaceContext {
  return {
    workspace: {
      id: 'ws_1',
      resolved: () => ({ permissions: DEFAULT_PERMISSIONS }),
    },
    actor,
    userId: actor.id,
    role,
  } as unknown as WorkspaceContext;
}

/** Raises manageProjects to admin for this request's workspace. */
function raiseManageProjects(c: WorkspaceContext) {
  (c.workspace as unknown as { resolved: () => unknown }).resolved = () => ({
    permissions: { ...DEFAULT_PERMISSIONS, manageProjects: 'admin' },
  });
  return c;
}

/** Make the next created update strictly newer than the previous ones. */
const tick = () => new Promise((r) => setTimeout(r, 2));

describe('ProjectUpdatesService', () => {
  it('drives Project.health and lastUpdateAt from the newest update, falling back after a delete', async () => {
    const { service, project } = setup();
    const lead = ctx(ACTOR_LEAD, 'member');

    const first = await service.create(lead, 'pj_1', {
      health: 'on_track',
      body: ' All good ',
    });
    expect(first.body).toBe('All good');
    expect(first.author).toEqual(ACTOR_LEAD);
    expect(project.health).toBe('on_track');
    expect(project.lastUpdateAt).toEqual(first.createdAt);

    await tick();
    const second = await service.create(lead, 'pj_1', {
      health: 'off_track',
      body: 'Slipping',
    });
    expect(project.health).toBe('off_track');
    expect(project.lastUpdateAt).toEqual(second.createdAt);
    expect((await service.list('ws_1', 'pj_1')).map((u) => u.id)).toEqual([
      second.id,
      first.id,
    ]);

    await service.remove(lead, 'pj_1', second.id);
    expect(project.health).toBe('on_track');
    expect(project.lastUpdateAt).toEqual(first.createdAt);

    await service.remove(lead, 'pj_1', first.id);
    expect(project.health).toBeNull();
    expect(project.lastUpdateAt).toBeNull();
  });

  it('recomputes the project health when the newest update is edited, but not for an older one', async () => {
    const { service, project } = setup();
    const lead = ctx(ACTOR_LEAD, 'member');
    const older = await service.create(lead, 'pj_1', {
      health: 'on_track',
      body: 'a',
    });
    await tick();
    const newest = await service.create(lead, 'pj_1', {
      health: 'at_risk',
      body: 'b',
    });

    await service.update(lead, 'pj_1', older.id, { health: 'off_track' });
    expect(project.health).toBe('at_risk');
    const edited = await service.update(lead, 'pj_1', newest.id, {
      health: 'on_track',
    });
    expect(project.health).toBe('on_track');
    expect(edited.editedAt).toBeInstanceOf(Date);
  });

  it('only lets the lead or a role with manageProjects post an update', async () => {
    const { service } = setup();
    // viewers/members who are neither lead nor allowed by the permission map are rejected...
    const strict = ctx(ACTOR_OTHER, 'viewer');
    await expect(
      service.create(strict, 'pj_1', { health: 'on_track', body: 'x' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    // ...a member passes manageProjects by default; the lead passes even when the permission is raised
    const raised = raiseManageProjects(ctx(ACTOR_LEAD, 'member'));
    await expect(
      service.create(raised, 'pj_1', { health: 'on_track', body: 'x' }),
    ).resolves.toBeDefined();
    const other = raiseManageProjects(ctx(ACTOR_OTHER, 'member'));
    await expect(
      service.create(other, 'pj_1', { health: 'on_track', body: 'x' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('lets only the author or a manageProjects role edit and delete', async () => {
    const { service } = setup();
    // with manageProjects raised to admin, a member who is not the lead cannot post...
    await expect(
      service.create(raiseManageProjects(ctx(ACTOR_AUTHOR, 'member')), 'pj_1', {
        health: 'on_track',
        body: 'x',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    // ...while the lead (a member) still can, and becomes the author
    const leadCtx = raiseManageProjects(ctx(ACTOR_LEAD, 'member'));
    const row = await service.create(leadCtx, 'pj_1', {
      health: 'on_track',
      body: 'by lead',
    });

    const stranger = raiseManageProjects(ctx(ACTOR_OTHER, 'member'));
    await expect(
      service.update(stranger, 'pj_1', row.id, { body: 'hijack' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.remove(stranger, 'pj_1', row.id),
    ).rejects.toBeInstanceOf(ForbiddenException);

    // the author edits their own; an admin can too
    await expect(
      service.update(leadCtx, 'pj_1', row.id, { body: 'edited' }),
    ).resolves.toMatchObject({ body: 'edited' });
    const admin = ctx(ACTOR_OTHER, 'admin');
    raiseManageProjects(admin);
    await expect(
      service.update(admin, 'pj_1', row.id, { body: 'moderated' }),
    ).resolves.toMatchObject({ body: 'moderated' });
    await expect(
      service.remove(admin, 'pj_1', row.id),
    ).resolves.toBeUndefined();
  });

  it('records events with the project and health, and drops the update comments on delete', async () => {
    const { service, events, queries } = setup();
    const lead = ctx(ACTOR_LEAD, 'member');
    const row = await service.create(lead, 'pj_1', {
      health: 'at_risk',
      body: 'x',
      aiDrafted: true,
    });
    expect(row.aiDrafted).toBe(true);
    expect(events.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'project_update.created',
        subject: { type: 'project_update', id: row.id },
        data: { projectId: 'pj_1', health: 'at_risk' },
      }),
    );
    expect(events.publish).toHaveBeenCalledWith('ws_1', {
      type: 'updated',
      entity: 'project',
      id: 'pj_1',
    });

    // no-op patch: nothing recorded
    events.record.mockClear();
    await service.update(lead, 'pj_1', row.id, {
      body: 'x',
      health: 'at_risk',
    });
    expect(events.record).not.toHaveBeenCalled();

    await service.remove(lead, 'pj_1', row.id);
    expect(queries.some((q) => q.includes('DELETE FROM "comments"'))).toBe(
      true,
    );
    expect(events.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'project_update.deleted' }),
    );
  });

  it('404s on unknown projects and updates', async () => {
    const { service } = setup();
    const lead = ctx(ACTOR_LEAD, 'member');
    await expect(service.list('ws_1', 'pj_nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      service.create(lead, 'pj_nope', { health: 'on_track', body: 'x' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.get('ws_1', 'pj_1', 'pu_nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
