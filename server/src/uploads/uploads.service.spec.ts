import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { describe, expect, it } from 'vitest';
import type { EventsService } from '../events/events.service.js';
import type { WorkstreamBus } from '../events/workstream-bus.js';
import type { UploadEntity } from '../database/entities/index.js';
import type { UploadCaller } from './upload-rules.js';
import { UploadsService, type IncomingUpload } from './uploads.service.js';

const member: UploadCaller = {
  actor: { type: 'user', id: 'usr_1' },
  role: 'member',
  permissions: null,
};
const other: UploadCaller = {
  actor: { type: 'user', id: 'usr_2' },
  role: 'member',
  permissions: null,
};

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);

function file(name: string, bytes: Buffer): IncomingUpload {
  return {
    originalname: name,
    buffer: bytes,
    size: bytes.length,
    mimetype: 'application/octet-stream',
  };
}

function setup(
  issueBodies: { body: string; projectId: string | null }[] = [],
  docBodies: string[] = [],
) {
  const rows: UploadEntity[] = [];
  const uploads = {
    create: (row: UploadEntity) => row,
    save: async (row: UploadEntity) => {
      const at = rows.findIndex((item) => item.id === row.id);
      if (at >= 0) rows[at] = row;
      else rows.push(row);
      return row;
    },
    findOneBy: async (where: { workspaceId: string; id: string }) =>
      rows.find(
        (row) => row.workspaceId === where.workspaceId && row.id === where.id,
      ) ?? null,
    findOne: async (opts: { where: { workspaceId: string; id: string } }) =>
      rows.find(
        (row) =>
          row.workspaceId === opts.where.workspaceId &&
          row.id === opts.where.id,
      ) ?? null,
    update: async (
      where: { workspaceId: string; id: string },
      patch: Partial<UploadEntity>,
    ) => {
      const row = rows.find(
        (item) =>
          item.workspaceId === where.workspaceId && item.id === where.id,
      );
      if (row) Object.assign(row, patch);
    },
    delete: async (where: { workspaceId: string; id: string }) => {
      const at = rows.findIndex(
        (row) => row.workspaceId === where.workspaceId && row.id === where.id,
      );
      if (at >= 0) rows.splice(at, 1);
    },
  };
  const ds = {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes('FROM "documents"')) {
        const raw = params[1];
        const token = typeof raw === 'string' ? raw : '';
        return [{ hit: docBodies.some((body) => body.includes(token)) }];
      }
      if (!sql.includes('FROM "issues"') || !sql.includes('strpos')) return [];
      const raw = params[1];
      const token = typeof raw === 'string' ? raw : '';
      return issueBodies
        .filter((row) => row.body.includes(token))
        .map((row) => ({ projectId: row.projectId }));
    },
    getRepository: () => ({
      findOne: async () => null,
      createQueryBuilder: () => ({}),
    }),
  } as unknown as DataSource;
  const service = new UploadsService(
    ds,
    { record: async () => undefined } as unknown as EventsService,
    { touch: async () => undefined } as unknown as WorkstreamBus,
    uploads as never,
    {} as never,
  );
  return { service, rows };
}

describe('UploadsService', () => {
  it('accepts a png and returns a workspace url', async () => {
    const { service } = setup();
    const staged = await service.stage(
      'ws_1',
      'acme',
      member,
      file('shot.png', PNG),
    );
    expect(staged.url).toMatch(/^\/api\/w\/acme\/uploads\/upl_[a-z0-9]+$/);
    expect(staged.kind).toBe('image');
    expect(staged.markdown).toBe(`![shot.png](${staged.url})`);
    const opened = await service.open('ws_1', staged.id, member);
    expect(opened.bytes.equals(PNG)).toBe(true);
  });

  it('rejects an executable and a file over the size limit', async () => {
    const { service } = setup();
    const exe = Buffer.from([0x4d, 0x5a, 0x90, 0x00]);
    await expect(
      service.stage('ws_1', 'acme', member, file('run.exe', exe)),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.stage('ws_1', 'acme', member, file('run.png', exe)),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.stage(
        'ws_1',
        'acme',
        member,
        file('big.png', Buffer.concat([PNG, Buffer.alloc(8 * 1024 * 1024)])),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("refuses another workspace, another member's draft, and a file whose reference was removed", async () => {
    const bodies: { body: string; projectId: string | null }[] = [];
    const { service, rows } = setup(bodies);
    const staged = await service.stage(
      'ws_1',
      'acme',
      member,
      file('shot.png', PNG),
    );

    await expect(
      service.open('ws_2', staged.id, member),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(rows).toHaveLength(1);
    await expect(service.open('ws_1', staged.id, other)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(rows).toHaveLength(1);

    bodies.push({ body: staged.markdown, projectId: 'pj_1' });
    await service.retained('ws_1', null, staged.markdown);
    expect((await service.open('ws_1', staged.id, other)).id).toBe(staged.id);

    bodies.length = 0;
    await service.retained('ws_1', staged.markdown, null);
    await expect(
      service.open('ws_1', staged.id, member),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(rows).toHaveLength(0);
  });

  it('serves a file mentioned by a document body, and drops it once no version mentions it', async () => {
    const docBodies: string[] = [];
    const { service, rows } = setup([], docBodies);
    const staged = await service.stage(
      'ws_1',
      'acme',
      member,
      file('shot.png', PNG),
    );

    await expect(service.open('ws_1', staged.id, other)).rejects.toBeInstanceOf(
      NotFoundException,
    );

    docBodies.push(staged.markdown);
    expect((await service.open('ws_1', staged.id, other)).id).toBe(staged.id);

    // The current body drops it, but a kept revision still mentions it.
    docBodies.length = 0;
    docBodies.push(`Old version:\n\n${staged.markdown}`);
    expect((await service.open('ws_1', staged.id, other)).id).toBe(staged.id);

    docBodies.length = 0;
    await service.releaseIds('ws_1', [staged.id]);
    await expect(
      service.open('ws_1', staged.id, member),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(rows).toHaveLength(0);
  });
});
