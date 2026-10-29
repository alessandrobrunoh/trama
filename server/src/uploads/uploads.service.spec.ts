import { BadRequestException, NotFoundException } from '@nestjs/common';
import { type FindOperator } from 'typeorm';
import type { DataSource } from 'typeorm';
import { describe, expect, it } from 'vitest';
import { memberAccessStore } from '../auth/member-access.js';
import type { MemberAccess } from '../contracts/domain.js';
import type { EventsService } from '../events/events.service.js';
import type { UploadEntity } from '../database/entities/index.js';
import type { UploadCaller } from './upload-rules.js';
import {
  UploadsService,
  type IncomingUpload,
  type UploadSubject,
} from './uploads.service.js';

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

interface Mention {
  workspaceId: string;
  uploadId: string;
  subjectType: string;
  subjectId: string;
  projectId: string | null;
}

function idList(id: string | FindOperator<string>): string[] {
  if (typeof id === 'string') return [id];
  const value = id.value;
  return Array.isArray(value) ? value : [];
}

function setup() {
  const rows: UploadEntity[] = [];
  const mentions: Mention[] = [];
  const queries: string[] = [];
  const issueProjects = new Map<string, string | null>();
  const live = {
    issues: new Set<string>(),
    projects: new Set<string>(),
    documents: new Set<string>(),
    revisions: new Set<string>(),
    artifacts: new Map<string, string | null>(),
  };
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
    find: async (opts: {
      where: { workspaceId: string; id: FindOperator<string> | string };
    }) => {
      const ids = new Set(idList(opts.where.id));
      return rows.filter(
        (row) => row.workspaceId === opts.where.workspaceId && ids.has(row.id),
      );
    },
    update: async (
      where: { workspaceId: string; id: string | FindOperator<string> },
      patch: Partial<UploadEntity>,
    ) => {
      const ids = new Set(idList(where.id));
      for (const row of rows)
        if (row.workspaceId === where.workspaceId && ids.has(row.id))
          Object.assign(row, patch);
    },
    delete: async (where: {
      workspaceId: string;
      id: string | FindOperator<string>;
    }) => {
      const ids = new Set(idList(where.id));
      for (let i = rows.length - 1; i >= 0; i -= 1)
        if (rows[i].workspaceId === where.workspaceId && ids.has(rows[i].id))
          rows.splice(i, 1);
    },
  };
  const ds = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push(sql);
      if (
        sql.includes('DELETE FROM "upload_references"') &&
        sql.includes('unnest')
      ) {
        const [workspaceId, types, subjectIds] = params as [
          string,
          string[],
          string[],
        ];
        const removed: Mention[] = [];
        for (let i = mentions.length - 1; i >= 0; i -= 1) {
          const mention = mentions[i];
          const hit = types.some(
            (type, index) =>
              mention.workspaceId === workspaceId &&
              mention.subjectType === type &&
              mention.subjectId === subjectIds[index],
          );
          if (hit) removed.push(...mentions.splice(i, 1));
        }
        return removed.map((row) => ({ uploadId: row.uploadId }));
      }
      if (
        sql.includes('DELETE FROM "upload_references"') &&
        sql.includes('"subjectType" = $2')
      ) {
        const [workspaceId, subjectType, subjectId] = params as string[];
        for (let i = mentions.length - 1; i >= 0; i -= 1) {
          const mention = mentions[i];
          if (
            mention.workspaceId === workspaceId &&
            mention.subjectType === subjectType &&
            mention.subjectId === subjectId
          )
            mentions.splice(i, 1);
        }
        return [];
      }
      if (sql.includes('INSERT INTO "upload_references"')) {
        const [workspaceId, uploadIds, subjectType, subjectId, projectId] =
          params as [string, string[] | string, string, string, string | null];
        const list = Array.isArray(uploadIds) ? uploadIds : [uploadIds];
        if (sql.includes("'artifact'")) {
          const [ws, uploadId, artifactId, project] = params as [
            string,
            string,
            string,
            string | null,
          ];
          mentions.push({
            workspaceId: ws,
            uploadId,
            subjectType: 'artifact',
            subjectId: artifactId,
            projectId: project,
          });
          return [];
        }
        for (const uploadId of list) {
          if (
            !mentions.some(
              (row) =>
                row.workspaceId === workspaceId &&
                row.uploadId === uploadId &&
                row.subjectType === subjectType &&
                row.subjectId === subjectId,
            )
          ) {
            mentions.push({
              workspaceId,
              uploadId,
              subjectType,
              subjectId,
              projectId,
            });
          }
        }
        return [];
      }
      if (
        sql.includes('FROM "upload_references"') &&
        sql.includes('"subjectType" = $2')
      ) {
        const [workspaceId, subjectType, subjectId] = params as string[];
        return mentions
          .filter(
            (row) =>
              row.workspaceId === workspaceId &&
              row.subjectType === subjectType &&
              row.subjectId === subjectId,
          )
          .map((row) => ({ uploadId: row.uploadId }));
      }
      if (sql.includes('FROM "upload_references"')) {
        const [workspaceId, ids] = params as [string, string[]];
        return mentions.filter(
          (row) =>
            row.workspaceId === workspaceId && ids.includes(row.uploadId),
        );
      }
      if (sql.includes('FROM "artifacts"')) {
        const [, ids] = params as [string, string[]];
        return ids
          .filter((id) => live.artifacts.has(id))
          .map((id) => ({ id, projectId: live.artifacts.get(id) ?? null }));
      }
      if (sql.includes('FROM "issues"')) {
        const [, ids] = params as [string, string[]];
        return ids
          .filter((id) => live.issues.has(id))
          .map((id) => ({ id, projectId: issueProjects.get(id) ?? null }));
      }
      if (sql.includes('FROM "projects"')) {
        const [, ids] = params as [string, string[]];
        return ids.filter((id) => live.projects.has(id)).map((id) => ({ id }));
      }
      if (sql.includes('FROM "documents"')) {
        const [, ids] = params as [string, string[]];
        return ids.filter((id) => live.documents.has(id)).map((id) => ({ id }));
      }
      if (sql.includes('FROM "document_revisions"')) {
        const [, ids] = params as [string, string[]];
        return ids.filter((id) => live.revisions.has(id)).map((id) => ({ id }));
      }
      return [];
    },
    getRepository: () => ({
      findOne: async () => null,
      createQueryBuilder: () => ({}),
    }),
    transaction: async (fn: (m: unknown) => Promise<unknown>) => fn(ds),
  } as unknown as DataSource;
  const service = new UploadsService(
    ds,
    { record: async () => undefined } as unknown as EventsService,
    uploads as never,
    {} as never,
  );
  return { service, rows, mentions, queries, issueProjects, live };
}

