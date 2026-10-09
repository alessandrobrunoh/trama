import { BadRequestException } from '@nestjs/common';
import { COMMENT_PAGE_SIZE } from '../contracts/domain.js';

/** Position of the last comment of a page: the next page starts strictly after it (older). */
export interface CommentCursor {
  /** createdAt, truncated to milliseconds (the precision of the cursor). */
  at: Date;
  id: string;
}

const CURSOR = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\|([A-Za-z0-9_-]{1,64})$/;

export function encodeCommentCursor(c: CommentCursor): string {
  return Buffer.from(`${c.at.toISOString()}|${c.id}`, 'utf8').toString('base64url');
}

/** Throws 400 for anything that was not produced by `encodeCommentCursor`. */
export function decodeCommentCursor(raw: string): CommentCursor {
  const invalid = () => new BadRequestException('cursor is not valid');
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(raw)) throw invalid();
  const m = CURSOR.exec(Buffer.from(raw, 'base64url').toString('utf8'));
  if (!m) throw invalid();
  const at = new Date(m[1]);
  if (Number.isNaN(at.getTime())) throw invalid();
  return { at, id: m[2] };
}

/** `undefined` -> default page size; otherwise an integer in [1, max], else 400. */
export function parseCommentLimit(limit: unknown): number {
  if (limit === undefined || limit === null) return COMMENT_PAGE_SIZE.default;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > COMMENT_PAGE_SIZE.max)
    throw new BadRequestException(`limit must be an integer between 1 and ${COMMENT_PAGE_SIZE.max}`);
  return limit;
}
