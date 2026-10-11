import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { WorkspaceContext } from '../auth/request-context.js';
import { uid } from '../common/util.js';
import {
  STATUS_CATALOG_KEY,
  STATUS_COLOR,
  STATUS_NAME_MAX,
  isStatusIcon,
  isStatusSubject,
  resolveStatusCatalog,
  statusStoredValues,
  statusTypeLabel,
  statusTypes,
  type StatusCatalog,
  type StatusEntry,
  type StatusSubject,
} from '../contracts/domain.js';
import { WorkspaceEntity } from '../database/entities/index.js';
import { EventsService } from '../events/events.service.js';

const CUSTOM_MAX = 50;

const COLUMNS: Record<StatusSubject, { table: string; column: string }[]> = {
  issue: [{ table: 'issues', column: 'status' }],
  workstream: [
    { table: 'workstreams', column: 'status' },
    { table: 'workstreams', column: 'statusOverride' },
    { table: 'workstreams', column: 'derivedStatus' },
  ],
  project: [{ table: 'projects', column: 'status' }],
  decision: [{ table: 'decisions', column: 'status' }],
  project_health: [
    { table: 'projects', column: 'health' },
    { table: 'project_updates', column: 'health' },
  ],
  delivery: [{ table: 'workstreams', column: 'delivery' }],
  criterion: [],
};

export interface StatusInput {
  name?: string;
  icon: string;
  color: string;
  type: string;
}

export interface StatusPatch {
  name?: string;
  icon?: string;
  color?: string;
}

@Injectable()
export class StatusesService {
  constructor(
    private readonly ds: DataSource,
    private readonly events: EventsService,
  ) {}

  catalog(ctx: WorkspaceContext): StatusCatalog {
    return resolveStatusCatalog(ctx.workspace.settings?.statuses);
  }

  async create(ctx: WorkspaceContext, subject: string, input: StatusInput): Promise<WorkspaceEntity> {
    const key = this.subject(subject);
    if (!statusTypes(key).includes(input.type)) throw new BadRequestException(`Unknown ${key} status type \"${input.type}\"`);
    const catalog = this.catalog(ctx);
    const entries = catalog[STATUS_CATALOG_KEY[key]];
    const explicit = input.name?.trim();
    const name = explicit ? this.name(explicit, entries) : this.uniqueName(statusTypeLabel(key, input.type), entries);
    const icon = this.icon(input.icon);
    const color = this.color(input.color);
    if (entries.filter((entry) => entry.id !== entry.type).length >= CUSTOM_MAX)
      throw new BadRequestException(`A workspace can have at most ${CUSTOM_MAX} extra ${STATUS_CATALOG_KEY[key]} statuses`);
    const next = [...entries, { id: uid('st'), name, icon, color, type: input.type }];
    return this.save(ctx, catalog, key, next);
  }

  async update(ctx: WorkspaceContext, subject: string, id: string, patch: StatusPatch): Promise<WorkspaceEntity> {
    const key = this.subject(subject);
    const catalog = this.catalog(ctx);
    const entries = catalog[STATUS_CATALOG_KEY[key]];
    const current = entries.find((entry) => entry.id === id);
    if (!current) throw new BadRequestException(`Unknown status "${id}"`);
    const name = patch.name !== undefined ? this.name(patch.name, entries, id) : current.name;
    const icon = patch.icon !== undefined ? this.icon(patch.icon) : current.icon;
    const color = patch.color !== undefined ? this.color(patch.color) : current.color;
    const next = entries.map((entry) => (entry.id === id ? { ...entry, name, icon, color } : entry));
    return this.save(ctx, catalog, key, next);
  }

