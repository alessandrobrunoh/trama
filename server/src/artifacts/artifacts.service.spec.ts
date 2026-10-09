import { BadRequestException, ConflictException } from '@nestjs/common';
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

describe('ArtifactsService document artifacts', () => {
  function withDocument(docs: { id: string; title: string; workspaceId: string }[], attached: Partial<ArtifactEntity>[] = []) {
    const record = vi.fn(async () => ({}));
    const repo = {
      create: (x: Partial<ArtifactEntity>) => x as ArtifactEntity,
      save: async (x: ArtifactEntity) => x,
      findOneBy: async () => null,
      existsBy: async (w: Partial<ArtifactEntity>) => attached.some((a) => Object.entries(w).every(([k, v]) => (a as Record<string, unknown>)[k] === v)),
    } as unknown as Repository<ArtifactEntity>;
    const others = { existsBy: async () => true, findOne: async ({ where }: { where: { id: string; workspaceId: string } }) => docs.find((d) => d.id === where.id && d.workspaceId === where.workspaceId) ?? null };
    const ds = { getRepository: () => others, query: async () => [] } as unknown as DataSource;
    const refs = { workstreams: async () => undefined, repositories: async () => undefined } as unknown as RefsService;
    return { service: new ArtifactsService(ds, refs, { record } as unknown as EventsService, { touch: async () => undefined } as unknown as WorkstreamBus, repo) };
  }

  it('takes title and provider from the document and needs no url', async () => {
    const { service } = withDocument([{ id: 'doc_1', title: 'Spec', workspaceId: 'ws_1' }]);
    await expect(service.create('ws_1', ACTOR, { kind: 'document', documentId: 'doc_1', projectId: 'pj_1', title: 'ignored', url: 'https://x.test' })).resolves.toMatchObject({
      title: 'Spec',
      documentId: 'doc_1',
      provider: 'docs',
      url: null,
      state: 'published',
    });
  });

  it('refuses a document of another workspace, a wrong kind, and a second attach to the same owner', async () => {
    const { service } = withDocument([{ id: 'doc_1', title: 'Spec', workspaceId: 'ws_2' }]);
    await expect(service.create('ws_1', ACTOR, { kind: 'document', documentId: 'doc_1', projectId: 'pj_1' })).rejects.toBeInstanceOf(BadRequestException);
    const mine = withDocument([{ id: 'doc_1', title: 'Spec', workspaceId: 'ws_1' }], [{ documentId: 'doc_1', projectId: 'pj_1', workspaceId: 'ws_1' }]);
    await expect(mine.service.create('ws_1', ACTOR, { kind: 'link', documentId: 'doc_1', projectId: 'pj_1', url: 'https://x.test' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(mine.service.create('ws_1', ACTOR, { kind: 'document', documentId: 'doc_1', projectId: 'pj_1' })).rejects.toBeInstanceOf(ConflictException);
    await expect(mine.service.create('ws_1', ACTOR, { kind: 'document', documentId: 'doc_1', issueId: 'in_1' })).resolves.toMatchObject({ issueId: 'in_1' });
  });

  it('still needs a title without a document', async () => {
    const { service } = withDocument([]);
    await expect(service.create('ws_1', ACTOR, { kind: 'document', projectId: 'pj_1' })).rejects.toBeInstanceOf(BadRequestException);
  });
});
