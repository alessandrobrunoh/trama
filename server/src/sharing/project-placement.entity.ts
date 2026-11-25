import { Column, Entity, ForeignKey, Index, PrimaryColumn } from 'typeorm';
import {
  ProjectEntity,
  UserEntity,
  WorkspaceEntity,
} from '../database/entities/index.js';
import { Wire } from '../database/entities/wire.js';

/**
 * Where one person shows a project that was shared with them ("Show in" a workspace they belong to), or
 * `workspaceId` null for "hidden from Shared with me". One row per person and project; nothing is stored
 * on the project, and a row gives nobody any access.
 */
@Entity('project_placements')
@Index('UQ_project_placements_user_project', ['userId', 'projectId'], { unique: true })
@Index('IDX_project_placements_workspace', ['workspaceId'])
@ForeignKey(() => UserEntity, ['userId'], ['id'], { onDelete: 'CASCADE' })
@ForeignKey(() => ProjectEntity, ['projectId'], ['id'], { onDelete: 'CASCADE' })
@ForeignKey(() => WorkspaceEntity, ['workspaceId'], ['id'], { onDelete: 'CASCADE' })
export class ProjectPlacementEntity extends Wire {
  @PrimaryColumn({ type: 'varchar' }) id: string;
  @Column({ type: 'varchar' }) userId: string;
  @Column({ type: 'varchar' }) projectId: string;
  /** The workspace the project shows in. Null: hidden from Shared with me. */
  @Column({ type: 'varchar', nullable: true }) workspaceId: string | null;
  @Column({ type: 'integer', default: 0 }) position: number;
  @Column({ type: 'timestamptz', default: () => 'now()' }) createdAt: Date;

  protected override hidden() {
    return ['id', 'userId', 'createdAt'];
  }
}

export const SHARING_ENTITIES = [ProjectPlacementEntity];
