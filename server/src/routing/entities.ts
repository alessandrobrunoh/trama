import { Column, Entity, ForeignKey, Index, PrimaryColumn } from 'typeorm';
import type { ActorRef, GitProvider, RoutingDirection, RoutingFilters } from '../contracts/domain.js';
import {
  IntegrationConnectionEntity,
  IssueEntity,
  ProjectEntity,
  WorkspaceEntity,
} from '../database/entities/index.js';
import { Wire } from '../database/entities/wire.js';

/**
 * Where work from one external source goes. The case-insensitive uniqueness of
 * (workspace, provider, host, source path, filters) is a unique index created by the migration on
 * lower() expressions; overlaps between different filters are checked by the service.
 */
@Entity('routing_rules')
@Index('IDX_routing_rules_project', ['projectId'])
@Index('IDX_routing_rules_connection', ['connectionId'])
@ForeignKey(() => WorkspaceEntity, ['workspaceId'], ['id'], { onDelete: 'CASCADE' })
@ForeignKey(() => ProjectEntity, ['projectId'], ['id'], { onDelete: 'CASCADE' })
@ForeignKey(() => IntegrationConnectionEntity, ['connectionId'], ['id'], { onDelete: 'SET NULL' })
export class RoutingRuleEntity extends Wire {
  /** `rr_…` */
  @PrimaryColumn({ type: 'varchar' }) id: string;
  @Column({ type: 'varchar' }) workspaceId: string;
  @Column({ type: 'varchar' }) projectId: string;
  /** Null once the connection was removed: the rule then shows an error instead of stopping silently. */
  @Column({ type: 'varchar', nullable: true }) connectionId: string | null;
  @Column({ type: 'varchar' }) provider: GitProvider;
  /** Lower-case host (`github.com`, or the self-hosted instance). */
  @Column({ type: 'varchar' }) host: string;
  /** `owner/name`, or a group path ending with `/*`. */
  @Column({ type: 'varchar', length: 2048 }) sourcePath: string;
  @Column({ type: 'jsonb', default: () => `'{}'` }) filters: RoutingFilters;
  /** Canonical text of `filters` (see source-path.ts), part of the unique index. */
  @Column({ type: 'varchar', length: 1024, default: '' }) filterKey: string;
  @Column({ type: 'varchar', default: 'inbound' }) direction: RoutingDirection;
  @Column({ type: 'jsonb' }) createdBy: ActorRef;
  /** The `projects.repository` value this rule was created from by the migration. */
  @Column({ type: 'varchar', length: 2048, nullable: true }) migratedFrom: string | null;
  @Column({ type: 'timestamptz', default: () => 'now()' }) createdAt: Date;
  @Column({ type: 'timestamptz', default: () => 'now()' }) updatedAt: Date;
  @Column({ type: 'timestamptz', nullable: true }) lastSyncAt: Date | null;
  @Column({ type: 'text', nullable: true }) lastError: string | null;
}

export type RoutedItemKind = 'issue' | 'pull_request';

/**
 * An external issue or pull request a rule placed in Trama. It makes ingestion idempotent (a redelivered
 * webhook never creates a second task), gives a rule its task count, and tells two-way sync which
 * external issue a task mirrors.
 */
@Entity('routing_rule_items')
@Index('IDX_routing_rule_items_rule', ['ruleId', 'createdAt'])
@Index('IDX_routing_rule_items_issue', ['issueId'])
@Index(
  'UQ_routing_rule_items_external',
  ['workspaceId', 'provider', 'host', 'repository', 'kind', 'externalId'],
  { unique: true },
)
@ForeignKey(() => WorkspaceEntity, ['workspaceId'], ['id'], { onDelete: 'CASCADE' })
@ForeignKey(() => RoutingRuleEntity, ['ruleId'], ['id'], { onDelete: 'SET NULL' })
@ForeignKey(() => IssueEntity, ['issueId'], ['id'], { onDelete: 'SET NULL' })
export class RoutingRuleItemEntity extends Wire {
  @PrimaryColumn({ type: 'varchar' }) id: string;
  @Column({ type: 'varchar' }) workspaceId: string;
  @Column({ type: 'varchar', nullable: true }) ruleId: string | null;
  @Column({ type: 'varchar' }) provider: GitProvider;
  @Column({ type: 'varchar' }) host: string;
  /** Lower-case `owner/name` of the repository the item lives in. */
  @Column({ type: 'varchar', length: 2048 }) repository: string;
  @Column({ type: 'varchar' }) kind: RoutedItemKind;
  /** `#12` (issues, GitHub pull requests) or `!7` (GitLab merge requests). */
  @Column({ type: 'varchar' }) externalId: string;
  /** The task created for it; null while being created or after the task was deleted. */
  @Column({ type: 'varchar', nullable: true }) issueId: string | null;
  @Column({ type: 'varchar', length: 2048, nullable: true }) url: string | null;
  /** The external state last seen or last written by Trama (`open` / `closed`), to avoid echoes. */
  @Column({ type: 'varchar', nullable: true }) externalState: 'open' | 'closed' | null;
  @Column({ type: 'timestamptz', default: () => 'now()' }) createdAt: Date;
}

export const ROUTING_ENTITIES = [RoutingRuleEntity, RoutingRuleItemEntity];
