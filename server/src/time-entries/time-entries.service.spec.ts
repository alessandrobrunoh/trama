import { BadRequestException, NotFoundException } from '@nestjs/common';
import { FindOperator, type Repository } from 'typeorm';
import { describe, expect, it } from 'vitest';
import { notFound } from '../common/util.js';
import { IssueEntity } from '../database/entities/index.js';
import type { ProjectsService } from '../projects/projects.service.js';
import { TimeEntriesService } from './time-entries.service.js';
import { TimeEntryEntity } from './time-entry.entity.js';

const PROJECTS = ['pj_1'];
const ISSUES: Record<string, string | null> = { in_1: 'pj_1', in_2: 'pj_2' };

type Where = Record<string, unknown>;
/** Equality, plus the one operator the service uses: `Not(value)`. */
const matches = (row: object, where: Where) =>
  Object.entries(where).every(([key, value]) => {
    const actual = (row as Record<string, unknown>)[key];
    if (value instanceof FindOperator && value.type === 'not') return actual !== value.value;
    return actual === value;
  });

function fakeRepo<T extends object>(rows: T[], make: (x: Partial<T>) => T, key: (row: T) => string) {
  return {
    create: (x: Partial<T>) => make(x),
    save: async (x: T) => {
      const i = rows.findIndex((row) => key(row) === key(x));
      if (i >= 0) rows[i] = x;
      else rows.push(x);
      return x;
    },
    find: async (opts?: { where?: Where }) =>
      rows.filter((row) => !opts?.where || matches(row, opts.where)),
    findOneBy: async (where: Where) => rows.find((row) => matches(row, where)) ?? null,
    delete: async (where: Where) => {
      for (let i = rows.length - 1; i >= 0; i--) if (matches(rows[i], where)) rows.splice(i, 1);
    },
  };
}

function setup() {
  const rows: TimeEntryEntity[] = [];
  const issues: IssueEntity[] = Object.entries(ISSUES).map(([id, projectId]) =>
    Object.assign(new IssueEntity(), { id, workspaceId: 'ws_1', projectId }),
  );
  const projects = {
    get: async (workspaceId: string, id: string) => {
      if (workspaceId !== 'ws_1' || !PROJECTS.includes(id)) throw notFound('Project', id);
      return { id, workspaceId };
    },
  } as unknown as ProjectsService;
  const service = new TimeEntriesService(
    fakeRepo(rows, (x) => Object.assign(new TimeEntryEntity(), x), (row) => row.id) as unknown as Repository<TimeEntryEntity>,
    fakeRepo(issues, (x) => Object.assign(new IssueEntity(), x), (row) => row.id) as unknown as Repository<IssueEntity>,
    projects,
  );
  return { service, rows };
}

describe('TimeEntriesService', () => {
  it('stops the running timer when a second one starts', async () => {
    const { service, rows } = setup();
    const first = await service.start('ws_1', 'usr_a', { description: 'First' });
    const second = await service.start('ws_1', 'usr_a', { description: 'Second', projectId: 'pj_1' });
    expect(first.endedAt).not.toBeNull();
    expect(second.endedAt).toBeNull();
    expect(rows.filter((row) => row.userId === 'usr_a' && row.endedAt == null)).toHaveLength(1);
    expect(rows.find((row) => row.userId === 'usr_b')).toBeUndefined();
  });

  it('rejects a manual entry that ends before it starts', async () => {
    const { service, rows } = setup();
    const err = await service
      .add('ws_1', 'usr_a', {
        startedAt: '2026-10-28T10:00:00.000Z',
        endedAt: '2026-10-28T09:00:00.000Z',
      })
      .catch((error: unknown) => error);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(rows).toHaveLength(0);
  });

  it('does not let one person delete another person\'s entry', async () => {
    const { service, rows } = setup();
    const entry = await service.add('ws_1', 'usr_a', {
      description: 'Mine',
      startedAt: '2026-10-28T10:00:00.000Z',
      endedAt: '2026-10-28T11:00:00.000Z',
    });
    const err = await service.remove('ws_1', 'usr_b', entry.id).catch((error: unknown) => error);
    expect(err).toBeInstanceOf(NotFoundException);
    expect(rows).toHaveLength(1);
    expect(await service.list('ws_1', 'usr_b')).toEqual([]);
    expect(await service.list('ws_1', 'usr_a')).toHaveLength(1);
  });

  function suggestion(rows: TimeEntryEntity[], userId: string, id = 'te_s'): TimeEntryEntity {
    const row = Object.assign(new TimeEntryEntity(), {
      id,
      workspaceId: 'ws_1',
      userId,
      projectId: null,
      issueId: null,
      description: '',
      source: 'suggested',
      startedAt: new Date('2026-10-28T10:00:00.000Z'),
      endedAt: new Date('2026-10-28T10:47:00.000Z'),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    rows.push(row);
    return row;
  }

  it('tags entries by how they were made', async () => {
    const { service } = setup();
    expect((await service.start('ws_1', 'usr_a')).source).toBe('timer');
    const added = await service.add('ws_1', 'usr_a', {
      startedAt: '2026-10-28T10:00:00.000Z',
      endedAt: '2026-10-28T11:00:00.000Z',
    });
    expect(added.source).toBe('manual');
  });

  it('leaves suggestions out of the list until they are asked for', async () => {
    const { service, rows } = setup();
    await service.add('ws_1', 'usr_a', {
      startedAt: '2026-10-28T10:00:00.000Z',
      endedAt: '2026-10-28T11:00:00.000Z',
    });
    suggestion(rows, 'usr_a');
    expect((await service.list('ws_1', 'usr_a')).map((row) => row.source)).toEqual(['manual']);
    expect((await service.list('ws_1', 'usr_a', 'suggested')).map((row) => row.id)).toEqual(['te_s']);
  });

  it('a suggestion is never a running timer', async () => {
    const { service, rows } = setup();
    const row = suggestion(rows, 'usr_a');
    row.endedAt = null;
    const started = await service.start('ws_1', 'usr_a');
    expect(row.endedAt).toBeNull();
    expect(started.endedAt).toBeNull();
    const err = await service.stop('ws_1', 'usr_b').catch((error: unknown) => error);
    expect(err).toBeInstanceOf(BadRequestException);
  });

  it('only the owner accepts a suggestion, and only a suggestion can be accepted', async () => {
    const { service, rows } = setup();
    suggestion(rows, 'usr_a');
    const stranger = await service.accept('ws_1', 'usr_b', 'te_s').catch((error: unknown) => error);
    expect(stranger).toBeInstanceOf(NotFoundException);
    const accepted = await service.accept('ws_1', 'usr_a', 'te_s');
    expect(accepted.source).toBe('manual');
    expect((await service.list('ws_1', 'usr_a')).map((row) => row.id)).toEqual(['te_s']);
    const again = await service.accept('ws_1', 'usr_a', 'te_s').catch((error: unknown) => error);
    expect(again).toBeInstanceOf(BadRequestException);
  });

  it('dismissing a suggestion deletes it', async () => {
    const { service, rows } = setup();
    suggestion(rows, 'usr_a');
    await service.remove('ws_1', 'usr_a', 'te_s');
    expect(rows).toHaveLength(0);
  });

  it('starts and stops a timer on a task', async () => {
    const { service } = setup();
    const started = await service.start('ws_1', 'usr_a', { issueId: 'in_1' });
    expect(started.projectId).toBe('pj_1');
    expect(started.issueId).toBe('in_1');
    const stopped = await service.stop('ws_1', 'usr_a');
    expect(stopped.endedAt).not.toBeNull();
  });
});
