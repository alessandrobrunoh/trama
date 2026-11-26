import { Column, Entity, ForeignKey, Index, PrimaryColumn } from 'typeorm';
import type { ActorRef } from '../contracts/domain.js';
import { IssueEntity, WorkspaceEntity } from '../database/entities/index.js';
import { Wire } from '../database/entities/wire.js';

/** The record the agent keeps of the thread linked to a task. One row per task. */
@Entity('task_thread_records')
@Index('IDX_task_thread_records_workspace', ['workspaceId'])
@ForeignKey(() => WorkspaceEntity, ['workspaceId'], ['id'], { onDelete: 'CASCADE' })
@ForeignKey(() => IssueEntity, ['issueId'], ['id'], { onDelete: 'CASCADE' })
export class ThreadRecordEntity extends Wire {
  @PrimaryColumn({ type: 'varchar' }) issueId: string;
  @Column({ type: 'varchar' }) workspaceId: string;
  /** The thread the task linked when the record was last synced. */
  @Column({ type: 'varchar', length: 2048, nullable: true }) threadUrl: string | null;
  @Column({ type: 'text', nullable: true }) summary: string | null;
  /** Deduplicated, newest sync first. */
  @Column({ type: 'jsonb', default: () => `'[]'` }) files: string[];
  @Column({ type: 'integer', nullable: true }) turns: number | null;
  @Column({ type: 'integer', default: 0 }) syncCount: number;
  @Column({ type: 'timestamptz', default: () => 'now()' }) lastSyncAt: Date;
  @Column({ type: 'jsonb' }) lastSyncBy: ActorRef;
  @Column({ type: 'timestamptz', default: () => 'now()' }) createdAt: Date;
}

/** A decision an agent recorded for a task, scoped to repository paths, prefixes or globs. */
@Entity('task_decisions')
@Index('IDX_task_decisions_issue', ['workspaceId', 'issueId'])
@ForeignKey(() => WorkspaceEntity, ['workspaceId'], ['id'], { onDelete: 'CASCADE' })
@ForeignKey(() => IssueEntity, ['issueId'], ['id'], { onDelete: 'CASCADE' })
export class TaskDecisionEntity extends Wire {
  @PrimaryColumn({ type: 'varchar' }) id: string;
  @Column({ type: 'varchar' }) workspaceId: string;
  @Column({ type: 'varchar' }) issueId: string;
  @Column({ type: 'text' }) text: string;
  @Column({ type: 'jsonb', default: () => `'[]'` }) paths: string[];
  @Column({ type: 'varchar', length: 2048, nullable: true }) threadUrl: string | null;
  @Column({ type: 'jsonb' }) createdBy: ActorRef;
  @Column({ type: 'timestamptz', default: () => 'now()' }) createdAt: Date;
}

export const THREAD_ENTITIES = [ThreadRecordEntity, TaskDecisionEntity];
