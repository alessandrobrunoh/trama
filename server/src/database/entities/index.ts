import {
  Column,
  Entity,
  ForeignKey,
  Index,
  PrimaryColumn,
} from 'typeorm';
import type {
  AcceptanceCriterion,
  ActorRef,
  ArtifactKind,
  ArtifactProvider,
  ArtifactState,
  CiState,
  DecisionStatus,
  DependencyNodeType,
  ExecutionProvider,
  GitProvider,
  InputRequestState,
  IssueKind,
  IssueSource,
  IssueStatus,
  Priority,
  ReviewState,
  Role,
  SavedView,
  SubjectRef,
  TeamEditPolicy,
  TokenScope,
  ViewEntity,
  ViewFilter,
  ViewLayout,
  WorkspaceSettings,
  WorkstreamStatus,
} from '../../contracts/domain.js';
import { resolveWorkspaceSettings } from '../../contracts/domain.js';
import { Wire } from './wire.js';

export { Wire };

const NOW = () => 'now()';
const EMPTY_ARRAY = () => "'[]'";
const EMPTY_OBJECT = () => "'{}'";

// ───────────────────────────── identity ─────────────────────────────

@Entity('users')
export class UserEntity extends Wire {
  @PrimaryColumn({ type: 'varchar' }) id: string;
  @Column({ type: 'varchar' }) name: string;
  /** Stored lower-cased. */
  @Index('UQ_users_email', { unique: true })
  @Column({ type: 'varchar' })
  email: string;
  @Column({ type: 'varchar' }) passwordHash: string;
  @Column({ type: 'integer', default: 0 }) avatarHue: number;
  @Column({ type: 'timestamptz', default: NOW }) createdAt: Date;

  protected override hidden() {
    return ['passwordHash'];
  }
}

/** Cookie session. `id` is the sha256 of the cookie value (the raw value is never stored). */
@Entity('sessions')
@ForeignKey(() => UserEntity, ['userId'], ['id'], { onDelete: 'CASCADE' })
export class SessionEntity {
  @PrimaryColumn({ type: 'varchar' }) id: string;
  @Index('IDX_sessions_user')
  @Column({ type: 'varchar' })
  userId: string;
  @Column({ type: 'timestamptz' }) expiresAt: Date;
  @Column({ type: 'varchar', nullable: true }) userAgent: string | null;
  @Column({ type: 'timestamptz', default: NOW }) createdAt: Date;
}

@Entity('workspaces')
export class WorkspaceEntity extends Wire {
  @PrimaryColumn({ type: 'varchar' }) id: string;
  @Column({ type: 'varchar' }) name: string;
  @Index('UQ_workspaces_slug', { unique: true })
  @Column({ type: 'varchar' })
  slug: string;
  /** Stored partially (only what was customized); `toJSON` and `resolved()` fill in the defaults. */
  @Column({ type: 'jsonb', default: EMPTY_OBJECT }) settings: Partial<WorkspaceSettings>;
  @Column({ type: 'timestamptz', default: NOW }) createdAt: Date;

  /** Settings with defaults applied. */
  resolved(): WorkspaceSettings {
    return resolveWorkspaceSettings(this.settings);
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), settings: this.resolved() };
  }
}

@Entity('memberships')
@Index('UQ_memberships_workspace_user', ['workspaceId', 'userId'], {
  unique: true,
})
@ForeignKey(() => WorkspaceEntity, ['workspaceId'], ['id'], {
  onDelete: 'CASCADE',
})
@ForeignKey(() => UserEntity, ['userId'], ['id'], { onDelete: 'CASCADE' })
export class MembershipEntity extends Wire {
  @PrimaryColumn({ type: 'varchar' }) id: string;
  @Column({ type: 'varchar' }) workspaceId: string;
  @Index('IDX_memberships_user')
  @Column({ type: 'varchar' })
  userId: string;
  @Column({ type: 'varchar' }) role: Role;
  @Column({ type: 'timestamptz', default: NOW }) createdAt: Date;
}

