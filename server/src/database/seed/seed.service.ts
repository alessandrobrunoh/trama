import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import * as argon2 from 'argon2';
import { DataSource, type EntityTarget, type EntityManager, type ObjectLiteral } from 'typeorm';
import {
  AgentEntity,
  ArtifactEntity,
  CommentEntity,
  DecisionEntity,
  DependencyEntity,
  DomainEventEntity,
  ENTITIES,
  InputRequestEntity,
  IssueEntity,
  IntegrationConnectionEntity,
  MembershipEntity,
  MilestoneEntity,
  ProjectEntity,
  RepositoryEntity,
  SavedViewEntity,
  TeamEntity,
  UserEntity,
  WorkspaceCounterEntity,
  WorkspaceEntity,
} from '../entities/index.js';
import { DEMO_PASSWORD, createSeed } from './seed-data.js';

@Injectable()
export class SeedService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SeedService.name);

  constructor(
    private readonly ds: DataSource,
  ) {}

  /** Seeds the demo workspace into an empty database (never in production, off with SEED_DEMO=false). */
  async onApplicationBootstrap(): Promise<void> {
    if (process.env.NODE_ENV === 'production' || process.env.SEED_DEMO === 'false') return;
    if ((await this.ds.getRepository(UserEntity).count()) > 0) return;
    await this.reset();
    this.logger.log('Empty database: seeded demo workspace "Acme" (demo@trama.dev / trama-demo)');
  }

  /** Wipes every table and re-inserts the demo workspace (dates relative to now). */
  async reset(): Promise<void> {
    const passwordHash = await argon2.hash(DEMO_PASSWORD);
    const data = createSeed(Date.now(), passwordHash, { mockHistory: process.env.SEED_MOCK_HISTORY !== 'false' });
    await this.ds.transaction(async (m) => {
      const tables = ENTITIES.map((e) => `"${this.ds.getMetadata(e).tableName}"`);
      await m.query(`TRUNCATE "legacy_workstream_history", ${tables.join(', ')} CASCADE`);
      await insert(m, UserEntity, data.users);
      await insert(m, WorkspaceEntity, [data.workspace]);
      await insert(m, MembershipEntity, data.memberships);
      await insert(m, AgentEntity, data.agents);
      await insert(m, TeamEntity, data.teams);
      await insert(m, RepositoryEntity, data.repositories);
      await insert(m, ProjectEntity, data.projects);
      for (const row of data.legacyWorkstreams)
        await m.query(
          `INSERT INTO "legacy_workstream_history" ("id", "key", "title", "objective")
           VALUES ($1, $2, $3, $4)`,
          [row.id, row.key, row.title, row.objective],
        );
      await insert(m, MilestoneEntity, data.milestones);
      await insert(m, InputRequestEntity, data.inputRequests);
      await insert(m, IssueEntity, data.issues);
      await insert(m, ArtifactEntity, data.artifacts);
      await insert(m, DecisionEntity, data.decisions);
      await insert(m, DependencyEntity, data.dependencies);
      await insert(m, CommentEntity, data.comments);
      await insert(m, DomainEventEntity, data.events);
      await insert(m, SavedViewEntity, data.views);
      await insert(m, IntegrationConnectionEntity, data.integrations);
      await insert(
        m,
        WorkspaceCounterEntity,
        Object.entries(data.counters).map(([name, value]) => ({ workspaceId: data.workspace.id, name, value })),
      );
    });
  }
}

async function insert<T extends ObjectLiteral>(m: EntityManager, target: EntityTarget<T>, rows: object[]): Promise<void> {
  for (let i = 0; i < rows.length; i += 200) await m.insert(target, rows.slice(i, i + 200) as never);
}
