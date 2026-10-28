import { Column, Entity, ForeignKey, Index, PrimaryColumn } from 'typeorm';
import {
  IssueEntity,
  ProjectEntity,
  UserEntity,
  WorkspaceEntity,
} from '../database/entities/index.js';
import { Wire } from '../database/entities/wire.js';

/** One stretch of work. `endedAt` null means the timer is still running. */
@Entity('time_entries')
@Index('IDX_time_entries_user', ['workspaceId', 'userId', 'startedAt'])
@ForeignKey(() => WorkspaceEntity, ['workspaceId'], ['id'], { onDelete: 'CASCADE' })
@ForeignKey(() => UserEntity, ['userId'], ['id'], { onDelete: 'CASCADE' })
@ForeignKey(() => ProjectEntity, ['projectId'], ['id'], { onDelete: 'SET NULL' })
@ForeignKey(() => IssueEntity, ['issueId'], ['id'], { onDelete: 'SET NULL' })
export class TimeEntryEntity extends Wire {
  @PrimaryColumn({ type: 'varchar' }) id: string;
  @Column({ type: 'varchar' }) workspaceId: string;
  @Column({ type: 'varchar' }) userId: string;
  @Column({ type: 'varchar', nullable: true }) projectId: string | null;
  @Column({ type: 'varchar', nullable: true }) issueId: string | null;
  @Column({ type: 'varchar', default: '' }) description: string;
  @Column({ type: 'timestamptz' }) startedAt: Date;
  @Column({ type: 'timestamptz', nullable: true }) endedAt: Date | null;
  @Column({ type: 'timestamptz', default: () => 'now()' }) createdAt: Date;
  @Column({ type: 'timestamptz', default: () => 'now()' }) updatedAt: Date;
}

export const TIME_ENTRY_ENTITIES = [TimeEntryEntity];