@Entity('agents')
@ForeignKey(() => WorkspaceEntity, ['workspaceId'], ['id'], {
  onDelete: 'CASCADE',
})
@ForeignKey(() => UserEntity, ['ownerUserId'], ['id'], { onDelete: 'SET NULL' })
export class AgentEntity extends Wire {
  @PrimaryColumn({ type: 'varchar' }) id: string;
  @Index('IDX_agents_workspace')
  @Column({ type: 'varchar' })
  workspaceId: string;
  @Column({ type: 'varchar' }) name: string;
  @Column({ type: 'varchar' }) provider: Exclude<ExecutionProvider, 'human'>;
  @Column({ type: 'text', nullable: true }) description: string | null;
  @Column({ type: 'varchar', nullable: true }) ownerUserId: string | null;
  @Column({ type: 'timestamptz', default: NOW }) createdAt: Date;
}

@Entity('teams')
@Index('UQ_teams_workspace_key', ['workspaceId', 'key'], { unique: true })
@ForeignKey(() => WorkspaceEntity, ['workspaceId'], ['id'], {
  onDelete: 'CASCADE',
})
export class TeamEntity extends Wire {
  @PrimaryColumn({ type: 'varchar' }) id: string;
  @Column({ type: 'varchar' }) workspaceId: string;
  @Column({ type: 'varchar' }) name: string;
  @Column({ type: 'varchar' }) key: string;
  @Column({ type: 'varchar', default: '#6b7280' }) color: string;
  @Column({ type: 'text', nullable: true }) description: string | null;
  @Column({ type: 'jsonb', default: EMPTY_ARRAY }) memberIds: string[];
  @Column({ type: 'jsonb', default: EMPTY_ARRAY }) leadIds: string[];
  @Column({ type: 'varchar', default: 'workspace' }) editPolicy: TeamEditPolicy;
}

@Entity('repositories')
@Index(
  'UQ_repositories_workspace_name',
  ['workspaceId', 'provider', 'fullName'],
  { unique: true },
)
@ForeignKey(() => WorkspaceEntity, ['workspaceId'], ['id'], {
  onDelete: 'CASCADE',
})
export class RepositoryEntity extends Wire {
  @PrimaryColumn({ type: 'varchar' }) id: string;
  @Column({ type: 'varchar' }) workspaceId: string;
  @Column({ type: 'varchar' }) provider: GitProvider;
  @Column({ type: 'varchar' }) fullName: string;
  @Column({ type: 'varchar' }) url: string;
  @Column({ type: 'varchar', default: 'main' }) defaultBranch: string;
  @Column({ type: 'jsonb', default: EMPTY_ARRAY }) teamIds: string[];
  @Column({ type: 'timestamptz', default: NOW }) createdAt: Date;
}

// ───────────────────────────── workstreams ─────────────────────────────

@Entity('workstreams')
@Index('UQ_workstreams_workspace_key', ['workspaceId', 'key'], {
  unique: true,
})
@Index('IDX_workstreams_workspace_team', ['workspaceId', 'ownerTeamId'])
@ForeignKey(() => WorkspaceEntity, ['workspaceId'], ['id'], {
  onDelete: 'CASCADE',
})
@ForeignKey(() => TeamEntity, ['ownerTeamId'], ['id'], { onDelete: 'RESTRICT' })
@ForeignKey(() => UserEntity, ['accountableUserId'], ['id'], {
  onDelete: 'SET NULL',
})
export class WorkstreamEntity extends Wire {
  @PrimaryColumn({ type: 'varchar' }) id: string;
  @Column({ type: 'varchar' }) workspaceId: string;
  @Column({ type: 'varchar' }) key: string;
  @Column({ type: 'integer' }) number: number;
  @Column({ type: 'varchar' }) title: string;
  @Column({ type: 'text', nullable: true }) description: string | null;
  @Column({ type: 'text', default: '' }) objective: string;
  @Column({ type: 'text', nullable: true }) context: string | null;
  @Column({ type: 'varchar' }) deltaThreadUrl: string;
  @Column({ type: 'varchar' }) ownerTeamId: string;
  @Column({ type: 'jsonb', default: EMPTY_ARRAY })
  participatingTeamIds: string[];
  @Column({ type: 'varchar', nullable: true }) accountableUserId: string | null;
  @Column({ type: 'jsonb', default: EMPTY_ARRAY }) repositoryIds: string[];
  @Column({ type: 'jsonb', default: EMPTY_ARRAY })
  acceptanceCriteria: AcceptanceCriterion[];
  @Column({ type: 'varchar', default: 'none' }) priority: Priority;
  @Column({ type: 'jsonb', default: EMPTY_ARRAY }) labels: string[];
  @Column({ type: 'varchar', default: 'draft' }) status: WorkstreamStatus;
  @Column({ type: 'varchar', default: 'draft' })
  derivedStatus: WorkstreamStatus;
  @Column({ type: 'varchar', nullable: true }) statusOverride: WorkstreamStatus | null;
  @Column({ type: 'timestamptz', nullable: true }) startDate: Date | null;
  @Column({ type: 'timestamptz', nullable: true }) targetDate: Date | null;
  @Column({ type: 'varchar' }) createdById: string;
  @Column({ type: 'timestamptz', default: NOW }) createdAt: Date;
  @Column({ type: 'timestamptz', default: NOW }) updatedAt: Date;
  @Column({ type: 'timestamptz', nullable: true }) shippedAt: Date | null;
}

