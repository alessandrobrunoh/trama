import {
  Check,
  Column,
  Entity,
  ForeignKey,
  Index,
  PrimaryColumn,
} from 'typeorm';
import type {
  ActorRef,
  ArtifactKind,
  ArtifactProvider,
  ArtifactState,
  CiState,
  CustomerStatus,
  DecisionStatus,
  ExecutionProvider,
  ExternalRef,
  FavoriteType,
  GitProvider,
  InputRequestState,
  IntakeProvider,
  IssueKind,
  IssueSource,
  IssueStatus,
  MemberAccess,
  NotificationChannels,
  NotificationRecordKind,
  Priority,
  ProjectHealth,
  ProjectStatus,
  ReleasePipelineType,
  ReleaseStatus,
  ReviewState,
  Role,
  SavedView,
  SharingSettings,
  LegacySubjectRef,
  TeamEditPolicy,
  TokenScope,
  ApiPermission,
  TokenLimits,
  ViewEntity,
  ViewFilter,
  ViewLayout,
  WorkspaceSettings,
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
  /** Per notification kind and channel; missing entries use the defaults (see resolveNotificationSettings). */
  @Column({ type: 'jsonb', default: EMPTY_OBJECT })
  notificationSettings: Partial<Record<string, Partial<NotificationChannels>>>;
  @Column({ type: 'timestamptz', default: NOW }) createdAt: Date;

  protected override hidden() {
    return ['passwordHash', 'notificationSettings'];
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
@ForeignKey(() => UserEntity, ['primaryOwnerId'], ['id'], {
  onDelete: 'SET NULL',
})
export class WorkspaceEntity extends Wire {
  @PrimaryColumn({ type: 'varchar' }) id: string;
  @Column({ type: 'varchar' }) name: string;
  @Index('UQ_workspaces_slug', { unique: true })
  @Column({ type: 'varchar' })
  slug: string;
  /** Stored partially (only what was customized); `toJSON` and `resolved()` fill in the defaults. */
  @Column({ type: 'jsonb', default: EMPTY_OBJECT })
  settings: Partial<WorkspaceSettings>;
  /** The user who owns the workspace (its creator until ownership is transferred); see `member-rules.ts`. */
  @Column({ type: 'varchar', nullable: true }) primaryOwnerId: string | null;
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
  /** Null = the role applies in full. See `MemberAccess`. */
  @Column({ type: 'jsonb', nullable: true }) access: MemberAccess | null;
  @Column({ type: 'timestamptz', default: NOW }) createdAt: Date;
}

/** Pending (or finished) invitation by email. Only the sha256 of the secret link token is stored. */
@Entity('invites')
@ForeignKey(() => WorkspaceEntity, ['workspaceId'], ['id'], {
  onDelete: 'CASCADE',
})
@ForeignKey(() => UserEntity, ['invitedByUserId'], ['id'], {
  onDelete: 'SET NULL',
})
export class InviteEntity extends Wire {
  @PrimaryColumn({ type: 'varchar' }) id: string;
  @Index('IDX_invites_workspace')
  @Column({ type: 'varchar' })
  workspaceId: string;
  /** Lower-cased. */
  @Index('IDX_invites_email')
  @Column({ type: 'varchar' })
  email: string;
  @Column({ type: 'varchar' }) role: Role;
  /** Copied onto the membership when the invitation is accepted. Null = the role in full. */
  @Column({ type: 'jsonb', nullable: true }) access: MemberAccess | null;
  @Index('UQ_invites_token', { unique: true })
  @Column({ type: 'varchar' })
  tokenHash: string;
  @Column({ type: 'varchar', nullable: true }) invitedByUserId: string | null;
  @Column({ type: 'timestamptz', default: NOW }) createdAt: Date;
  @Column({ type: 'timestamptz' }) expiresAt: Date;
  @Column({ type: 'timestamptz', nullable: true }) emailedAt: Date | null;
  @Column({ type: 'timestamptz', nullable: true }) acceptedAt: Date | null;
  @Column({ type: 'timestamptz', nullable: true }) revokedAt: Date | null;

  protected override hidden() {
    return ['tokenHash', 'acceptedAt', 'revokedAt'];
  }
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
  @Column({ type: 'jsonb', default: EMPTY_ARRAY }) labels: string[];
  @Column({ type: 'timestamptz', default: NOW }) createdAt: Date;
}

// ───────────────────────────── projects ─────────────────────────────

@Entity('projects')
@Index('IDX_projects_workspace', ['workspaceId'])
@Index('UQ_projects_workspace_key', ['workspaceId', 'key'], { unique: true })
@ForeignKey(() => WorkspaceEntity, ['workspaceId'], ['id'], {
  onDelete: 'CASCADE',
})
@ForeignKey(() => UserEntity, ['leadId'], ['id'], { onDelete: 'SET NULL' })
export class ProjectEntity extends Wire {
  @PrimaryColumn({ type: 'varchar' }) id: string;
  @Column({ type: 'varchar' }) workspaceId: string;
  @Column({ type: 'varchar' }) name: string;
  @Column({ type: 'varchar', length: 4 }) key: string;
  @Column({ type: 'varchar', nullable: true }) summary: string | null;
  @Column({ type: 'text', nullable: true }) description: string | null;
  @Column({ type: 'varchar', default: '#6b7280' }) color: string;
  /** Lucide icon name (kebab-case) or an emoji; null = default glyph. */
  @Column({ type: 'varchar', nullable: true }) icon: string | null;
  @Column({ type: 'varchar', default: 'backlog' }) status: ProjectStatus;
  /** Health of the latest project update (denormalized; see ProjectUpdatesService). */
  @Column({ type: 'varchar', nullable: true }) health: ProjectHealth | null;
  @Column({ type: 'timestamptz', nullable: true }) lastUpdateAt: Date | null;
  @Column({ type: 'varchar', default: 'none' }) priority: Priority;
  @Column({ type: 'varchar', nullable: true }) leadId: string | null;
  @Column({ type: 'jsonb', default: EMPTY_ARRAY }) teamIds: string[];
  @Column({ type: 'jsonb', default: EMPTY_ARRAY }) repositoryIds: string[];
  @Column({ type: 'jsonb', default: EMPTY_ARRAY }) labels: string[];
  @Column({ type: 'timestamptz', nullable: true }) startDate: Date | null;
  @Column({ type: 'timestamptz', nullable: true }) targetDate: Date | null;
  @Column({ type: 'timestamptz', default: NOW }) createdAt: Date;
  @Column({ type: 'timestamptz', default: NOW }) updatedAt: Date;
  @Column({ type: 'timestamptz', nullable: true }) completedAt: Date | null;
  /** Filled on read. Not a column. */
  customerCount?: number;
}

@Entity('project_updates')
@Index('IDX_project_updates_project', ['projectId', 'createdAt'])
@ForeignKey(() => WorkspaceEntity, ['workspaceId'], ['id'], {
  onDelete: 'CASCADE',
})
@ForeignKey(() => ProjectEntity, ['projectId'], ['id'], {
  onDelete: 'CASCADE',
})
export class ProjectUpdateEntity extends Wire {
  @PrimaryColumn({ type: 'varchar' }) id: string;
  @Column({ type: 'varchar' }) workspaceId: string;
  @Column({ type: 'varchar' }) projectId: string;
  @Column({ type: 'varchar' }) health: ProjectHealth;
  @Column({ type: 'text' }) body: string;
  @Column({ type: 'jsonb' }) author: ActorRef;
  @Column({ type: 'boolean', default: false }) aiDrafted: boolean;
  @Column({ type: 'timestamptz', default: NOW }) createdAt: Date;
  @Column({ type: 'timestamptz', nullable: true }) editedAt: Date | null;
}

// ───────────────────────────── documents ─────────────────────────────

/** `searchVector` (generated, GIN-indexed) exists only in the database; queries reference it by name. */
@Entity('documents')
@Index('IDX_documents_workspace_updated', ['workspaceId', 'updatedAt'])
@ForeignKey(() => WorkspaceEntity, ['workspaceId'], ['id'], {
  onDelete: 'CASCADE',
})
export class DocumentEntity extends Wire {
  @PrimaryColumn({ type: 'varchar' }) id: string;
  @Column({ type: 'varchar' }) workspaceId: string;
  @Column({ type: 'varchar' }) title: string;
  @Column({ type: 'text', default: '' }) body: string;
  @Column({ type: 'varchar', nullable: true }) icon: string | null;
  @Column({ type: 'integer', default: 1 }) version: number;
  @Column({ type: 'jsonb' }) author: ActorRef;
  @Column({ type: 'jsonb' }) lastEditor: ActorRef;
  @Column({ type: 'timestamptz', nullable: true }) archivedAt: Date | null;
  @Column({ type: 'timestamptz', default: NOW }) createdAt: Date;
  @Column({ type: 'timestamptz', default: NOW }) updatedAt: Date;

  protected override hidden() {
    return ['workspaceId'];
  }
}

@Entity('document_revisions')
@Index('UQ_document_revisions_version', ['documentId', 'version'], {
  unique: true,
})
@ForeignKey(() => WorkspaceEntity, ['workspaceId'], ['id'], {
  onDelete: 'CASCADE',
})
@ForeignKey(() => DocumentEntity, ['documentId'], ['id'], {
  onDelete: 'CASCADE',
})
export class DocumentRevisionEntity extends Wire {
  @PrimaryColumn({ type: 'varchar' }) id: string;
  @Column({ type: 'varchar' }) workspaceId: string;
  @Column({ type: 'varchar' }) documentId: string;
  @Column({ type: 'integer' }) version: number;
  @Column({ type: 'varchar' }) title: string;
  @Column({ type: 'text' }) body: string;
  @Column({ type: 'jsonb' }) editor: ActorRef;
  @Column({ type: 'timestamptz', default: NOW }) createdAt: Date;

  protected override hidden() {
    return ['workspaceId'];
  }
}

@Entity('milestones')
@Index('IDX_milestones_workspace', ['workspaceId'])
@Index('IDX_milestones_project', ['projectId'])
@ForeignKey(() => WorkspaceEntity, ['workspaceId'], ['id'], {
  onDelete: 'CASCADE',
})
@ForeignKey(() => ProjectEntity, ['projectId'], ['id'], {
  onDelete: 'CASCADE',
})
export class MilestoneEntity extends Wire {
  @PrimaryColumn({ type: 'varchar' }) id: string;
  @Column({ type: 'varchar' }) workspaceId: string;
  @Column({ type: 'varchar' }) projectId: string;
  @Column({ type: 'varchar' }) name: string;
  @Column({ type: 'text', nullable: true }) description: string | null;
  @Column({ type: 'timestamptz', nullable: true }) targetDate: Date | null;
  @Column({ type: 'double precision', default: 0 }) sortOrder: number;
  @Column({ type: 'timestamptz', default: NOW }) createdAt: Date;
  @Column({ type: 'timestamptz', default: NOW }) updatedAt: Date;
}

@Entity('input_requests')
@Index('IDX_input_requests_workspace', ['workspaceId'])
@Index('IDX_input_requests_issue', ['issueId'])
@ForeignKey(() => WorkspaceEntity, ['workspaceId'], ['id'], {
  onDelete: 'CASCADE',
})
@ForeignKey(() => IssueEntity, ['issueId'], ['id'], { onDelete: 'SET NULL' })
@ForeignKey(() => UserEntity, ['assigneeUserId'], ['id'], {
  onDelete: 'SET NULL',
})
export class InputRequestEntity extends Wire {
  @PrimaryColumn({ type: 'varchar' }) id: string;
  @Column({ type: 'varchar' }) workspaceId: string;
  /** Required for new rows; null only for unlinked legacy history. */
  @Column({ type: 'varchar', nullable: true }) issueId: string | null;
  /** Historical provenance only; never used to scope new requests. */
  @Column({ type: 'varchar', nullable: true }) legacyWorkstreamKey:
    string | null;
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

// ───────────────────────────── releases ─────────────────────────────

@Entity('release_pipelines')
@Index('IDX_release_pipelines_workspace', ['workspaceId'])
@ForeignKey(() => WorkspaceEntity, ['workspaceId'], ['id'], {
  onDelete: 'CASCADE',
})
@ForeignKey(() => TeamEntity, ['teamId'], ['id'], { onDelete: 'SET NULL' })
export class ReleasePipelineEntity extends Wire {
  @PrimaryColumn({ type: 'varchar' }) id: string;
  @Column({ type: 'varchar' }) workspaceId: string;
  @Column({ type: 'varchar' }) name: string;
  @Column({ type: 'varchar', default: 'continuous' }) type: ReleasePipelineType;
  @Column({ type: 'varchar', nullable: true }) teamId: string | null;
  @Column({ type: 'boolean', default: false }) moveOpenIssuesToNext: boolean;
  @Column({ type: 'timestamptz', default: NOW }) createdAt: Date;
  @Column({ type: 'timestamptz', default: NOW }) updatedAt: Date;
}

@Entity('releases')
@Index('IDX_releases_workspace', ['workspaceId'])
@Index('IDX_releases_pipeline', ['pipelineId'])
@Index('UQ_releases_workspace_id', ['workspaceId', 'id'], { unique: true })
@ForeignKey(() => WorkspaceEntity, ['workspaceId'], ['id'], {
  onDelete: 'CASCADE',
})
@ForeignKey(() => ReleasePipelineEntity, ['pipelineId'], ['id'], {
  onDelete: 'CASCADE',
})
export class ReleaseEntity extends Wire {
  @PrimaryColumn({ type: 'varchar' }) id: string;
  @Column({ type: 'varchar' }) workspaceId: string;
  @Column({ type: 'varchar' }) pipelineId: string;
  @Column({ type: 'varchar' }) name: string;
  @Column({ type: 'varchar', default: 'draft' }) status: ReleaseStatus;
  @Column({ type: 'text', nullable: true }) notes: string | null;
  @Column({ type: 'timestamptz', nullable: true }) targetAt: Date | null;
  @Column({ type: 'timestamptz', nullable: true }) releasedAt: Date | null;
  @Column({ type: 'timestamptz', default: NOW }) createdAt: Date;
  @Column({ type: 'timestamptz', default: NOW }) updatedAt: Date;
  /** Filled on read. Not a column. */
  issueCount?: number;
}

// ───────────────────────────── issues ─────────────────────────────

@Entity('issues')
@Index('UQ_issues_workspace_key', ['workspaceId', 'key'], { unique: true })
@ForeignKey(() => WorkspaceEntity, ['workspaceId'], ['id'], {
  onDelete: 'CASCADE',
})
@ForeignKey(() => TeamEntity, ['teamId'], ['id'], { onDelete: 'SET NULL' })
@ForeignKey(() => UserEntity, ['assigneeId'], ['id'], { onDelete: 'SET NULL' })
@ForeignKey(() => ProjectEntity, ['projectId'], ['id'], {
  onDelete: 'SET NULL',
})
@ForeignKey(() => ReleaseEntity, ['releaseId'], ['id'], { onDelete: 'SET NULL' })
@Index('IDX_issues_project', ['projectId'])
@Index('IDX_issues_release', ['releaseId'])
@Index('UQ_issues_workspace_id', ['workspaceId', 'id'], { unique: true })
@Index('IDX_issues_parent', ['parentId'])
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
  @Column({ type: 'varchar', nullable: true }) projectId: string | null;
  @Column({ type: 'varchar', default: 'none' }) priority: Priority;
  @Column({ type: 'varchar', default: 'backlog' }) status: IssueStatus;
  @Column({ type: 'text', nullable: true }) goal: string | null;
  @Column({ type: 'jsonb', default: EMPTY_ARRAY }) milestoneIds: string[];
  @Column({ type: 'varchar', nullable: true }) releaseId: string | null;
  @Column({ type: 'double precision', nullable: true }) estimate: number | null;
  @Column({ type: 'timestamptz', nullable: true }) startedAt: Date | null;
  @Column({ type: 'timestamptz', nullable: true }) completedAt: Date | null;
  @Column({ type: 'jsonb', default: EMPTY_ARRAY }) labels: string[];
  @Column({ type: 'jsonb', default: EMPTY_ARRAY }) aliases: string[];
  /** Migration FK requires parent and child to share a workspace; deleting the parent clears only this column. */
  @Column({ type: 'varchar', nullable: true }) parentId: string | null;
  @Column({ type: 'varchar', nullable: true }) duplicateOfId: string | null;
  @Column({ type: 'varchar', nullable: true }) externalUrl: string | null;
  /** Pointer to the issue in an external tracker (see importers). Unique per workspace through a partial index on provider + id. */
  @Column({ type: 'jsonb', nullable: true }) externalRef: ExternalRef | null;
  @Column({ type: 'timestamptz', default: NOW }) createdAt: Date;
  @Column({ type: 'timestamptz', default: NOW }) updatedAt: Date;
  /** Filled on read. Not a column. */
  customerCount?: number;
  /** Filled on issue get for callers who can read artifacts. Not a column. */
  artifactCount?: number;
}

// ───────────────────────────── customers ─────────────────────────────

@Entity('customers')
@Index('UQ_customers_workspace_domain', ['workspaceId', 'domain'], {
  unique: true,
})
@Index('IDX_customers_workspace', ['workspaceId'])
@ForeignKey(() => WorkspaceEntity, ['workspaceId'], ['id'], {
  onDelete: 'CASCADE',
})
export class CustomerEntity extends Wire {
  @PrimaryColumn({ type: 'varchar' }) id: string;
  @Column({ type: 'varchar' }) workspaceId: string;
  @Column({ type: 'varchar' }) name: string;
  /** Primary domain: normalized hostname, unique per workspace. Always `domains[0]`. */
  @Column({ type: 'varchar' }) domain: string;
  /** Every domain, primary first. Disjoint across the workspace's customers (enforced in the service). */
  @Column({ type: 'jsonb', default: EMPTY_ARRAY }) domains: string[];
  @Column({ type: 'varchar', nullable: true }) logoUrl: string | null;
  @Column({ type: 'double precision', nullable: true }) revenue: number | null;
  @Column({ type: 'integer', nullable: true }) size: number | null;
  /** Id from `WorkspaceSettings.customerTiers`. */
  @Column({ type: 'varchar', nullable: true }) tierId: string | null;
  @Column({ type: 'varchar', default: 'active' }) status: CustomerStatus;
  @Column({ type: 'jsonb' }) createdBy: ActorRef;
  @Column({ type: 'timestamptz', nullable: true }) archivedAt: Date | null;
  @Column({ type: 'timestamptz', default: NOW }) createdAt: Date;
  @Column({ type: 'timestamptz', default: NOW }) updatedAt: Date;
}

/** What a customer asked for, on exactly one issue or one project. Either side's deletion removes the row. */
@Entity('customer_requests')
@Index('IDX_customer_requests_issue', ['issueId'])
@Index('IDX_customer_requests_project', ['projectId'])
@Index('IDX_customer_requests_customer', ['customerId'])
@Check(
  'CK_customer_requests_target',
  '("issueId" IS NULL) <> ("projectId" IS NULL)',
)
@ForeignKey(() => WorkspaceEntity, ['workspaceId'], ['id'], {
  onDelete: 'CASCADE',
})
@ForeignKey(() => CustomerEntity, ['customerId'], ['id'], {
  onDelete: 'CASCADE',
})
@ForeignKey(() => IssueEntity, ['issueId'], ['id'], { onDelete: 'CASCADE' })
@ForeignKey(() => ProjectEntity, ['projectId'], ['id'], { onDelete: 'CASCADE' })
export class CustomerRequestEntity extends Wire {
  @PrimaryColumn({ type: 'varchar' }) id: string;
  @Column({ type: 'varchar' }) workspaceId: string;
  @Column({ type: 'varchar' }) customerId: string;
  @Column({ type: 'varchar', nullable: true }) issueId: string | null;
  @Column({ type: 'varchar', nullable: true }) projectId: string | null;
  /** Markdown. */
  @Column({ type: 'text', nullable: true }) body: string | null;
  @Column({ type: 'boolean', default: false }) important: boolean;
  @Column({ type: 'varchar', nullable: true }) sourceUrl: string | null;
  /** Provenance when the request came through a customer-request source (see customer-intake). */
  @Column({ type: 'varchar', nullable: true }) source: IntakeProvider | null;
  @Column({ type: 'varchar', nullable: true }) externalId: string | null;
  @Column({ type: 'varchar', nullable: true }) requesterEmail: string | null;
  @Column({ type: 'varchar', nullable: true }) requesterName: string | null;
  @Column({ type: 'jsonb' }) createdBy: ActorRef;
  @Column({ type: 'timestamptz', default: NOW }) createdAt: Date;
  @Column({ type: 'timestamptz', default: NOW }) updatedAt: Date;
}

/** A person following a customer: told about new, important and delivered requests. Private to them. */
@Entity('customer_subscriptions')
@Index('UQ_customer_subscriptions_pair', ['customerId', 'userId'], {
  unique: true,
})
@Index('IDX_customer_subscriptions_user', ['workspaceId', 'userId'])
@ForeignKey(() => WorkspaceEntity, ['workspaceId'], ['id'], {
  onDelete: 'CASCADE',
})
@ForeignKey(() => CustomerEntity, ['customerId'], ['id'], {
  onDelete: 'CASCADE',
})
@ForeignKey(() => UserEntity, ['userId'], ['id'], { onDelete: 'CASCADE' })
export class CustomerSubscriptionEntity extends Wire {
  @PrimaryColumn({ type: 'varchar' }) id: string;
  @Column({ type: 'varchar' }) workspaceId: string;
  @Column({ type: 'varchar' }) customerId: string;
  @Column({ type: 'varchar' }) userId: string;
  @Column({ type: 'timestamptz', default: NOW }) createdAt: Date;

  protected override hidden() {
    return ['userId'];
  }
}

// ───────────────────────────── artifacts / decisions / dependencies ─────────────────────────────

@Entity('artifacts')
@Index('IDX_artifacts_workspace', ['workspaceId'])
@Index('IDX_artifacts_project', ['projectId'])
@Index('IDX_artifacts_issue', ['issueId'])
@Index('IDX_artifacts_upload', ['uploadId'])
@Index('IDX_artifacts_external', ['workspaceId', 'repositoryId', 'externalId'])
@ForeignKey(() => WorkspaceEntity, ['workspaceId'], ['id'], {
  onDelete: 'CASCADE',
})
// Issue/project owners are detached with SET NULL. Legacy provenance is not an active owner.
@ForeignKey(() => ProjectEntity, ['projectId'], ['id'], {
  onDelete: 'SET NULL',
})
@ForeignKey(() => IssueEntity, ['issueId'], ['id'], { onDelete: 'SET NULL' })
@ForeignKey(() => RepositoryEntity, ['repositoryId'], ['id'], {
  onDelete: 'SET NULL',
})
export class ArtifactEntity extends Wire {
  @PrimaryColumn({ type: 'varchar' }) id: string;
  @Column({ type: 'varchar' }) workspaceId: string;
  @Column({ type: 'varchar', nullable: true }) projectId: string | null;
  @Column({ type: 'varchar', nullable: true }) issueId: string | null;
  /** Historical provenance for artifacts formerly owned only by a workstream. */
  @Column({ type: 'varchar', nullable: true }) legacyWorkstreamKey:
    string | null;
  @Column({ type: 'varchar', nullable: true }) repositoryId: string | null;
  @Column({ type: 'text', nullable: true }) description: string | null;
  @Column({ type: 'varchar' }) kind: ArtifactKind;
  @Column({ type: 'varchar', default: 'other' }) provider: ArtifactProvider;
  @Column({ type: 'varchar' }) title: string;
  @Column({ type: 'varchar', nullable: true }) url: string | null;
  /** A `document` artifact that points to a Trama document; deleting the document deletes the artifact. */
  @Column({ type: 'varchar', nullable: true }) documentId: string | null;
  /** Set when the artifact is an uploaded file (`uploads.id`). Not part of the API contract; `url` is the workspace path. */
  @Column({ type: 'varchar', nullable: true }) uploadId: string | null;
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
    return ['workspaceId', 'uploadId'];
  }
}

/**
 * A file uploaded into the workspace. Documents cannot hold one: they are versioned markdown with a
 * full-text index. The bytes stay here, in the same database, and are served only while some record
 * the caller can read still points at them.
 */
@Entity('uploads')
@Index('IDX_uploads_workspace', ['workspaceId', 'createdAt'])
@ForeignKey(() => WorkspaceEntity, ['workspaceId'], ['id'], {
  onDelete: 'CASCADE',
})
export class UploadEntity extends Wire {
  @PrimaryColumn({ type: 'varchar' }) id: string;
  @Column({ type: 'varchar' }) workspaceId: string;
  @Column({ type: 'varchar' }) filename: string;
  @Column({ type: 'varchar' }) contentType: string;
  @Column({ type: 'integer' }) byteSize: number;
  @Column({ type: 'bytea' }) bytes: Buffer;
  /** False until a description, comment or artifact references it. An unreferenced row is the uploader's draft. */
  @Column({ type: 'boolean', default: false }) referenced: boolean;
  @Column({ type: 'jsonb' }) createdBy: ActorRef;
  @Column({ type: 'timestamptz', default: NOW }) createdAt: Date;

  protected override hidden() {
    return ['workspaceId', 'bytes', 'referenced'];
  }
}

/** One row per live mention of an upload. The read path uses this instead of scanning record text. */
@Entity('upload_references')
@Index('IDX_upload_references_upload', ['workspaceId', 'uploadId'])
@Index('IDX_upload_references_subject', [
  'workspaceId',
  'subjectType',
  'subjectId',
])
@ForeignKey(() => WorkspaceEntity, ['workspaceId'], ['id'], {
  onDelete: 'CASCADE',
})
@ForeignKey(() => UploadEntity, ['uploadId'], ['id'], { onDelete: 'CASCADE' })
export class UploadReferenceEntity extends Wire {
  @PrimaryColumn({ type: 'varchar' }) workspaceId: string;
  @PrimaryColumn({ type: 'varchar' }) uploadId: string;
  /** issue, project, document, document_revision, comment, or artifact. */
  @PrimaryColumn({ type: 'varchar' }) subjectType: string;
  @PrimaryColumn({ type: 'varchar' }) subjectId: string;
  /** Denormalized. Visibility uses the live owner when the two can drift. */
  @Column({ type: 'varchar', nullable: true }) projectId: string | null;
}

@Entity('decisions')
@Index('UQ_decisions_workspace_key', ['workspaceId', 'key'], { unique: true })
@ForeignKey(() => WorkspaceEntity, ['workspaceId'], ['id'], {
  onDelete: 'CASCADE',
})
@ForeignKey(() => IssueEntity, ['originIssueId'], ['id'], {
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
  @Column({ type: 'varchar', nullable: true }) originIssueId: string | null;
  @Column({ type: 'jsonb', default: EMPTY_ARRAY }) relatedIssueIds: string[];
  @Column({ type: 'jsonb', default: EMPTY_ARRAY }) legacyWorkstreamKeys: string[];
  @Column({ type: 'varchar', nullable: true }) legacyWorkstreamKey:
    string | null;
  @Column({ type: 'varchar', nullable: true }) supersededById: string | null;
  @Column({ type: 'jsonb' }) proposedBy: ActorRef;
  @Column({ type: 'varchar', nullable: true }) decidedById: string | null;
  @Column({ type: 'timestamptz', nullable: true }) decidedAt: Date | null;
  @Column({ type: 'jsonb', default: EMPTY_ARRAY }) tags: string[];
  @Column({ type: 'timestamptz', default: NOW }) createdAt: Date;
  @Column({ type: 'timestamptz', default: NOW }) updatedAt: Date;
}

/** Dependency edge. No FKs on from/to; services clean up. */
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
  @Column({ type: 'varchar' }) fromType: string;
  @Column({ type: 'varchar' }) fromId: string;
  @Column({ type: 'varchar' }) toType: string;
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
  @Column({ type: 'jsonb' }) subject: LegacySubjectRef;
  @Column({ type: 'jsonb' }) author: ActorRef;
  @Column({ type: 'text' }) body: string;
  @Column({ type: 'timestamptz', default: NOW }) createdAt: Date;
  @Column({ type: 'timestamptz', default: NOW }) updatedAt: Date;
}

/** Append-only event history. */
@Entity('domain_events')
@Index('IDX_events_workspace_at', ['workspaceId', 'at'])
@ForeignKey(() => WorkspaceEntity, ['workspaceId'], ['id'], {
  onDelete: 'CASCADE',
})
export class DomainEventEntity extends Wire {
  @PrimaryColumn({ type: 'varchar' }) id: string;
  @Column({ type: 'varchar' }) workspaceId: string;
  @Column({ type: 'timestamptz', default: NOW }) at: Date;
  @Column({ type: 'jsonb' }) actor: ActorRef;
  @Column({ type: 'varchar' }) type: string;
  @Column({ type: 'jsonb' }) subject: LegacySubjectRef;
  @Column({ type: 'varchar', nullable: true }) legacyWorkstreamKey:
    string | null;
  @Column({ type: 'jsonb', default: EMPTY_OBJECT }) data: Record<
    string,
    unknown
  >;
}

// ───────────────────────────── views, tokens, attention, counters, integrations ─────────────────────────────

@Entity('saved_views')
@Index('IDX_views_workspace', ['workspaceId'])
@Index('UQ_views_public_token', ['publicTokenHash'], { unique: true })
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
  /** Mirror of `sharing.visibility !== 'private'` (legacy flag); `sharing` is the source of truth. */
  @Column({ type: 'boolean', default: false }) shared: boolean;
  @Column({
    type: 'jsonb',
    default: () => `'{"visibility":"private","grants":[]}'`,
  })
  sharing: SharingSettings;
  /** sha256 (hex) of the public link token: the only thing the public endpoint looks up by. */
  @Column({ type: 'varchar', nullable: true }) publicTokenHash: string | null;
  /** The token itself, encrypted at rest, so managers can copy the link again. */
  @Column({ type: 'text', nullable: true }) publicTokenEnc: string | null;
  @Column({ type: 'timestamptz', default: NOW }) createdAt: Date;
  @Column({ type: 'timestamptz', default: NOW }) updatedAt: Date;

  protected override hidden() {
    return ['publicTokenHash', 'publicTokenEnc'];
  }
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
  /** Explicit permission list; only set when `scope = 'custom'`. */
  @Column({ type: 'jsonb', nullable: true }) permissions:
    ApiPermission[] | null;
  @Column({ type: 'jsonb' }) limits: TokenLimits;
  @Column({ type: 'varchar', nullable: true }) createdByUserId: string | null;
  @Column({ type: 'timestamptz', nullable: true }) lastUsedAt: Date | null;
  @Column({ type: 'timestamptz', default: NOW }) createdAt: Date;
  @Column({ type: 'timestamptz', nullable: true }) expiresAt: Date | null;

  protected override hidden() {
    return ['tokenHash', 'createdByUserId'];
  }
}

