import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import { canDo } from '../auth/request-context.js';
import type { IntegrationConnection, UsableConnection } from '../contracts/domain.js';
import { IntegrationConnectionEntity, MembershipEntity, WorkspaceEntity } from '../database/entities/index.js';
import { IntegrationsService } from './integrations.service.js';

/**
 * Marks which of the connections a person can pick for the same provider and host is the one to
 * preselect: the workspace's (it outlives people) when there is one, else the only one there is.
 * Pure, so the rule is easy to test.
 */
export function markSuggested(connections: IntegrationConnection[]): UsableConnection[] {
  const groups = new Map<string, IntegrationConnection[]>();
  for (const c of connections) {
    const key = `${c.provider}\n${c.host}`;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  return connections.map((c) => {
    const healthy = groups.get(`${c.provider}\n${c.host}`)!.filter((g) => g.status === 'connected');
    const workspaceOnes = healthy.filter((g) => g.ownerType === 'workspace');
    const suggested = c.status === 'connected' && (workspaceOnes.length ? c.ownerType === 'workspace' : healthy.length === 1);
    return { ...c, suggested };
  });
}

/**
 * Who may use which connection. This is what routing rules read: they never look at owners
 * themselves, they ask for the connections a person may pick, and read `status` to know whether one
 * still works.
 */
@Injectable()
export class ConnectionsService {
  constructor(
    private readonly integrations: IntegrationsService,
    @InjectRepository(IntegrationConnectionEntity) private readonly repo: Repository<IntegrationConnectionEntity>,
    @InjectRepository(MembershipEntity) private readonly memberships: Repository<MembershipEntity>,
    @InjectRepository(WorkspaceEntity) private readonly workspaces: Repository<WorkspaceEntity>,
  ) {}

  /**
   * The connections `userId` may pick for a rule on a project of `workspaceId`: their own personal
   * ones, plus the workspace's when their role has the integrations permission. Empty for someone who
   * is not a member. Revoked connections are left out (they cannot read anything); `error` ones stay,
   * with their status, so the UI can say why they are not preselected.
   *
   * `suggested` is true on the workspace connection when both a workspace and a personal one reach the
   * same provider and host, so work does not depend on one person's token; with no workspace
   * connection, on the only candidate. Tokens are never part of the result.
   */
  async usableFor(userId: string, workspaceId: string): Promise<UsableConnection[]> {
    const membership = await this.memberships.findOneBy({ userId, workspaceId });
    if (!membership) return [];
    const workspace = await this.workspaces.findOneBy({ id: workspaceId });
    const mayUseWorkspace = !!workspace && canDo({ role: membership.role, workspace }, 'manageIntegrations');

    const rows = [
      ...(mayUseWorkspace
        ? await this.repo.find({ where: { ownerType: 'workspace', workspaceId }, order: { createdAt: 'ASC' } })
        : []),
      ...(await this.repo.find({ where: { ownerType: 'user', ownerUserId: userId }, order: { createdAt: 'ASC' } })),
    ].filter((r) => r.status !== 'revoked');
    return markSuggested(await this.integrations.summarize(rows));
  }
}
