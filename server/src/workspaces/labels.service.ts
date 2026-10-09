import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import type { WorkspaceContext } from '../auth/request-context.js';
import {
  LABEL_NAME_MAX,
  LABEL_SWATCHES,
  LABEL_TEMPLATES,
  assignLabelIds,
  resolveLabelCatalog,
  type ViewFilter,
  type WorkspaceLabel,
} from '../contracts/domain.js';
import { uid } from '../common/util.js';
import { WorkspaceEntity } from '../database/entities/index.js';
import { EventsService } from '../events/events.service.js';
import { rewriteLabelFilters } from '../labels/label-filters.js';

const COLOR = /^#[0-9a-fA-F]{6}$/;
const CUSTOM_MAX = 100;
const TABLES = ['workstreams', 'issues', 'projects', 'repositories'] as const;

@Injectable()
export class LabelsService {
  constructor(
    private readonly ds: DataSource,
    private readonly events: EventsService,
  ) {}

  /** Catalog ids, de-duplicated. `undefined` when the caller did not send labels. */
  async assign(workspaceId: string, ids: readonly string[] | null | undefined): Promise<string[] | undefined> {
    if (ids === undefined) return undefined;
    const ws = await this.ds.getRepository(WorkspaceEntity).findOneBy({ id: workspaceId });
    try {
      return assignLabelIds(resolveLabelCatalog(ws?.settings?.labels), ids ?? []);
    } catch (err) {
      throw new BadRequestException(err instanceof Error ? err.message : 'Invalid labels');
    }
  }

  async create(ctx: WorkspaceContext, input: { name: string; color?: string }): Promise<WorkspaceEntity> {
    const name = input.name.trim();
    if (!name || name.length > LABEL_NAME_MAX) throw new BadRequestException(`Label name must be 1-${LABEL_NAME_MAX} characters`);
    const catalog = resolveLabelCatalog(ctx.workspace.settings?.labels);
    if (catalog.some((label) => label.name.toLowerCase() === name.toLowerCase()))
      throw new ConflictException(`Label "${name}" already exists`);
    if (catalog.filter((label) => !label.template).length >= CUSTOM_MAX)
      throw new BadRequestException(`A workspace can have at most ${CUSTOM_MAX} custom labels`);
    const color = (input.color ?? nextColor(catalog)).toLowerCase();
    if (!COLOR.test(color)) throw new BadRequestException('color must be #rrggbb');
    return this.save(ctx, [...catalog, { id: uid('lb'), name, color, template: false }]);
  }

  async update(ctx: WorkspaceContext, id: string, patch: { name?: string; color?: string; archived?: boolean }): Promise<WorkspaceEntity> {
    const catalog = resolveLabelCatalog(ctx.workspace.settings?.labels);
    const current = catalog.find((label) => label.id === id);
    if (!current) throw new BadRequestException(`Unknown label "${id}"`);
    let name = current.name;
    if (patch.name !== undefined) {
      name = patch.name.trim();
      if (!name || name.length > LABEL_NAME_MAX) throw new BadRequestException(`Label name must be 1-${LABEL_NAME_MAX} characters`);
      if (current.template && name !== current.name) throw new BadRequestException('Template labels cannot be renamed');
      if (catalog.some((label) => label.id !== id && label.name.toLowerCase() === name.toLowerCase()))
        throw new ConflictException(`Label "${name}" already exists`);
    }
    let color = current.color;
    if (patch.color !== undefined) {
      color = patch.color.toLowerCase();
      if (!COLOR.test(color)) throw new BadRequestException('color must be #rrggbb');
    }
    if (patch.archived === true && current.template) throw new BadRequestException('Template labels cannot be archived');
    const archived = patch.archived ?? current.archived === true;
    const next = catalog.map((label): WorkspaceLabel => {
      if (label.id !== id) return label;
      const template = label.template || LABEL_TEMPLATES.some((t) => t.id === id);
      return archived && !template ? { id, name, color, template, archived: true } : { id, name, color, template };
    });
    return this.save(ctx, next);
  }

