import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { WorkspaceContext } from '../auth/request-context.js';
import {
  LABEL_NAME_MAX,
  LABEL_SWATCHES,
  LABEL_TEMPLATES,
  assignLabelIds,
  resolveLabelCatalog,
  type WorkspaceLabel,
} from '../contracts/domain.js';
import { uid } from '../common/util.js';
import { WorkspaceEntity } from '../database/entities/index.js';
import { EventsService } from '../events/events.service.js';

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

  async update(ctx: WorkspaceContext, id: string, patch: { name?: string; color?: string }): Promise<WorkspaceEntity> {
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
    const next = catalog.map((label) => (label.id === id ? { ...label, name, color, template: label.template || LABEL_TEMPLATES.some((t) => t.id === id) } : label));
    return this.save(ctx, next);
  }

  async remove(ctx: WorkspaceContext, id: string): Promise<WorkspaceEntity> {
    const catalog = resolveLabelCatalog(ctx.workspace.settings?.labels);
    const current = catalog.find((label) => label.id === id);
    if (!current) throw new BadRequestException(`Unknown label "${id}"`);
    if (current.template) throw new BadRequestException('Template labels cannot be removed');
    const ws = ctx.workspace;
    await this.ds.transaction(async (m) => {
      for (const table of TABLES) {
        await m.query(
          `UPDATE "${table}" SET "labels" = COALESCE((SELECT jsonb_agg(x) FROM jsonb_array_elements_text("labels") x WHERE x <> $2), '[]'::jsonb) WHERE "workspaceId" = $1 AND "labels" @> jsonb_build_array($2::text)`,
          [ws.id, id],
        );
      }
      const views = await m.query(`SELECT "id", "filters" FROM "saved_views" WHERE "workspaceId" = $1`, [ws.id]) as {
        id: string;
        filters: { field: string; op: string; value: string | string[] }[] | null;
      }[];
      for (const view of views) {
        if (!(view.filters ?? []).some((filter) => filter.field === 'labels')) continue;
        const filters = (view.filters ?? []).flatMap((filter) => {
          if (filter.field !== 'labels') return [filter];
          if (Array.isArray(filter.value)) {
            const value = filter.value.filter((item) => item !== id);
            return value.length ? [{ ...filter, value }] : [];
          }
          return filter.value === id ? [] : [filter];
        });
        await m.query(`UPDATE "saved_views" SET "filters" = $2::jsonb WHERE "id" = $1`, [view.id, JSON.stringify(filters)]);
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

function nextColor(catalog: readonly WorkspaceLabel[]): string {
  const used = new Set(catalog.map((label) => label.color));
  return LABEL_SWATCHES.find((color) => !used.has(color)) ?? LABEL_SWATCHES[catalog.length % LABEL_SWATCHES.length];
}
