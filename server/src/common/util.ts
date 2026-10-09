import { randomBytes } from 'node:crypto';
import { NotFoundException } from '@nestjs/common';

/** Opaque prefixed id, e.g. `wk_k3j9x0a1b2c3`. */
export function uid(prefix: string): string {
  const rand = randomBytes(9).toString('base64url').replace(/[-_]/g, 'x');
  return `${prefix}_${rand.toLowerCase()}`;
}

export function notFound(entity: string, id: string): NotFoundException {
  return new NotFoundException(`${entity} "${id}" not found`);
}

/** Drops keys whose value is `undefined` so partial DTOs can be Object.assign-ed safely. */
export function definedOnly<T extends object>(input: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

export function unique<T>(items: readonly T[] | null | undefined): T[] {
  return [...new Set(items ?? [])];
}

/** Parses an ISO string / Date; `null` stays `null`, `undefined` stays `undefined`. */
export function toDate(value: string | Date | null | undefined): Date | null | undefined {
  if (value === null || value === undefined) return value;
  return value instanceof Date ? value : new Date(value);
}

/** True for a Postgres unique-constraint violation (SQLSTATE 23505), as thrown through TypeORM. */
export function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: unknown; driverError?: { code?: unknown } } | null;
  return err?.code === '23505' || err?.driverError?.code === '23505';
}
