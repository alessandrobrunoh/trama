import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { WorkspaceContext } from '../auth/request-context.js';
import {
  CUSTOMER_TIERS_MAX,
  CUSTOMER_TIER_NAME_MAX,
  LABEL_SWATCHES,
  resolveCustomerTiers,
  type CustomerTier,
} from '../contracts/domain.js';
import { uid } from '../common/util.js';
import { CustomerEntity, WorkspaceEntity } from '../database/entities/index.js';
import { EventsService } from '../events/events.service.js';

const COLOR = /^#[0-9a-fA-F]{6}$/;

/** Customer tiers live in the workspace settings and are assigned to customers by id. */
@Injectable()
export class CustomerTiersService {
  constructor(
    private readonly ds: DataSource,
    private readonly events: EventsService,
  ) {}

  async create(ctx: WorkspaceContext, input: { name: string; color?: string }): Promise<WorkspaceEntity> {
    const name = this.name(input.name);
    const tiers = resolveCustomerTiers(ctx.workspace.settings?.customerTiers);
    if (tiers.some((t) => t.name.toLowerCase() === name.toLowerCase())) {
      throw new ConflictException(`Tier "${name}" already exists`);
    }
    if (tiers.length >= CUSTOMER_TIERS_MAX) {
      throw new BadRequestException(`A workspace can have at most ${CUSTOMER_TIERS_MAX} customer tiers`);
    }
    const color = (input.color ?? nextColor(tiers)).toLowerCase();
    if (!COLOR.test(color)) throw new BadRequestException('color must be #rrggbb');
    return this.save(ctx, [...tiers, { id: uid('ct'), name, color }]);
  }

  async update(ctx: WorkspaceContext, id: string, patch: { name?: string; color?: string }): Promise<WorkspaceEntity> {
    const tiers = resolveCustomerTiers(ctx.workspace.settings?.customerTiers);
    const current = tiers.find((t) => t.id === id);
    if (!current) throw new BadRequestException(`Unknown customer tier "${id}"`);
    let name = current.name;
    if (patch.name !== undefined) {
      name = this.name(patch.name);
      if (tiers.some((t) => t.id !== id && t.name.toLowerCase() === name.toLowerCase())) {
        throw new ConflictException(`Tier "${name}" already exists`);
      }
    }
    let color = current.color;
    if (patch.color !== undefined) {
      color = patch.color.toLowerCase();
      if (!COLOR.test(color)) throw new BadRequestException('color must be #rrggbb');
    }
    return this.save(ctx, tiers.map((t) => (t.id === id ? { id, name, color } : t)));
  }

  /** Removes the tier; customers that had it are left without a tier. */
  async remove(ctx: WorkspaceContext, id: string): Promise<WorkspaceEntity> {
    const tiers = resolveCustomerTiers(ctx.workspace.settings?.customerTiers);
    if (!tiers.some((t) => t.id === id)) throw new BadRequestException(`Unknown customer tier "${id}"`);
    const ws = ctx.workspace;
    await this.ds.transaction(async (m) => {
      await m
        .getRepository(CustomerEntity)
        .update({ workspaceId: ws.id, tierId: id }, { tierId: null, updatedAt: new Date() });
      ws.settings = { ...ws.settings, customerTiers: tiers.filter((t) => t.id !== id) };
      await m.save(WorkspaceEntity, ws);
    });
    this.events.publish(ws.id, { type: 'updated', entity: 'workspace', id: ws.id });
    return ws;
  }

  private name(input: string): string {
    const name = input.trim();
    if (!name || name.length > CUSTOMER_TIER_NAME_MAX) {
      throw new BadRequestException(`Tier name must be 1-${CUSTOMER_TIER_NAME_MAX} characters`);
    }
    return name;
  }

  private async save(ctx: WorkspaceContext, customerTiers: CustomerTier[]): Promise<WorkspaceEntity> {
    const ws = ctx.workspace;
    ws.settings = { ...ws.settings, customerTiers };
    const saved = await this.ds.getRepository(WorkspaceEntity).save(ws);
    this.events.publish(ws.id, { type: 'updated', entity: 'workspace', id: ws.id });
    return saved;
  }
}

function nextColor(tiers: readonly CustomerTier[]): string {
  const used = new Set(tiers.map((t) => t.color));
  return LABEL_SWATCHES.find((c) => !used.has(c)) ?? LABEL_SWATCHES[tiers.length % LABEL_SWATCHES.length];
}