@Entity('milestones')
@Index('IDX_milestones_workspace', ['workspaceId'])
@Index('IDX_milestones_workstream', ['workstreamId'])
@ForeignKey(() => WorkspaceEntity, ['workspaceId'], ['id'], {
  onDelete: 'CASCADE',
})
@ForeignKey(() => WorkstreamEntity, ['workstreamId'], ['id'], {
  onDelete: 'CASCADE',
})
export class MilestoneEntity extends Wire {
  @PrimaryColumn({ type: 'varchar' }) id: string;
  @Column({ type: 'varchar' }) workspaceId: string;
  @Column({ type: 'varchar' }) workstreamId: string;
  @Column({ type: 'varchar' }) name: string;
  @Column({ type: 'text', nullable: true }) description: string | null;
  @Column({ type: 'timestamptz', nullable: true }) targetDate: Date | null;
  @Column({ type: 'double precision', default: 0 }) sortOrder: number;
  @Column({ type: 'timestamptz', default: NOW }) createdAt: Date;
  @Column({ type: 'timestamptz', default: NOW }) updatedAt: Date;
}

@Entity('input_requests')
@Index('IDX_input_requests_workspace', ['workspaceId'])
@Index('IDX_input_requests_workstream', ['workstreamId'])
@ForeignKey(() => WorkspaceEntity, ['workspaceId'], ['id'], {
  onDelete: 'CASCADE',
})
@ForeignKey(() => WorkstreamEntity, ['workstreamId'], ['id'], {
  onDelete: 'CASCADE',
})
@ForeignKey(() => UserEntity, ['assigneeUserId'], ['id'], {
  onDelete: 'SET NULL',
})
export class InputRequestEntity extends Wire {
  @PrimaryColumn({ type: 'varchar' }) id: string;
  @Column({ type: 'varchar' }) workspaceId: string;
  @Column({ type: 'varchar' }) workstreamId: string;
  @Column({ type: 'text' }) question: string;
  @Column({ type: 'jsonb', nullable: true }) options: string[] | null;
  @Column({ type: 'jsonb' }) requestedBy: ActorRef;
  @Column({ type: 'varchar', nullable: true }) assigneeUserId: string | null;
  @Column({ type: 'varchar', default: 'open' }) state: InputRequestState;
  @Column({ type: 'text', nullable: true }) answer: string | null;
  @Column({ type: 'varchar', nullable: true }) answeredById: string | null;
  @Column({ type: 'timestamptz', default: NOW }) createdAt: Date;
  @Column({ type: 'timestamptz', nullable: true }) answeredAt: Date | null;

  protected override hidden() {
    return ['workspaceId'];
  }
}

// ───────────────────────────── issues ─────────────────────────────

