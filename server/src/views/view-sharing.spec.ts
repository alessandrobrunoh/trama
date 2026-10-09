import 'reflect-metadata';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceContext } from '../auth/request-context.js';
import type { Role, SharingSettings } from '../contracts/domain.js';
import { MembershipEntity, SavedViewEntity, UserEntity } from '../database/entities/index.js';
import { canEditView, canManageSharing, canReadView } from './view-access.js';
import { applyFilters, fieldValues, groupItems, sortItems } from './view-query.js';
import { generatePublicToken, hashPublicToken, isPublicToken } from './view-token.js';
import { CreateViewDto, InviteViewDto, UpdateViewDto } from './views.controller.js';
import { ViewsService } from './views.service.js';

const sharing = (visibility: SharingSettings['visibility'], grants: SharingSettings['grants'] = []): SharingSettings => ({ visibility, grants });
const actor = (userId: string | undefined, role: Role = 'member') => ({ userId, role });

describe('view access rules', () => {
  const priv = { ownerId: 'owner', sharing: sharing('private', [{ userId: 'viewer1', level: 'view' }, { userId: 'editor1', level: 'edit' }]) };
  const ws = { ownerId: 'owner', sharing: sharing('workspace') };
  const link = { ownerId: 'owner', sharing: sharing('link') };

  it('private views are visible to the owner and invited people only', () => {
    expect(canReadView(priv, actor('owner'))).toBe(true);
    expect(canReadView(priv, actor('viewer1'))).toBe(true);
    expect(canReadView(priv, actor('stranger'))).toBe(false);
    expect(canReadView(priv, actor('stranger', 'admin'))).toBe(false);
    expect(canReadView(priv, actor(undefined))).toBe(false);
  });

  it('workspace and link views are visible to every member and agent', () => {
    for (const v of [ws, link]) {
      expect(canReadView(v, actor('stranger', 'viewer'))).toBe(true);
      expect(canReadView(v, actor(undefined))).toBe(true);
    }
  });

  it('view grants cannot edit, edit grants can', () => {
    expect(canEditView(priv, actor('viewer1'))).toBe(false);
    expect(canEditView(priv, actor('editor1'))).toBe(true);
    expect(canEditView(priv, actor('editor1', 'viewer'))).toBe(false);
    expect(canEditView(ws, actor('stranger'))).toBe(false);
  });

  it('admins manage shared views but not private ones', () => {
    expect(canEditView(ws, actor('admin1', 'admin'))).toBe(true);
    expect(canManageSharing(ws, actor('admin1', 'admin'))).toBe(true);
    expect(canManageSharing(link, actor('admin1', 'admin'))).toBe(true);
    expect(canEditView(priv, actor('admin1', 'admin'))).toBe(false);
    expect(canManageSharing(priv, actor('admin1', 'admin'))).toBe(false);
  });

  it('editors cannot change sharing; the owner always can', () => {
    expect(canManageSharing(priv, actor('editor1'))).toBe(false);
    expect(canManageSharing(priv, actor('owner'))).toBe(true);
  });
});

describe('public tokens', () => {
  it('are long, URL safe, unique and hashed for lookup', () => {
    const a = generatePublicToken();
    const b = generatePublicToken();
    expect(a).not.toBe(b);
    expect(isPublicToken(a)).toBe(true);
    expect(a.length).toBeGreaterThanOrEqual(46);
    expect(hashPublicToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashPublicToken(a)).not.toContain(a);
    for (const bad of ['', 'abc', 'vt_short', `vt_${'a'.repeat(44)}`, `xx_${'a'.repeat(43)}`, `vt_${'a'.repeat(42)}/`]) expect(isPublicToken(bad)).toBe(false);
  });
});