  /** Move every assignment of `id` onto `into`, then drop `id`. Templates cannot be merged away. */
  async merge(ctx: WorkspaceContext, id: string, into: string): Promise<WorkspaceEntity> {
    const catalog = resolveLabelCatalog(ctx.workspace.settings?.labels);
    const current = catalog.find((label) => label.id === id);
    if (!current) throw new BadRequestException(`Unknown label "${id}"`);
    if (current.template) throw new BadRequestException('Template labels cannot be merged into another label');
    const target = catalog.find((label) => label.id === into);
    if (!target) throw new BadRequestException(`Unknown label "${into}"`);
    if (target.id === id) throw new BadRequestException('A label cannot be merged into itself');
    if (target.archived) throw new BadRequestException(`Label "${target.name}" is archived. Restore it before merging into it`);
    return this.drop(ctx, catalog, id, into);
  }

  async remove(ctx: WorkspaceContext, id: string): Promise<WorkspaceEntity> {
    const catalog = resolveLabelCatalog(ctx.workspace.settings?.labels);
    const current = catalog.find((label) => label.id === id);
    if (!current) throw new BadRequestException(`Unknown label "${id}"`);
    if (current.template) throw new BadRequestException('Template labels cannot be removed');
    return this.drop(ctx, catalog, id, null);
  }

  /** Replace `id` by `into` (or remove it) on every record and saved view, then take it out of the catalog. One transaction. */
  private async drop(ctx: WorkspaceContext, catalog: readonly WorkspaceLabel[], id: string, into: string | null): Promise<WorkspaceEntity> {
    const ws = ctx.workspace;
    await this.ds.transaction(async (m) => {
      for (const table of TABLES) await replaceInTable(m, table, ws.id, id, into);
      const views = (await m.query(`SELECT "id", "filters" FROM "saved_views" WHERE "workspaceId" = $1`, [ws.id])) as {
        id: string;
        filters: ViewFilter[] | null;
      }[];
      for (const view of views) {
        const filters = rewriteLabelFilters(view.filters, id, into);
        if (filters) await m.query(`UPDATE "saved_views" SET "filters" = $2::jsonb WHERE "id" = $1`, [view.id, JSON.stringify(filters)]);
      }
      ws.settings = { ...ws.settings, labels: catalog.filter((label) => label.id !== id) };
      await m.save(WorkspaceEntity, ws);
    });
    this.events.publish(ws.id, { type: 'updated', entity: 'workspace', id: ws.id });
    return ws;
  }

  private async save(ctx: WorkspaceContext, labels: WorkspaceLabel[]): Promise<WorkspaceEntity> {
    const ws = ctx.workspace;
    ws.settings = { ...ws.settings, labels };
    const saved = await this.ds.getRepository(WorkspaceEntity).save(ws);
    this.events.publish(ws.id, { type: 'updated', entity: 'workspace', id: ws.id });
    return saved;
  }
}

/** Rewrites the `labels` array of the records that carry `from`: swap for `into` (no duplicates, order kept) or remove. */
async function replaceInTable(m: EntityManager, table: (typeof TABLES)[number], workspaceId: string, from: string, into: string | null): Promise<void> {
  await m.query(
    `UPDATE "${table}" SET "labels" = COALESCE((
       SELECT jsonb_agg(d.x ORDER BY d.ord) FROM (
         SELECT DISTINCT ON (r.x) r.x, r.ord FROM (
           SELECT CASE WHEN e.v = $2 THEN $3 ELSE e.v END AS x, e.ord
           FROM jsonb_array_elements_text("labels") WITH ORDINALITY AS e(v, ord)
         ) r WHERE r.x IS NOT NULL ORDER BY r.x, r.ord
       ) d
     ), '[]'::jsonb)
     WHERE "workspaceId" = $1 AND "labels" @> jsonb_build_array($2::text)`,
    [workspaceId, from, into],
  );
}

function nextColor(catalog: readonly WorkspaceLabel[]): string {
  const used = new Set(catalog.map((label) => label.color));
  return LABEL_SWATCHES.find((color) => !used.has(color)) ?? LABEL_SWATCHES[catalog.length % LABEL_SWATCHES.length];
}