@Entity('issues')
@Index('UQ_issues_workspace_key', ['workspaceId', 'key'], { unique: true })
@ForeignKey(() => WorkspaceEntity, ['workspaceId'], ['id'], {
  onDelete: 'CASCADE',
})
@ForeignKey(() => TeamEntity, ['teamId'], ['id'], { onDelete: 'SET NULL' })
@ForeignKey(() => UserEntity, ['assigneeId'], ['id'], { onDelete: 'SET NULL' })
export class IssueEntity extends Wire {
  @PrimaryColumn({ type: 'varchar' }) id: string;
  @Column({ type: 'varchar' }) workspaceId: string;
  @Column({ type: 'varchar' }) key: string;
  @Column({ type: 'integer' }) number: number;
  @Column({ type: 'varchar' }) kind: IssueKind;
  @Column({ type: 'varchar' }) title: string;
  @Column({ type: 'text', nullable: true }) body: string | null;
  @Column({ type: 'varchar', default: 'manual' }) source: IssueSource;
  @Column({ type: 'varchar', nullable: true }) reporterName: string | null;
  @Column({ type: 'varchar', nullable: true }) reporterId: string | null;
  @Column({ type: 'varchar', nullable: true }) assigneeId: string | null;
  @Column({ type: 'varchar', nullable: true }) teamId: string | null;
  @Column({ type: 'varchar', default: 'none' }) priority: Priority;
  @Column({ type: 'varchar', default: 'backlog' }) status: IssueStatus;
  @Column({ type: 'jsonb', default: EMPTY_ARRAY }) workstreamIds: string[];
  @Column({ type: 'jsonb', default: EMPTY_ARRAY }) milestoneIds: string[];
  @Column({ type: 'double precision', nullable: true }) estimate: number | null;
  @Column({ type: 'timestamptz', nullable: true }) startedAt: Date | null;
  @Column({ type: 'timestamptz', nullable: true }) completedAt: Date | null;
  @Column({ type: 'jsonb', default: EMPTY_ARRAY }) aliases: string[];
  @Column({ type: 'varchar', nullable: true }) duplicateOfId: string | null;
  @Column({ type: 'varchar', nullable: true }) externalUrl: string | null;
  @Column({ type: 'timestamptz', default: NOW }) createdAt: Date;
  @Column({ type: 'timestamptz', default: NOW }) updatedAt: Date;
}

// ───────────────────────────── artifacts / decisions / dependencies ─────────────────────────────

@Entity('artifacts')
@Index('IDX_artifacts_workspace', ['workspaceId'])
@Index('IDX_artifacts_workstream', ['workstreamId'])
@Index('IDX_artifacts_external', ['workspaceId', 'repositoryId', 'externalId'])
@ForeignKey(() => WorkspaceEntity, ['workspaceId'], ['id'], {
  onDelete: 'CASCADE',
})
@ForeignKey(() => WorkstreamEntity, ['workstreamId'], ['id'], {
  onDelete: 'CASCADE',
})
@ForeignKey(() => RepositoryEntity, ['repositoryId'], ['id'], {
  onDelete: 'SET NULL',
})
export class ArtifactEntity extends Wire {
  @PrimaryColumn({ type: 'varchar' }) id: string;
  @Column({ type: 'varchar' }) workspaceId: string;
  @Column({ type: 'varchar' }) workstreamId: string;
  @Column({ type: 'varchar', nullable: true }) repositoryId: string | null;
  @Column({ type: 'varchar' }) kind: ArtifactKind;
  @Column({ type: 'varchar', default: 'other' }) provider: ArtifactProvider;
  @Column({ type: 'varchar' }) title: string;
  @Column({ type: 'varchar', nullable: true }) url: string | null;
  @Column({ type: 'varchar', nullable: true }) externalId: string | null;
  @Column({ type: 'varchar', default: 'open' }) state: ArtifactState;
  @Column({ type: 'varchar', nullable: true }) ci: CiState | null;
  @Column({ type: 'varchar', nullable: true }) review: ReviewState | null;
  @Column({ type: 'boolean', nullable: true }) hasConflicts: boolean | null;
  @Column({ type: 'varchar', nullable: true }) environment: string | null;
  @Column({ type: 'jsonb', nullable: true }) authorRef: ActorRef | null;
  @Column({ type: 'timestamptz', default: NOW }) createdAt: Date;
  @Column({ type: 'timestamptz', default: NOW }) updatedAt: Date;

  protected override hidden() {
    return ['workspaceId'];
  }
}