/** A message for one person about something that happened in a workspace. */
@Entity('notifications')
@Index('IDX_notifications_user', ['userId', 'workspaceId', 'createdAt'])
@ForeignKey(() => WorkspaceEntity, ['workspaceId'], ['id'], {
  onDelete: 'CASCADE',
})
@ForeignKey(() => UserEntity, ['userId'], ['id'], { onDelete: 'CASCADE' })
export class NotificationEntity extends Wire {
  @PrimaryColumn({ type: 'varchar' }) id: string;
  @Column({ type: 'varchar' }) workspaceId: string;
  @Column({ type: 'varchar' }) userId: string;
  @Column({ type: 'varchar' }) kind: NotificationRecordKind;
  @Column({ type: 'varchar' }) title: string;
  @Column({ type: 'text', nullable: true }) body: string | null;
  @Column({ type: 'jsonb' }) actor: ActorRef;
  @Column({ type: 'jsonb' }) subject: LegacySubjectRef;
  @Column({ type: 'varchar' }) link: string;
  @Column({ type: 'timestamptz', default: NOW }) createdAt: Date;
  @Column({ type: 'timestamptz', nullable: true }) readAt: Date | null;

  protected override hidden() {
    return ['userId'];
  }
}

/** A browser/device a person turned push notifications on for (Web Push subscription). */
@Entity('push_subscriptions')
@Index('UQ_push_subscriptions_endpoint', ['endpoint'], { unique: true })
@Index('IDX_push_subscriptions_user', ['userId'])
@ForeignKey(() => UserEntity, ['userId'], ['id'], { onDelete: 'CASCADE' })
export class PushSubscriptionEntity extends Wire {
  @PrimaryColumn({ type: 'varchar' }) id: string;
  @Column({ type: 'varchar' }) userId: string;
  @Column({ type: 'text' }) endpoint: string;
  @Column({ type: 'varchar' }) p256dh: string;
  @Column({ type: 'varchar' }) auth: string;
  @Column({ type: 'varchar', nullable: true }) userAgent: string | null;
  @Column({ type: 'timestamptz', default: NOW }) createdAt: Date;

