import { describe, expect, it } from 'vitest';
import { projectHidden } from '../auth/member-access.js';
import type { MemberAccess } from '../contracts/domain.js';
import {
  UPLOAD_MAX_BYTES,
  canAttachArtifact,
  canStageUpload,
  contentDisposition,
  inspectUpload,
  isWorkspaceUploadUrl,
  uploadIdsIn,
  uploadVisible,
  type UploadCaller,
} from './upload-rules.js';

const png = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00,
]);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const gif = Buffer.from('GIF89a', 'ascii');
const pdf = Buffer.from('%PDF-1.7', 'ascii');
const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]);
const exe = Buffer.from([0x4d, 0x5a, 0x90, 0x00]);

const member: UploadCaller = {
  actor: { type: 'user', id: 'usr_1' },
  role: 'member',
  permissions: null,
};

describe('inspectUpload', () => {
  it('accepts an image and a document', () => {
    expect(
      inspectUpload({ originalName: 'shot.PNG', bytes: png }),
    ).toMatchObject({
      ok: true,
      file: { filename: 'shot.png', contentType: 'image/png', kind: 'image' },
    });
    expect(
      inspectUpload({
        originalName: 'notes/readme.md',
        bytes: Buffer.from('# hi', 'utf8'),
      }),
    ).toMatchObject({
      ok: true,
      file: {
        filename: 'readme.md',
        contentType: 'text/markdown',
        kind: 'file',
      },
    });
    expect(inspectUpload({ originalName: 'spec.pdf', bytes: pdf }).ok).toBe(
      true,
    );
    expect(inspectUpload({ originalName: 'photo.jpg', bytes: jpeg }).ok).toBe(
      true,
    );
    expect(inspectUpload({ originalName: 'anim.gif', bytes: gif }).ok).toBe(
      true,
    );
    expect(inspectUpload({ originalName: 'sheet.xlsx', bytes: zip }).ok).toBe(
      true,
    );
  });

  it('rejects executables, active content, mismatched bytes and oversized files', () => {
    expect(
      inspectUpload({ originalName: 'run.exe', bytes: exe }),
    ).toMatchObject({ ok: false });
    expect(
      inspectUpload({ originalName: 'run.png', bytes: exe }),
    ).toMatchObject({
      ok: false,
      reason: 'Executables and active content are not allowed',
    });
    expect(
      inspectUpload({
        originalName: 'page.html',
        bytes: Buffer.from('<html></html>', 'utf8'),
      }).ok,
    ).toBe(false);
    expect(
      inspectUpload({
        originalName: 'icon.svg',
        bytes: Buffer.from('<svg></svg>', 'utf8'),
      }).ok,
    ).toBe(false);
    expect(
      inspectUpload({
        originalName: 'page.txt',
        bytes: Buffer.from('<script>alert(1)</script>', 'utf8'),
      }),
    ).toMatchObject({
      ok: false,
      reason: 'The file contents do not match its type',
    });
    expect(
      inspectUpload({
        originalName: 'tool.txt',
        bytes: Buffer.from('#!/bin/sh\necho hi', 'utf8'),
      }).ok,
    ).toBe(false);
    expect(
      inspectUpload({
        originalName: 'app.js',
        bytes: Buffer.from('alert(1)', 'utf8'),
      }).ok,
    ).toBe(false);
    expect(
      inspectUpload({
        originalName: 'pic.png',
        bytes: Buffer.from('not a png', 'utf8'),
      }),
    ).toMatchObject({
      ok: false,
      reason: 'The file contents do not match its type',
    });
    expect(
      inspectUpload({
        originalName: 'big.png',
        bytes: Buffer.alloc(UPLOAD_MAX_BYTES + 1),
      }),
    ).toMatchObject({
      ok: false,
      reason: 'File is larger than 8 MB',
    });
    expect(
      inspectUpload({ originalName: 'empty.png', bytes: Buffer.alloc(0) }),
    ).toMatchObject({ ok: false });
    expect(
      inspectUpload({ originalName: '../secret.png', bytes: png }).ok,
    ).toBe(true);
    const accepted = inspectUpload({
      originalName: '../secret.png',
      bytes: png,
    });
    if (accepted.ok) expect(accepted.file.filename).toBe('secret.png');
  });
});

describe('upload urls', () => {
  it('recognises only a workspace path', () => {
    const url = '/api/w/acme/uploads/upl_abcdefghijkl';
    expect(isWorkspaceUploadUrl(url)).toBe(true);
    expect(
      isWorkspaceUploadUrl(
        'https://example.com/api/w/acme/uploads/upl_abcdefghijkl',
      ),
    ).toBe(false);
    expect(isWorkspaceUploadUrl('//evil/uploads/upl_abcdefghijkl')).toBe(false);
    expect(uploadIdsIn(`see ${url} and ${url}`)).toEqual(['upl_abcdefghijkl']);
    expect(contentDisposition('image', 'shot.png')).toContain('inline');
    expect(contentDisposition('file', 'notes.md')).toContain('attachment');
  });
});

describe('who can see a file', () => {
  const limited = {
    projects: { all: false, projectIds: ['pj_1'] },
    includeUnassigned: false,
    grants: [
      'issues:view',
      'artifacts:view',
      'comments:view',
      'projects:view',
      'workstreams:view',
    ],
  } as MemberAccess;

  it('hides a file whose parent project is outside the caller', () => {
    expect(projectHidden(limited, 'pj_2')).toBe(true);
    expect(
      uploadVisible(
        { resource: 'issues', projectScoped: true, projectId: 'pj_2' },
        limited,
        null,
      ),
    ).toBe(false);
    expect(
      uploadVisible(
        { resource: 'issues', projectScoped: true, projectId: 'pj_1' },
        limited,
        null,
      ),
    ).toBe(true);
    expect(
      uploadVisible(
        { resource: 'issues', projectScoped: true, projectId: 'pj_1' },
        limited,
        ['projects:read'],
      ),
    ).toBe(false);
    expect(
      uploadVisible(
        { resource: 'comments', projectScoped: false, projectId: null },
        limited,
        null,
      ),
    ).toBe(true);
  });

  it('lets a member stage a file and refuses a viewer or a token without a write', () => {
    expect(canStageUpload(member, null)).toBe(true);
    expect(canStageUpload({ ...member, role: 'viewer' }, null)).toBe(false);
    expect(
      canStageUpload({ ...member, permissions: ['issues:read'] }, null),
    ).toBe(false);
    expect(
      canStageUpload({ ...member, permissions: ['issues:write'] }, null),
    ).toBe(true);
    expect(canAttachArtifact({ ...member, role: 'viewer' }, null)).toBe(false);
    expect(canAttachArtifact(member, null)).toBe(true);
  });
});