const issue = (id: string, projectId: string | null): UploadSubject => ({
  type: 'issue',
  id,
  projectId,
});

describe('UploadsService', () => {
  it('accepts a png and returns a workspace url', async () => {
    const { service, queries } = setup();
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
    expect(
      queries.some(
        (sql) => sql.includes('strpos') || sql.includes('regexp_matches'),
      ),
    ).toBe(false);
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

  it('keeps a mentioned file readable, then deletes it when the text drops it', async () => {
    const { service, rows, live, issueProjects } = setup();
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

    live.issues.add('in_1');
    issueProjects.set('in_1', 'pj_1');
    await service.retained(
      'ws_1',
      null,
      staged.markdown,
      issue('in_1', 'pj_1'),
    );
    expect((await service.open('ws_1', staged.id, other)).id).toBe(staged.id);

    await service.retained(
      'ws_1',
      staged.markdown,
      null,
      issue('in_1', 'pj_1'),
    );
    await expect(
      service.open('ws_1', staged.id, member),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(rows).toHaveLength(0);
  });

  it('hides a file whose only mention is on a project the caller cannot see', async () => {
    const { service, rows, live, issueProjects } = setup();
    const staged = await service.stage(
      'ws_1',
      'acme',
      member,
      file('shot.png', PNG),
    );
    live.issues.add('in_hidden');
    issueProjects.set('in_hidden', 'pj_hidden');
    await service.retained(
      'ws_1',
      null,
      staged.markdown,
      issue('in_hidden', 'pj_hidden'),
    );
    const access: MemberAccess = {
      projects: { all: false, projectIds: ['pj_visible'] },
      includeUnassigned: true,
      grants: [
        'issues:view',
        'projects:view',
        'documents:view',
        'comments:view',
        'artifacts:view',
      ],
    };
    await memberAccessStore.run(access, async () => {
      await expect(
        service.open('ws_1', staged.id, other),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
    expect(rows).toHaveLength(1);
  });

  it('serves a file mentioned by a document revision after the current body drops it', async () => {
    const { service, rows, live } = setup();
    const staged = await service.stage(
      'ws_1',
      'acme',
      member,
      file('shot.png', PNG),
    );

    await expect(service.open('ws_1', staged.id, other)).rejects.toBeInstanceOf(
      NotFoundException,
    );

    live.documents.add('doc_1');
    live.revisions.add('rev_1');
    await service.retained('ws_1', null, staged.markdown, {
      type: 'document',
      id: 'doc_1',
    });
    await service.retained('ws_1', null, staged.markdown, {
      type: 'document_revision',
      id: 'rev_1',
    });
    expect((await service.open('ws_1', staged.id, other)).id).toBe(staged.id);

    await service.retained('ws_1', staged.markdown, 'no file', {
      type: 'document',
      id: 'doc_1',
    });
    expect((await service.open('ws_1', staged.id, other)).id).toBe(staged.id);

    await service.forgetSubjects('ws_1', [
      { type: 'document_revision', id: 'rev_1' },
    ]);
    await expect(
      service.open('ws_1', staged.id, member),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(rows).toHaveLength(0);
  });
});
