import { hasRole } from '../auth/request-context.js';
import { projectHidden } from '../auth/member-access.js';
import type {
  ActorRef,
  MemberAccess,
  MemberGrant,
  Role,
} from '../contracts/domain.js';

/** Hard cap for one upload. Also enforced by the multipart parser and a database check. */
export const UPLOAD_MAX_BYTES = 8 * 1024 * 1024;

export type UploadKind = 'image' | 'file';

/**
 * Extensions we will store. Images render inline; everything else is downloaded as an attachment.
 * Executables, archives and active content (HTML, SVG, script) are absent on purpose.
 */
const EXTENSIONS: Record<
  string,
  {
    contentType: string;
    kind: UploadKind;
    family: 'image' | 'pdf' | 'text' | 'office';
  }
> = {
  png: { contentType: 'image/png', kind: 'image', family: 'image' },
  jpg: { contentType: 'image/jpeg', kind: 'image', family: 'image' },
  jpeg: { contentType: 'image/jpeg', kind: 'image', family: 'image' },
  gif: { contentType: 'image/gif', kind: 'image', family: 'image' },
  webp: { contentType: 'image/webp', kind: 'image', family: 'image' },
  pdf: { contentType: 'application/pdf', kind: 'file', family: 'pdf' },
  txt: { contentType: 'text/plain', kind: 'file', family: 'text' },
  md: { contentType: 'text/markdown', kind: 'file', family: 'text' },
  csv: { contentType: 'text/csv', kind: 'file', family: 'text' },
  json: { contentType: 'application/json', kind: 'file', family: 'text' },
  docx: {
    contentType:
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    kind: 'file',
    family: 'office',
  },
  xlsx: {
    contentType:
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    kind: 'file',
    family: 'office',
  },
  pptx: {
    contentType:
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    kind: 'file',
    family: 'office',
  },
};

export interface AcceptedUpload {
  filename: string;
  contentType: string;
  kind: UploadKind;
  byteSize: number;
}

export type InspectedUpload =
  { ok: true; file: AcceptedUpload } | { ok: false; reason: string };

const UPLOAD_ID = /^upl_[a-z0-9]{10,24}$/;
/** Workspace path stored in markdown and on an uploaded artifact. Slug-shaped, no query or host. */
const UPLOAD_URL =
  /^\/api\/w\/[a-z0-9][a-z0-9-]{0,39}\/uploads\/(upl_[a-z0-9]{10,24})$/;

export function isUploadId(id: string): boolean {
  return UPLOAD_ID.test(id);
}

/** True for a same-origin upload path. Remote and protocol-relative URLs are not. */
export function isWorkspaceUploadUrl(url: string | null | undefined): boolean {
  return !!url && UPLOAD_URL.test(url);
}

export function uploadPath(slug: string, id: string): string {
  return `/api/w/${slug}/uploads/${id}`;
}

/** Ids mentioned by a workspace upload path. The match is literal, so `_` in the id is not a wildcard. */
export function uploadIdsIn(text: string | null | undefined): string[] {
  if (!text) return [];
  const ids = new Set<string>();
  for (const match of text.matchAll(/\/uploads\/(upl_[a-z0-9]{10,24})\b/g))
    ids.add(match[1]);
  return [...ids];
}

export function markdownFor(
  kind: UploadKind,
  filename: string,
  path: string,
): string {
  const label =
    filename
      .replaceAll('[', ' ')
      .replaceAll(']', ' ')
      .replaceAll('\n', ' ')
      .replaceAll('\r', ' ')
      .trim() || 'file';
  return kind === 'image' ? `![${label}](${path})` : `[${label}](${path})`;
}

