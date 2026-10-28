import { Column, Entity, ForeignKey, Index, PrimaryColumn } from 'typeorm';
import type { ActorRef } from '../contracts/domain.js';
import {
  IssueEntity,
  ProjectEntity,
  WorkspaceEntity,
} from '../database/entities/index.js';
import { Wire } from '../database/entities/wire.js';

/**
 * One LunaGest panel login per workspace.
 * `secret` is AES-GCM (aad `<id>:lunagest`) of `{ username, password, apiKey }` and is never serialized.
 */
@Entity('lunagest_connections')
@Index('UQ_lunagest_connections_workspace', ['workspaceId'], { unique: true })
@ForeignKey(() => WorkspaceEntity, ['workspaceId'], ['id'], {
  onDelete: 'CASCADE',
})
export class LunaGestConnectionEntity extends Wire {
  @PrimaryColumn({ type: 'varchar' }) id: string;
  @Column({ type: 'varchar' }) workspaceId: string;
  @Column({ type: 'varchar' }) baseUrl: string;
  /** The username or email. Not a secret. */
  @Column({ type: 'varchar' }) account: string;
  @Column({ type: 'text' }) secret: string;
  @Column({ type: 'jsonb' }) createdBy: ActorRef;
  @Column({ type: 'timestamptz', default: () => 'now()' }) createdAt: Date;
  @Column({ type: 'timestamptz', default: () => 'now()' }) updatedAt: Date;

  protected override hidden() {
    return ['secret'];
  }
}

/** One Trama project bound to one LunaGest project. The remote id is unique inside the workspace. */
@Entity('lunagest_project_links')
@Index('UQ_lunagest_project_links_remote', ['workspaceId', 'remoteProjectId'], {
  unique: true,
})
@ForeignKey(() => ProjectEntity, ['projectId'], ['id'], { onDelete: 'CASCADE' })
@ForeignKey(() => WorkspaceEntity, ['workspaceId'], ['id'], {
  onDelete: 'CASCADE',
})
@ForeignKey(() => LunaGestConnectionEntity, ['connectionId'], ['id'], {
  onDelete: 'CASCADE',
})
export class LunaGestProjectLinkEntity extends Wire {
  @PrimaryColumn({ type: 'varchar' }) projectId: string;
  @Column({ type: 'varchar' }) workspaceId: string;
  @Column({ type: 'varchar' }) connectionId: string;
  @Column({ type: 'varchar' }) remoteProjectId: string;
  @Column({ type: 'varchar' }) remoteProjectName: string;
  /** Last project name both sides agreed. Null until a realign sees them match or a pull. */
  @Column({ type: 'text', nullable: true }) syncedName: string | null;
  @Column({ type: 'text', nullable: true }) syncedDescription: string | null;
  @Column({ type: 'timestamptz', default: () => 'now()' }) createdAt: Date;
  @Column({ type: 'timestamptz', default: () => 'now()' }) updatedAt: Date;
}

export type LunaGestIssueLinkState = 'linked' | 'local_only' | 'push_failed';

/** One Trama issue bound to at most one LunaGest task. A failed push keeps the issue. */
@Entity('lunagest_issue_links')
@Index('UQ_lunagest_issue_links_remote', ['workspaceId', 'remoteTaskId'], {
  unique: true,
})
@ForeignKey(() => IssueEntity, ['issueId'], ['id'], { onDelete: 'CASCADE' })
@ForeignKey(() => WorkspaceEntity, ['workspaceId'], ['id'], {
  onDelete: 'CASCADE',
})
export class LunaGestIssueLinkEntity extends Wire {
  @PrimaryColumn({ type: 'varchar' }) issueId: string;
  @Column({ type: 'varchar' }) workspaceId: string;
  @Column({ type: 'varchar', nullable: true }) remoteTaskId: string | null;
  @Column({ type: 'varchar' }) state: LunaGestIssueLinkState;
  @Column({ type: 'text', nullable: true }) lastError: string | null;
  @Column({ type: 'timestamptz', nullable: true }) lastSyncedAt: Date | null;
  /** Last title and description both sides agreed. Null until a push or a realign. */
  @Column({ type: 'text', nullable: true }) syncedTitle: string | null;
  @Column({ type: 'text', nullable: true }) syncedBody: string | null;
  @Column({ type: 'timestamptz', default: () => 'now()' }) createdAt: Date;
  @Column({ type: 'timestamptz', default: () => 'now()' }) updatedAt: Date;
}

export const LUNAGEST_ENTITIES = [
  LunaGestConnectionEntity,
  LunaGestProjectLinkEntity,
  LunaGestIssueLinkEntity,
];