describe('sharing DTOs', () => {
  const errorsOf = async (cls: new () => object, plain: object) => (await validate(plainToInstance(cls, plain))).length;

  it('accepts a visibility and grants, rejects unknown values', async () => {
    expect(await errorsOf(CreateViewDto, { name: 'x', entity: 'issue', sharing: { visibility: 'link' } })).toBe(0);
    expect(await errorsOf(UpdateViewDto, { sharing: { visibility: 'workspace', grants: [{ userId: 'u2', level: 'edit' }] } })).toBe(0);
    expect(await errorsOf(UpdateViewDto, { sharing: { visibility: 'public' } })).toBeGreaterThan(0);
    expect(await errorsOf(UpdateViewDto, { sharing: { grants: [{ userId: 'u2', level: 'owner' }] } })).toBeGreaterThan(0);
  });

  it('validates invitation emails', async () => {
    expect(await errorsOf(InviteViewDto, { emails: ['a@example.com', 'b@example.com'] })).toBe(0);
    expect(await errorsOf(InviteViewDto, { emails: [] })).toBeGreaterThan(0);
    expect(await errorsOf(InviteViewDto, { emails: ['not-an-email'] })).toBeGreaterThan(0);
    expect(await errorsOf(InviteViewDto, { emails: ['a@example.com'], level: 'owner' })).toBeGreaterThan(0);
  });
});

