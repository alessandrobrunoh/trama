import { BadRequestException } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import {
  resolveStatusCatalog,
  resolveStatusEntry,
  type StatusCatalog,
  type StatusEntry,
} from '../contracts/domain.js';
import { WorkspaceEntity } from '../database/entities/index.js';

/** The workspace catalog, or today's seeds when settings are missing or the lookup itself fails. */
export async function loadStatusCatalog(ds: DataSource, workspaceId: string): Promise<StatusCatalog> {
  try {
    if (typeof ds.getRepository !== 'function') return resolveStatusCatalog(null);
    const ws = await ds.getRepository(WorkspaceEntity).findOneBy({ id: workspaceId });
    return resolveStatusCatalog(ws?.settings?.statuses);
  } catch {
    return resolveStatusCatalog(null);
  }
}

export function requireStatus<T extends string>(
  entries: readonly StatusEntry<T>[],
  stored: string,
  label = 'status',
): StatusEntry<T> {
  const entry = resolveStatusEntry(entries, stored);
  if (!entry) throw new BadRequestException(`Unknown ${label} "${stored}"`);
  return entry;
}

/** Ids a status filter matches: the resolved entry, plus the raw value when it is still a legacy enum. */
export function statusFilterIds<T extends string>(entries: readonly StatusEntry<T>[], stored: string): string[] {
  const entry = resolveStatusEntry(entries, stored);
  if (!entry) return [stored];
  return entry.id === stored ? [entry.id] : [entry.id, stored];
}