@Entity('decisions')
@Index('UQ_decisions_workspace_key', ['workspaceId', 'key'], { unique: true })
@ForeignKey(() => WorkspaceEntity, ['workspaceId'], ['id'], {
  onDelete: 'CASCADE',
})
@ForeignKey(() => WorkstreamEntity, ['originWorkstreamId'], ['id'], {
  onDelete: 'SET NULL',
})
export class DecisionEntity extends Wire {
  @PrimaryColumn({ type: 'varchar' }) id: string;
  @Column({ type: 'varchar' }) workspaceId: string;
  @Column({ type: 'varchar' }) key: string;
  @Column({ type: 'integer' }) number: number;
  @Column({ type: 'varchar' }) title: string;
  @Column({ type: 'text' }) statement: string;
  @Column({ type: 'text', nullable: true }) rationale: string | null;
  @Column({ type: 'varchar', default: 'proposed' }) status: DecisionStatus;
  @Column({ type: 'varchar', nullable: true }) originWorkstreamId:
    | string
    | null;
  @Column({ type: 'jsonb', default: EMPTY_ARRAY })
  relatedWorkstreamIds: string[];
  @Column({ type: 'varchar', nullable: true }) supersededById: string | null;
  @Column({ type: 'jsonb' }) proposedBy: ActorRef;
  @Column({ type: 'varchar', nullable: true }) decidedById: string | null;
  @Column({ type: 'timestamptz', nullable: true }) decidedAt: Date | null;
  @Column({ type: 'jsonb', default: EMPTY_ARRAY }) tags: string[];
  @Column({ type: 'timestamptz', default: NOW }) createdAt: Date;
  @Column({ type: 'timestamptz', default: NOW }) updatedAt: Date;
}

/** Workstream → workstream edge. No FKs on from/to; services clean up. */
@Entity('dependencies')
@Index(
  'UQ_dependencies_edge',
  ['workspaceId', 'fromType', 'fromId', 'toType', 'toId'],
  { unique: true },
)
@Index('IDX_dependencies_to', ['workspaceId', 'toId'])
@Index('IDX_dependencies_from', ['workspaceId', 'fromId'])
@ForeignKey(() => WorkspaceEntity, ['workspaceId'], ['id'], {
  onDelete: 'CASCADE',
})
export class DependencyEntity extends Wire {
  @PrimaryColumn({ type: 'varchar' }) id: string;
  @Column({ type: 'varchar' }) workspaceId: string;
  @Column({ type: 'varchar' }) fromType: DependencyNodeType;
  @Column({ type: 'varchar' }) fromId: string;
  @Column({ type: 'varchar' }) toType: DependencyNodeType;
  @Column({ type: 'varchar' }) toId: string;
  @Column({ type: 'timestamptz', default: NOW }) createdAt: Date;
}

// ───────────────────────────── comments & events ─────────────────────────────

@Entity('comments')
@Index('IDX_comments_workspace', ['workspaceId'])
@ForeignKey(() => WorkspaceEntity, ['workspaceId'], ['id'], {
  onDelete: 'CASCADE',
})
export class CommentEntity extends Wire {
  @PrimaryColumn({ type: 'varchar' }) id: string;
  @Column({ type: 'varchar' }) workspaceId: string;
  @Column({ type: 'jsonb' }) subject: SubjectRef;
  @Column({ type: 'jsonb' }) author: ActorRef;
  @Column({ type: 'text' }) body: string;
  @Column({ type: 'timestamptz', default: NOW }) createdAt: Date;
  @Column({ type: 'timestamptz', default: NOW }) updatedAt: Date;
}

/** Append-only. No FK on workstreamId so history survives workstream deletion. */
@Entity('domain_events')
@Index('IDX_events_workspace_at', ['workspaceId', 'at'])
@Index('IDX_events_workstream_at', ['workspaceId', 'workstreamId', 'at'])
@ForeignKey(() => WorkspaceEntity, ['workspaceId'], ['id'], {
  onDelete: 'CASCADE',
})
export class DomainEventEntity extends Wire {
  @PrimaryColumn({ type: 'varchar' }) id: string;
  @Column({ type: 'varchar' }) workspaceId: string;
  @Column({ type: 'timestamptz', default: NOW }) at: Date;
  @Column({ type: 'jsonb' }) actor: ActorRef;
  @Column({ type: 'varchar' }) type: string;
  @Column({ type: 'jsonb' }) subject: SubjectRef;
  @Column({ type: 'varchar', nullable: true }) workstreamId: string | null;
  @Column({ type: 'jsonb', default: EMPTY_OBJECT }) data: Record<string, unknown>;
}

// ───────────────────────────── views, tokens, attention, counters, integrations ─────────────────────────────