/** `inline` for images (so markdown can render them); everything else is a download. */
export function contentDisposition(kind: UploadKind, filename: string): string {
  const mode = kind === 'image' ? 'inline' : 'attachment';
  const ascii = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  return `${mode}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export function inspectUpload(input: {
  originalName: string;
  bytes: Buffer;
}): InspectedUpload {
  const byteSize = input.bytes.length;
  if (byteSize <= 0) return { ok: false, reason: 'The file is empty' };
  if (byteSize > UPLOAD_MAX_BYTES)
    return { ok: false, reason: 'File is larger than 8 MB' };
  const parsed = parseFilename(input.originalName);
  if (!parsed) return { ok: false, reason: 'This file type is not allowed' };
  const spec = EXTENSIONS[parsed.ext];
  if (!spec) return { ok: false, reason: 'This file type is not allowed' };
  if (looksExecutable(input.bytes))
    return {
      ok: false,
      reason: 'Executables and active content are not allowed',
    };
  if (!contentsMatch(spec.family, parsed.ext, input.bytes)) {
    return { ok: false, reason: 'The file contents do not match its type' };
  }
  return {
    ok: true,
    file: {
      filename: `${parsed.stem}.${parsed.ext}`,
      contentType: spec.contentType,
      kind: spec.kind,
      byteSize,
    },
  };
}

function stripControls(value: string): string {
  let out = '';
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (code >= 32 && code !== 127) out += ch;
  }
  return out;
}

function parseFilename(original: string): { stem: string; ext: string } | null {
  const base =
    stripControls(original).replaceAll('\\', '/').split('/').pop()?.trim() ??
    '';
  const cleaned = stripControls(base);
  const dot = cleaned.lastIndexOf('.');
  if (dot <= 0 || dot === cleaned.length - 1) return null;
  const ext = cleaned.slice(dot + 1).toLowerCase();
  const stem = cleaned
    .slice(0, dot)
    .replace(/[. ]+$/g, '')
    .slice(0, 120);
  if (!stem || !/^[a-z0-9]+$/.test(ext)) return null;
  return { stem, ext };
}

function contentsMatch(
  family: 'image' | 'pdf' | 'text' | 'office',
  ext: string,
  bytes: Buffer,
): boolean {
  if (family === 'pdf') return startsWith(bytes, [0x25, 0x50, 0x44, 0x46]);
  if (family === 'office') return isZip(bytes);
  if (family === 'image') return imageMatches(ext, bytes);
  return isPlainText(bytes);
}

function imageMatches(ext: string, bytes: Buffer): boolean {
  if (ext === 'png')
    return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (ext === 'jpg' || ext === 'jpeg')
    return startsWith(bytes, [0xff, 0xd8, 0xff]);
  if (ext === 'gif')
    return (
      startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
      startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
    );
  if (ext === 'webp') {
    return (
      bytes.length >= 12 &&
      bytes.toString('ascii', 0, 4) === 'RIFF' &&
      bytes.toString('ascii', 8, 12) === 'WEBP'
    );
  }
  return false;
}

function isZip(bytes: Buffer): boolean {
  return (
    startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) ||
    startsWith(bytes, [0x50, 0x4b, 0x05, 0x06]) ||
    startsWith(bytes, [0x50, 0x4b, 0x07, 0x08])
  );
}

/** Signatures of programs and bytecode. Checked even when the extension is on the allowlist. */
function looksExecutable(bytes: Buffer): boolean {
  if (startsWith(bytes, [0x4d, 0x5a])) return true;
  if (startsWith(bytes, [0x7f, 0x45, 0x4c, 0x46])) return true;
  if (
    startsWith(bytes, [0xfe, 0xed, 0xfa, 0xce]) ||
    startsWith(bytes, [0xfe, 0xed, 0xfa, 0xcf])
  )
    return true;
  if (
    startsWith(bytes, [0xce, 0xfa, 0xed, 0xfe]) ||
    startsWith(bytes, [0xcf, 0xfa, 0xed, 0xfe])
  )
    return true;
  if (startsWith(bytes, [0xca, 0xfe, 0xba, 0xbe])) return true;
  if (startsWith(bytes, [0x00, 0x61, 0x73, 0x6d])) return true;
  return false;
}

function isPlainText(bytes: Buffer): boolean {
  if (bytes.includes(0)) return false;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  const head = text.trimStart().slice(0, 64).toLowerCase();
  if (head.startsWith('#!')) return false;
  if (
    head.startsWith('<!doctype') ||
    head.startsWith('<html') ||
    head.startsWith('<script') ||
    head.startsWith('<svg') ||
    head.startsWith('<?xml') ||
    head.startsWith('<head')
  ) {
    return false;
  }
  return true;
}

function startsWith(bytes: Buffer, sig: number[]): boolean {
  if (bytes.length < sig.length) return false;
  return sig.every((b, i) => bytes[i] === b);
}

export interface UploadCaller {
  actor: ActorRef;
  role: Role;
  /** Set for a custom API token (possibly empty). Null for sessions and read/write/admin tokens. */
  permissions: readonly string[] | null;
}

/** A place the bytes are still mentioned. `projectScoped: false` is workspace-wide (a document comment). */
export interface UploadRef {
  resource: 'artifacts' | 'issues' | 'workstreams' | 'projects' | 'comments';
  projectScoped: boolean;
  projectId: string | null;
}

const API_READ: Record<UploadRef['resource'], string> = {
  artifacts: 'artifacts:read',
  issues: 'issues:read',
  workstreams: 'workstreams:read',
  projects: 'projects:read',
  comments: 'comments:read',
};

/** Grants that may stage a file into a description or a comment. Attaching an artifact is separate. */
const STAGE_GRANTS: readonly MemberGrant[] = [
  'issues:update',
  'workstreams:update',
  'projects:update',
  'comments:create',
  'comments:update',
  'artifacts:create',
];
const STAGE_PERMISSIONS = [
  'issues:write',
  'workstreams:write',
  'projects:write',
  'comments:write',
  'artifacts:write',
];

export function uploadVisible(
  ref: UploadRef,
  access: MemberAccess | null,
  permissions: readonly string[] | null,
): boolean {
  if (ref.projectScoped && projectHidden(access, ref.projectId)) return false;
  if (access && !access.grants.includes(`${ref.resource}:view`)) return false;
  if (permissions && !permissions.includes(API_READ[ref.resource]))
    return false;
  return true;
}

/** A description or comment upload. Full members pass; a narrowed person needs a write grant on one of those records. */
export function canStageUpload(
  caller: UploadCaller,
  access: MemberAccess | null,
): boolean {
  if (
    caller.permissions &&
    !STAGE_PERMISSIONS.some((p) => caller.permissions!.includes(p))
  )
    return false;
  if (access) return STAGE_GRANTS.some((g) => access.grants.includes(g));
  if (caller.permissions) return true;
  return hasRole(caller.role, 'member');
}

export function canAttachArtifact(
  caller: UploadCaller,
  access: MemberAccess | null,
): boolean {
  if (caller.permissions && !caller.permissions.includes('artifacts:write'))
    return false;
  if (access) return access.grants.includes('artifacts:create');
  if (caller.permissions) return true;
  return hasRole(caller.role, 'member');
}

export function sameActor(a: ActorRef, b: ActorRef): boolean {
  return a.type === b.type && !!a.id && a.id === b.id;
}
