import { Column, Entity, ForeignKey, Index, PrimaryColumn } from 'typeorm';
import type {
  ActorRef,
  ExternalProvider,
  ImportCredentialRef,
  ImportErrorEntry,
  ImportMapping,
  ImportOptions,
  ImportPhase,
  ImportProgress,
  ImportSource,
  ImportStatus,
} from '../contracts/domain.js';
import { WorkspaceEntity } from '../database/entities/index.js';
import { Wire } from '../database/entities/wire.js';
import type { ResolvedPlan } from './mapping.js';

/** A tracker token kept AES-GCM encrypted (aad `<id>:tracker`). It is never serialized. */
@Entity('tracker_credentials')
@Index('IDX_tracker_credentials_workspace', ['workspaceId'])
@ForeignKey(() => WorkspaceEntity, ['workspaceId'], ['id'], { onDelete: 'CASCADE' })
export class TrackerCredentialEntity extends Wire {
  @PrimaryColumn({ type: 'varchar' }) id: string;
  @Column({ type: 'varchar' }) workspaceId: string;
  @Column({ type: 'varchar' }) provider: ExternalProvider;
  @Column({ type: 'varchar' }) account: string;
  @Column({ type: 'varchar', nullable: true }) baseUrl: string | null;
  @Column({ type: 'text' }) secret: string;
  @Column({ type: 'jsonb' }) createdBy: ActorRef;
  @Column({ type: 'timestamptz', default: () => 'now()' }) createdAt: Date;
  @Column({ type: 'timestamptz', nullable: true }) lastUsedAt: Date | null;

  protected override hidden() {
    return ['secret', 'createdBy'];
  }
}

/** Where a job stands, so it can continue after a restart: current phase and the provider's page cursor. */
export interface ImportCursor {
  phase: ImportPhase;
  cursor: string | null;
  /** What the mapping resolved to (created projects, labels…), so a resume does not discover the source again. */
  plan?: ResolvedPlan;
}

/** A background import. Persisted so it survives restarts; the runner resumes it from `cursor`. */
@Entity('import_jobs')
@Index('IDX_import_jobs_workspace', ['workspaceId', 'createdAt'])
@Index('IDX_import_jobs_active', ['status'])
@ForeignKey(() => WorkspaceEntity, ['workspaceId'], ['id'], { onDelete: 'CASCADE' })
export class ImportJobEntity extends Wire {
  @PrimaryColumn({ type: 'varchar' }) id: string;
  @Column({ type: 'varchar' }) workspaceId: string;
  @Column({ type: 'varchar' }) provider: ExternalProvider;
  @Column({ type: 'varchar', default: 'queued' }) status: ImportStatus;
  @Column({ type: 'varchar' }) sourceLabel: string;
  @Column({ type: 'jsonb' }) source: ImportSource;
  @Column({ type: 'jsonb' }) options: ImportOptions;
  @Column({ type: 'jsonb' }) mapping: ImportMapping;
  /** Which credential to read with. Never holds a token. */
  @Column({ type: 'jsonb' }) credential: ImportCredentialRef;
  @Column({ type: 'jsonb' }) progress: ImportProgress;
  @Column({ type: 'jsonb', default: () => `'[]'` }) errors: ImportErrorEntry[];
  @Column({ type: 'jsonb', nullable: true }) cursor: ImportCursor | null;
  @Column({ type: 'timestamptz', nullable: true }) waitingUntil: Date | null;
  @Column({ type: 'boolean', default: false }) cancelRequested: boolean;
  @Column({ type: 'text', nullable: true }) lastError: string | null;
  /** Bumped while a runner works on it; a job whose heartbeat is stale is picked up by another runner. */
  @Column({ type: 'timestamptz', nullable: true }) heartbeatAt: Date | null;
  @Column({ type: 'jsonb' }) createdBy: ActorRef;
  @Column({ type: 'timestamptz', default: () => 'now()' }) createdAt: Date;
  @Column({ type: 'timestamptz', nullable: true }) startedAt: Date | null;
  @Column({ type: 'timestamptz', nullable: true }) finishedAt: Date | null;

  protected override hidden() {
    return ['credential', 'cursor', 'heartbeatAt'];
  }
}

export type ImportLinkKind = 'team' | 'project' | 'milestone' | 'label' | 'comment';

/** External id -> Trama id for what an import created (everything but issues, which carry `externalRef`). */
@Entity('import_links')
@ForeignKey(() => WorkspaceEntity, ['workspaceId'], ['id'], { onDelete: 'CASCADE' })
export class ImportLinkEntity extends Wire {
  @PrimaryColumn({ type: 'varchar' }) workspaceId: string;
  @PrimaryColumn({ type: 'varchar' }) provider: ExternalProvider;
  @PrimaryColumn({ type: 'varchar' }) kind: ImportLinkKind;
  @PrimaryColumn({ type: 'varchar' }) externalId: string;
  @Column({ type: 'varchar' }) tramaId: string;
  @Column({ type: 'varchar', nullable: true }) jobId: string | null;
}

export const IMPORT_ENTITIES = [TrackerCredentialEntity, ImportJobEntity, ImportLinkEntity];