@Entity('saved_views')
@Index('IDX_views_workspace', ['workspaceId'])
@ForeignKey(() => WorkspaceEntity, ['workspaceId'], ['id'], {
  onDelete: 'CASCADE',
})
@ForeignKey(() => UserEntity, ['ownerId'], ['id'], { onDelete: 'CASCADE' })
export class SavedViewEntity extends Wire {
  @PrimaryColumn({ type: 'varchar' }) id: string;
  @Column({ type: 'varchar' }) workspaceId: string;
  @Column({ type: 'varchar' }) ownerId: string;
  @Column({ type: 'varchar' }) name: string;
  @Column({ type: 'varchar' }) entity: ViewEntity;
  @Column({ type: 'jsonb', default: EMPTY_ARRAY }) filters: ViewFilter[];
  @Column({ type: 'jsonb', nullable: true }) sort: SavedView['sort'] | null;
  @Column({ type: 'varchar', nullable: true }) groupBy: string | null;
  @Column({ type: 'varchar', default: 'list' }) layout: ViewLayout;
  @Column({ type: 'boolean', default: false }) shared: boolean;
  @Column({ type: 'timestamptz', default: NOW }) createdAt: Date;
  @Column({ type: 'timestamptz', default: NOW }) updatedAt: Date;
}

/** Only the sha256 of the secret is stored; `prefix` is for display. */
@Entity('api_tokens')
@Index('UQ_api_tokens_hash', ['tokenHash'], { unique: true })
@Index('IDX_api_tokens_workspace', ['workspaceId'])
@ForeignKey(() => WorkspaceEntity, ['workspaceId'], ['id'], {
  onDelete: 'CASCADE',
})
export class ApiTokenEntity extends Wire {
  @PrimaryColumn({ type: 'varchar' }) id: string;
  @Column({ type: 'varchar' }) workspaceId: string;
  @Column({ type: 'varchar' }) name: string;
  @Column({ type: 'varchar' }) prefix: string;
  @Column({ type: 'varchar' }) tokenHash: string;
  @Column({ type: 'jsonb' }) actor: ActorRef;
  @Column({ type: 'varchar', default: 'write' }) scope: TokenScope;
  @Column({ type: 'varchar', nullable: true }) createdByUserId: string | null;
  @Column({ type: 'timestamptz', nullable: true }) lastUsedAt: Date | null;
  @Column({ type: 'timestamptz', default: NOW }) createdAt: Date;
  @Column({ type: 'timestamptz', nullable: true }) expiresAt: Date | null;

  protected override hidden() {
    return ['tokenHash', 'createdByUserId'];
  }
}

/** Per-user dismiss / snooze state for derived AttentionItems (item id = `${kind}:${sourceId}`). */
@Entity('attention_state')
@ForeignKey(() => WorkspaceEntity, ['workspaceId'], ['id'], {
  onDelete: 'CASCADE',
})
@ForeignKey(() => UserEntity, ['userId'], ['id'], { onDelete: 'CASCADE' })
export class AttentionStateEntity {
  @PrimaryColumn({ type: 'varchar' }) userId: string;
  @PrimaryColumn({ type: 'varchar' }) workspaceId: string;
  @PrimaryColumn({ type: 'varchar' }) itemId: string;
  @Column({ type: 'varchar' }) state: 'dismissed' | 'snoozed';
  @Column({ type: 'timestamptz', nullable: true }) snoozedUntil: Date | null;
  /** The item's `since` when the user acted; a changed `since` re-opens the item. */
  @Column({ type: 'timestamptz' }) since: Date;
}

/** Atomic per-workspace sequences: `ws:<teamId>`, `issue:<kind>`, `adr`. */
@Entity('workspace_counters')
@ForeignKey(() => WorkspaceEntity, ['workspaceId'], ['id'], {
  onDelete: 'CASCADE',
})
export class WorkspaceCounterEntity {
  @PrimaryColumn({ type: 'varchar' }) workspaceId: string;
  @PrimaryColumn({ type: 'varchar' }) name: string;
  @Column({ type: 'integer', default: 0 }) value: number;
}