describe('ViewsService sharing', () => {
  const events = { publish: vi.fn() };
  const ctxOf = (userId: string | undefined, role: Role = 'member', canShare = true) =>
    ({
      userId,
      role,
      workspace: { id: 'w1', resolved: () => ({ permissions: { manageSharedViews: canShare ? 'member' : 'admin' } }) },
    }) as unknown as WorkspaceContext;
  const row = (over: Record<string, unknown> = {}) =>
    Object.assign(new SavedViewEntity(), {
      id: 'v1',
      workspaceId: 'w1',
      ownerId: 'owner',
      name: 'V',
      entity: 'issue',
      filters: [],
      sort: null,
      groupBy: null,
      layout: 'list',
      shared: false,
      sharing: sharing('private'),
      publicTokenHash: null,
      publicTokenEnc: null,
      ...over,
    });
  const members = [
    { userId: 'owner' },
    { userId: 'u2' },
    { userId: 'u3' },
  ] as MembershipEntity[];
  const users = [
    { id: 'owner', email: 'owner@example.com' },
    { id: 'u2', email: 'Two@Example.com' },
    { id: 'u3', email: 'three@example.com' },
  ] as UserEntity[];
  const make = (rows: SavedViewEntity[]) => {
    const repo = {
      find: vi.fn(async () => rows),
      findOneBy: vi.fn(async ({ id }: { id: string }) => rows.find((r) => r.id === id) ?? null),
      create: vi.fn((v: object) => Object.assign(new SavedViewEntity(), v)),
      save: vi.fn(async (v: object) => v),
      delete: vi.fn(async () => undefined),
    };
    const ds = {
      getRepository: (entity: unknown) => ({
        findBy: async (where: { userId?: unknown; id?: unknown }) => {
          if (entity === MembershipEntity) return where.userId ? members.filter((m) => (where.userId as { _value: string[] })._value.includes(m.userId)) : members;
          if (entity === UserEntity) return users;
          return [];
        },
      }),
    };
    return { repo, service: new ViewsService(events as never, repo as never, ds as never) };
  };

  it('lists only views the caller may see', async () => {
    const rows = [
      row({ id: 'own', ownerId: 'u2' }),
      row({ id: 'other-private', ownerId: 'owner' }),
      row({ id: 'invited', sharing: sharing('private', [{ userId: 'u2', level: 'view' }]) }),
      row({ id: 'ws', sharing: sharing('workspace') }),
      row({ id: 'lnk', sharing: sharing('link') }),
    ];
    const { service } = make(rows);
    const list = await service.list(ctxOf('u2'));
    expect(list.map((v) => v.id)).toEqual(['own', 'invited', 'ws', 'lnk']);
  });

  it('hides views the caller may not read behind a 404', async () => {
    const { service } = make([row()]);
    await expect(service.get(ctxOf('u2'), 'v1')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.update(ctxOf('u2'), 'v1', { name: 'x' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.remove(ctxOf('u2'), 'v1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('read-only invitees cannot edit; editors can edit content but not sharing', async () => {
    const r = row({ sharing: sharing('private', [{ userId: 'u2', level: 'view' }, { userId: 'u3', level: 'edit' }]) });
    const { service } = make([r]);
    await expect(service.update(ctxOf('u2'), 'v1', { name: 'x' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.update(ctxOf('u3'), 'v1', { name: 'renamed' })).resolves.toMatchObject({ name: 'renamed' });
    await expect(service.update(ctxOf('u3'), 'v1', { sharing: { visibility: 'link' } })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.update(ctxOf('u3'), 'v1', { shared: true })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.remove(ctxOf('u3'), 'v1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('mints a token when a view goes public and shows it to managers only', async () => {
    const r = row({ sharing: sharing('workspace'), shared: true });
    const { service } = make([r]);
    const owner = await service.update(ctxOf('owner'), 'v1', { sharing: { visibility: 'link' } });
    expect(owner.sharing.visibility).toBe('link');
    expect(owner.publicToken).toMatch(/^vt_/);
    expect(hashPublicToken(owner.publicToken!)).toBe(r.publicTokenHash);
    const json = JSON.stringify(owner);
    expect(json).not.toContain('publicTokenHash');
    expect(json).not.toContain('publicTokenEnc');
    // an ordinary member sees the view but not the secret
    const member = await service.get(ctxOf('u2'), 'v1');
    expect(member.sharing.visibility).toBe('link');
    expect(member.publicToken).toBeUndefined();
    // an admin can manage a shared view and sees the link
    expect((await service.get(ctxOf('a1', 'admin'), 'v1')).publicToken).toBe(owner.publicToken);
  });

  it('revokes the link when access changes, and issues a new one when it returns', async () => {
    const r = row();
    const { service } = make([r]);
    const first = (await service.update(ctxOf('owner'), 'v1', { sharing: { visibility: 'link' } })).publicToken!;
    const oldHash = r.publicTokenHash;
    await service.update(ctxOf('owner'), 'v1', { sharing: { visibility: 'workspace' } });
    expect(r.publicTokenHash).toBeNull();
    expect(r.publicTokenEnc).toBeNull();
    expect(r.shared).toBe(true);
    await service.update(ctxOf('owner'), 'v1', { shared: false });
    expect(r.sharing.visibility).toBe('private');
    expect(r.shared).toBe(false);
    const second = (await service.update(ctxOf('owner'), 'v1', { sharing: { visibility: 'link' } })).publicToken!;
    expect(second).not.toBe(first);
    expect(r.publicTokenHash).not.toBe(oldHash);
  });

  it('rotating the link invalidates the previous token', async () => {
    const r = row({ sharing: sharing('workspace') });
    const { service } = make([r]);
    await expect(service.rotateLink(ctxOf('owner'), 'v1')).rejects.toBeInstanceOf(BadRequestException);
    const first = (await service.update(ctxOf('owner'), 'v1', { sharing: { visibility: 'link' } })).publicToken!;
    const next = (await service.rotateLink(ctxOf('owner'), 'v1')).publicToken!;
    expect(next).not.toBe(first);
    expect(r.publicTokenHash).toBe(hashPublicToken(next));
    await expect(service.rotateLink(ctxOf('u2'), 'v1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('needs the manageSharedViews capability to share beyond invited people', async () => {
    const { service } = make([row()]);
    await expect(service.update(ctxOf('owner', 'member', false), 'v1', { sharing: { visibility: 'workspace' } })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.update(ctxOf('owner', 'member', false), 'v1', { sharing: { visibility: 'link' } })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.create(ctxOf('owner', 'member', false), { name: 'x', entity: 'issue', sharing: { visibility: 'link' } })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.create(ctxOf('owner', 'member', false), { name: 'x', entity: 'issue' })).resolves.toMatchObject({ name: 'x' });
  });

  it('keeps the legacy shared flag working', async () => {
    const r = row();
    const { service } = make([r]);
    await service.update(ctxOf('owner'), 'v1', { shared: true });
    expect(r.sharing.visibility).toBe('workspace');
    await service.update(ctxOf('owner'), 'v1', { sharing: { visibility: 'link' } });
    await service.update(ctxOf('owner'), 'v1', { shared: true });
    expect(r.sharing.visibility).toBe('link');
  });

  it('invites workspace members by email, case-insensitively, and never the owner twice', async () => {
    const r = row();
    const { service } = make([r]);
    const out = await service.invite(ctxOf('owner'), 'v1', [' TWO@example.com', 'three@example.com', 'owner@example.com'], 'edit');
    expect(out.sharing.grants).toEqual([
      { userId: 'u2', level: 'edit' },
      { userId: 'u3', level: 'edit' },
    ]);
    await service.invite(ctxOf('owner'), 'v1', ['two@example.com'], 'view');
    expect(r.sharing.grants.find((g) => g.userId === 'u2')?.level).toBe('view');
    expect(r.sharing.visibility).toBe('private');
  });

  it('refuses to invite people outside the workspace or without management rights', async () => {
    const { service } = make([row()]);
    await expect(service.invite(ctxOf('owner'), 'v1', ['two@example.com', 'stranger@example.com'])).rejects.toThrow(/stranger@example.com/);
    await expect(service.invite(ctxOf('owner'), 'v1', [])).rejects.toBeInstanceOf(BadRequestException);
    const r = row({ sharing: sharing('private', [{ userId: 'u2', level: 'edit' }]) });
    const other = make([r]);
    await expect(other.service.invite(ctxOf('u2'), 'v1', ['three@example.com'])).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('removes invitees by replacing the grant list, which must name workspace members', async () => {
    const r = row({ sharing: sharing('private', [{ userId: 'u2', level: 'view' }, { userId: 'u3', level: 'view' }]) });
    const { service } = make([r]);
    await service.update(ctxOf('owner'), 'v1', { sharing: { grants: [{ userId: 'u3', level: 'view' }] } });
    expect(r.sharing.grants).toEqual([{ userId: 'u3', level: 'view' }]);
    await expect(service.update(ctxOf('owner'), 'v1', { sharing: { grants: [{ userId: 'ghost', level: 'view' }] } })).rejects.toBeInstanceOf(BadRequestException);
    await service.update(ctxOf('owner'), 'v1', { sharing: { grants: [{ userId: 'owner', level: 'edit' }] } });
    expect(r.sharing.grants).toEqual([]);
  });
});

describe('view query', () => {
  const items = [
    { id: 'a', status: 'todo', priority: 'low', title: 'B', teamId: 't1', body: 'secret', updatedAt: new Date('2026-01-02T00:00:00Z'), workstreamIds: ['w1'], projectId: null },
    { id: 'b', status: 'done', priority: 'urgent', title: 'A', teamId: null, body: 'hidden', updatedAt: new Date('2026-01-01T00:00:00Z'), workstreamIds: [], projectId: 'p2' },
    { id: 'c', status: 'todo', priority: 'urgent', title: 'C', teamId: 't1', body: 'x', updatedAt: new Date('2026-01-03T00:00:00Z'), workstreamIds: [], projectId: null },
  ];

  it('filters, sorts by enum order and groups', () => {
    expect(applyFilters('issue', items, [{ field: 'status', op: 'is', value: 'todo' }]).map((i) => i.id)).toEqual(['a', 'c']);
    expect(applyFilters('issue', items, [{ field: 'teamId', op: 'is', value: '' }]).map((i) => i.id)).toEqual(['b']);
    expect(sortItems('issue', items, { field: 'priority', direction: 'asc' }).map((i) => i.id)).toEqual(['b', 'c', 'a']);
    expect(sortItems('issue', items, { field: 'title', direction: 'desc' }).map((i) => i.id)).toEqual(['c', 'a', 'b']);
    expect(groupItems('issue', items, 'status').map((g) => g.key)).toEqual(['todo', 'done']);
  });

  it('counts the projects of an issue workstreams', () => {
    const ctx = { workstreamProjects: new Map([['w1', 'p9']]) };
    expect(fieldValues('issue', items[0], 'projectId', ctx)).toEqual(['p9']);
    expect(applyFilters('issue', items, [{ field: 'projectId', op: 'in', value: ['p9', 'p2'] }], ctx).map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('never reads fields outside the queryable whitelist', () => {
    expect(fieldValues('issue', items[0], 'body')).toEqual([]);
    expect(fieldValues('issue', items[0], 'workspaceId')).toEqual([]);
    expect(applyFilters('issue', items, [{ field: 'body', op: 'contains', value: 'secret' }])).toEqual([]);
    expect(sortItems('issue', items, { field: 'body', direction: 'asc' }).map((i) => i.id)).toEqual(['a', 'b', 'c']);
    expect(groupItems('issue', items, 'body')).toEqual([{ key: '', items }]);
    expect(fieldValues('issue', items[0], '__proto__')).toEqual([]);
  });
});