  async remove(ctx: WorkspaceContext, subject: string, id: string): Promise<WorkspaceEntity> {
    const key = this.subject(subject);
    const catalog = this.catalog(ctx);
    const entries = catalog[STATUS_CATALOG_KEY[key]];
    const current = entries.find((entry) => entry.id === id);
    if (!current) throw new BadRequestException(`Unknown status "${id}"`);
    if (entries.filter((entry) => entry.type === current.type).length <= 1)
      throw new BadRequestException(`Keep at least one ${statusTypeLabel(key, current.type)} status`);
    const used = await this.usage(ctx.workspace.id, key, current, entries);
    if (used > 0)
      throw new ConflictException(`Can't remove "${current.name}" while ${used} ${used === 1 ? 'record still uses' : 'records still use'} it`);
    return this.save(ctx, catalog, key, entries.filter((entry) => entry.id !== id));
  }

  private subject(value: string): StatusSubject {
    if (!isStatusSubject(value)) throw new BadRequestException(`Unknown status subject "${value}"`);
    return value;
  }

  private name(value: string, entries: readonly StatusEntry[], exceptId?: string): string {
    const name = value.trim();
    if (!name || name.length > STATUS_NAME_MAX) throw new BadRequestException(`Status name must be 1-${STATUS_NAME_MAX} characters`);
    if (entries.some((entry) => entry.id !== exceptId && entry.name.toLowerCase() === name.toLowerCase()))
      throw new ConflictException(`Status \"${name}\" already exists`);
    return name;
  }

  /** When the caller does not name the status, keep it distinct from the ones already in the catalog. */
  private uniqueName(base: string, entries: readonly StatusEntry[]): string {
    const trimmed = base.trim() || 'Status';
    let name = trimmed.slice(0, STATUS_NAME_MAX);
    let n = 2;
    while (entries.some((entry) => entry.name.toLowerCase() === name.toLowerCase())) {
      const suffix = ` ${n}`;
      name = `${trimmed.slice(0, STATUS_NAME_MAX - suffix.length)}${suffix}`;
      n += 1;
      if (n > CUSTOM_MAX) throw new ConflictException(`Status \"${trimmed}\" already exists`);
    }
    return name;
  }

  private icon(value: string): string {
    const icon = value.trim();
    if (!isStatusIcon(icon)) throw new BadRequestException('icon must be a lucide icon name (kebab-case) or a single emoji');
    return icon;
  }

  private color(value: string): string {
    const color = value.trim().toLowerCase();
    if (!STATUS_COLOR.test(color)) throw new BadRequestException('color must be #rrggbb');
    return color;
  }

  private async usage(workspaceId: string, subject: StatusSubject, entry: StatusEntry, entries: readonly StatusEntry[]): Promise<number> {
    const values = statusStoredValues(entry, entries);
    let total = 0;
    for (const place of COLUMNS[subject]) total += await this.count(place.table, place.column, workspaceId, values);
    if (subject === 'criterion') {
      const rows = (await this.ds.query(
        `SELECT COUNT(*)::int AS n FROM "workstreams" w
         WHERE w."workspaceId" = $1 AND EXISTS (
           SELECT 1 FROM jsonb_array_elements(w."acceptanceCriteria") c WHERE c->>'state' = ANY($2::text[])
         )`,
        [workspaceId, values],
      )) as { n: number }[];
      total += Number(rows[0]?.n ?? 0);
    }
    return total;
  }

  private async count(table: string, column: string, workspaceId: string, values: readonly string[]): Promise<number> {
    const rows = (await this.ds.query(
      `SELECT COUNT(*)::int AS n FROM "${table}" WHERE "workspaceId" = $1 AND "${column}" = ANY($2::text[])`,
      [workspaceId, values],
    )) as { n: number }[];
    return Number(rows[0]?.n ?? 0);
  }

  private async save(
    ctx: WorkspaceContext,
    catalog: StatusCatalog,
    subject: StatusSubject,
    entries: readonly StatusEntry[],
  ): Promise<WorkspaceEntity> {
    const ws = ctx.workspace;
    const statuses: StatusCatalog = { ...catalog, [STATUS_CATALOG_KEY[subject]]: entries };
    ws.settings = { ...ws.settings, statuses };
    const saved = await this.ds.getRepository(WorkspaceEntity).save(ws);
    this.events.publish(ws.id, { type: 'updated', entity: 'workspace', id: ws.id });
    return saved;
  }
}
