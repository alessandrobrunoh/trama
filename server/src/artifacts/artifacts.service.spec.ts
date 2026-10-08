import { BadRequestException } from '@nestjs/common';
import type { DataSource, Repository } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import type { RefsService } from '../common/refs.service.js';
import type { ArtifactEntity } from '../database/entities/index.js';
import type { EventsService } from '../events/events.service.js';
import type { WorkstreamBus } from '../events/workstream-bus.js';
import { ArtifactsService, isHttpUrl } from './artifacts.service.js';

const ACTOR = { type: 'user', id: 'u_1' } as const;

function setup(existing: Partial<ArtifactEntity> | null = null) {
  const record = vi.fn(async () => ({}));
  const touch = vi.fn(async () => undefined);
  const row = existing ? ({ id: 'ar_1', workspaceId: 'ws_1', kind: 'document', title: 'Doc', ...existing } as ArtifactEntity) : null;
  const repo = {
    create: (x: Partial<ArtifactEntity>) => x as ArtifactEntity,
    save: async (x: ArtifactEntity) => x,
    findOneBy: async () => row,
  } as unknown as Repository<ArtifactEntity>;
  const exists = { existsBy: async () => true };
  const ds = { getRepository: () => exists, query: async () => [] } as unknown as DataSource;
  const refs = { workstreams: async () => undefined, repositories: async () => undefined } as unknown as RefsService;
  const service = new ArtifactsService(ds, refs, { record } as unknown as EventsService, { touch } as unknown as WorkstreamBus, repo);
  return { service, record, touch };
}

describe('isHttpUrl', () => {
  it('accepts only http(s) urls', () => {
    expect(isHttpUrl('https://example.com/a?b=1')).toBe(true);
    expect(isHttpUrl('http://localhost:3000')).toBe(true);
    for (const v of ['', null, undefined, 'example.com', 'ftp://example.com', 'javascript:alert(1)']) expect(isHttpUrl(v)).toBe(false);
  });
});

describe('ArtifactsService owners', () => {
  it('requires at least one owner', async () => {
    const { service } = setup();
    await expect(service.create('ws_1', ACTOR, { kind: 'document', title: 'x' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('requires a valid http(s) url for a link', async () => {
    const { service } = setup();
    await expect(service.create('ws_1', ACTOR, { kind: 'link', title: 'x', projectId: 'pj_1' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.create('ws_1', ACTOR, { kind: 'link', title: 'x', projectId: 'pj_1', url: 'ftp://x' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.create('ws_1', ACTOR, { kind: 'link', title: 'x', projectId: 'pj_1', url: 'https://x.test' })).resolves.toMatchObject({ kind: 'link', state: 'published' });
  });

  it('lets a document carry only a description, and reports the owners in the event', async () => {
    const { service, record, touch } = setup();
    const row = await service.create('ws_1', ACTOR, { kind: 'document', title: 'Notes', description: ' why ', issueId: 'in_1', projectId: 'pj_1' });
    expect(row).toMatchObject({ description: 'why', issueId: 'in_1', projectId: 'pj_1', workstreamId: null });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ type: 'artifact.attached', workstreamId: undefined, data: expect.objectContaining({ issueId: 'in_1', projectId: 'pj_1' }) }));
    expect(touch).not.toHaveBeenCalled();
  });

  it('touches the workstream when the artifact has one', async () => {
    const { service, touch } = setup();
    await service.create('ws_1', ACTOR, { kind: 'document', title: 'Notes', workstreamId: 'wk_1' });
    expect(touch).toHaveBeenCalledWith('ws_1', 'wk_1', 'artifact.attached');
  });

  it('refuses to detach the last owner and keeps the others when detaching one', async () => {
    const { service, record } = setup({ workstreamId: 'wk_1', projectId: null, issueId: null });
    await expect(service.update('ws_1', ACTOR, 'ar_1', { workstreamId: null })).rejects.toBeInstanceOf(BadRequestException);
    const { service: s2, record: r2 } = setup({ workstreamId: 'wk_1', projectId: 'pj_1', issueId: null });
    await expect(s2.update('ws_1', ACTOR, 'ar_1', { workstreamId: null })).resolves.toMatchObject({ projectId: 'pj_1', workstreamId: null });
    expect(r2).toHaveBeenCalledWith(expect.objectContaining({ type: 'artifact.updated', data: expect.objectContaining({ projectId: 'pj_1' }) }));
    expect(record).not.toHaveBeenCalled();
  });
});