  protected override hidden() {
    return ['userId', 'p256dh', 'auth'];
  }
}

/** A person's pinned entity (unique per user, workspace, type and subject). */
@Entity('favorites')
@Index('UQ_favorites_subject', ['userId', 'workspaceId', 'type', 'subjectId'], {
  unique: true,
})
@ForeignKey(() => WorkspaceEntity, ['workspaceId'], ['id'], {
  onDelete: 'CASCADE',
})
@ForeignKey(() => UserEntity, ['userId'], ['id'], { onDelete: 'CASCADE' })
export class FavoriteEntity extends Wire {
  @PrimaryColumn({ type: 'varchar' }) id: string;
  @Column({ type: 'varchar' }) workspaceId: string;
  @Column({ type: 'varchar' }) userId: string;
  @Column({ type: 'varchar' }) type: FavoriteType;
  @Column({ type: 'varchar' }) subjectId: string;
  @Column({ type: 'timestamptz', default: NOW }) createdAt: Date;

  protected override hidden() {
    return ['userId'];
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

/** Atomic per-workspace sequences: `wskey:<teamKey>`, `issue-key:<prefix>`, `adr`. */
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
    'connected' | 'error' | 'disconnected';
  @Column({ type: 'timestamptz', nullable: true }) lastSyncAt: Date | null;
  @Column({ type: 'text', nullable: true }) lastError: string | null;
  /** Provider-specific, non-secret settings. */
  @Column({ type: 'jsonb', default: EMPTY_OBJECT }) config: Record<
    string,
    unknown
  >;
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
  InviteEntity,
  FavoriteEntity,
  NotificationEntity,
  PushSubscriptionEntity,
  AgentEntity,
  TeamEntity,
  RepositoryEntity,
  ProjectEntity,
  ProjectUpdateEntity,
  DocumentEntity,
  DocumentRevisionEntity,
  MilestoneEntity,
  ReleasePipelineEntity,
  ReleaseEntity,
  InputRequestEntity,
  IssueEntity,
  CustomerEntity,
  CustomerRequestEntity,
  CustomerSubscriptionEntity,
  ArtifactEntity,
  UploadEntity,
  UploadReferenceEntity,
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