/** Owned by the integrations agent. `secret` / `webhookSecret` are never serialized. */
@Entity('integration_connections')
@Index('IDX_integrations_workspace', ['workspaceId'])
@ForeignKey(() => WorkspaceEntity, ['workspaceId'], ['id'], {
  onDelete: 'CASCADE',
})
export class IntegrationConnectionEntity extends Wire {
  @PrimaryColumn({ type: 'varchar' }) id: string;
  @Column({ type: 'varchar' }) workspaceId: string;
  @Column({ type: 'varchar' }) provider: GitProvider | 'delta';
  @Column({ type: 'varchar' }) account: string;
  @Column({ type: 'varchar', nullable: true }) baseUrl: string | null;
  /** Encrypted token / app credential (see common/crypto.ts). */
  @Column({ type: 'text', nullable: true }) secret: string | null;
  /** Encrypted webhook secret. */
  @Column({ type: 'text', nullable: true }) webhookSecret: string | null;
  @Column({ type: 'varchar', default: 'connected' }) status:
    | 'connected'
    | 'error'
    | 'disconnected';
  @Column({ type: 'timestamptz', nullable: true }) lastSyncAt: Date | null;
  @Column({ type: 'text', nullable: true }) lastError: string | null;
  /** Provider-specific, non-secret settings. */
  @Column({ type: 'jsonb', default: EMPTY_OBJECT }) config: Record<string, unknown>;
  @Column({ type: 'timestamptz', default: NOW }) createdAt: Date;

  /** Contract field: whether a webhook secret is configured. */
  get webhookConfigured(): boolean {
    return !!this.webhookSecret;
  }

  protected override hidden() {
    return ['secret', 'webhookSecret', 'config'];
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), webhookConfigured: this.webhookConfigured };
  }
}

/** Custom integration: signed JSON POSTs to `url` for matching domain events. `secret` is encrypted and only shown once. */
@Entity('outgoing_webhooks')
@Index('IDX_outgoing_webhooks_workspace', ['workspaceId'])
@ForeignKey(() => WorkspaceEntity, ['workspaceId'], ['id'], {
  onDelete: 'CASCADE',
})
export class OutgoingWebhookEntity extends Wire {
  @PrimaryColumn({ type: 'varchar' }) id: string;
  @Column({ type: 'varchar' }) workspaceId: string;
  @Column({ type: 'varchar' }) name: string;
  @Column({ type: 'varchar' }) url: string;
  /** Encrypted signing secret (SecretsService, AAD = `<id>:outgoing`). */
  @Column({ type: 'text' }) secret: string;
  @Column({ type: 'jsonb', default: EMPTY_ARRAY }) events: string[];
  @Column({ type: 'boolean', default: true }) enabled: boolean;
  @Column({ type: 'timestamptz', default: NOW }) createdAt: Date;
  @Column({ type: 'timestamptz', nullable: true }) lastDeliveryAt: Date | null;
  @Column({ type: 'integer', nullable: true }) lastStatus: number | null;

  protected override hidden() {
    return ['secret'];
  }
}

/** One attempt to deliver an event to an outgoing webhook. Pruned to the latest ~50 per webhook. */
@Entity('outgoing_webhook_deliveries')
@Index('IDX_outgoing_deliveries_webhook_at', ['webhookId', 'at'])
@ForeignKey(() => OutgoingWebhookEntity, ['webhookId'], ['id'], {
  onDelete: 'CASCADE',
})
export class OutgoingWebhookDeliveryEntity extends Wire {
  @PrimaryColumn({ type: 'varchar' }) id: string;
  @Column({ type: 'varchar' }) webhookId: string;
  @Column({ type: 'varchar' }) event: string;
  @Column({ type: 'integer', default: 0 }) status: number;
  @Column({ type: 'boolean', default: false }) ok: boolean;
  @Column({ type: 'integer', default: 0 }) durationMs: number;
  @Column({ type: 'text', nullable: true }) error: string | null;
  @Column({ type: 'integer', default: 1 }) attempt: number;
  @Column({ type: 'timestamptz', default: NOW }) at: Date;
}

export const ENTITIES = [
  UserEntity,
  SessionEntity,
  WorkspaceEntity,
  MembershipEntity,
  AgentEntity,
  TeamEntity,
  RepositoryEntity,
  WorkstreamEntity,
  MilestoneEntity,
  InputRequestEntity,
  IssueEntity,
  ArtifactEntity,
  DecisionEntity,
  DependencyEntity,
  CommentEntity,
  DomainEventEntity,
  SavedViewEntity,
  ApiTokenEntity,
  AttentionStateEntity,
  WorkspaceCounterEntity,
  IntegrationConnectionEntity,
  OutgoingWebhookEntity,
  OutgoingWebhookDeliveryEntity,
];
