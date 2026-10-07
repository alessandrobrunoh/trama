import { Column, Entity, ForeignKey, Index, PrimaryColumn } from 'typeorm';
import { Wire } from '../database/entities/wire.js';
import { ArtifactEntity, IntegrationConnectionEntity } from '../database/entities/index.js';

/** Webhook delivery ids already processed (idempotency). Pruned after a few days. */
@Entity('webhook_deliveries')
@Index('IDX_webhook_deliveries_received', ['receivedAt'])
@ForeignKey(() => IntegrationConnectionEntity, ['connectionId'], ['id'], { onDelete: 'CASCADE' })
export class WebhookDeliveryEntity extends Wire {
  /** `<connectionId>:<delivery id>` */
  @PrimaryColumn({ type: 'varchar' }) id: string;
  @Column({ type: 'varchar' }) connectionId: string;
  @Column({ type: 'timestamptz', default: () => 'now()' }) receivedAt: Date;
}

/** Git coordinates of a PR/MR/commit artifact, so CI events (which only carry a sha) can find it. */
@Entity('artifact_sources')
@Index('IDX_artifact_sources_repo_sha', ['repositoryId', 'headSha'])
@ForeignKey(() => ArtifactEntity, ['artifactId'], ['id'], { onDelete: 'CASCADE' })
export class ArtifactSourceEntity extends Wire {
  @PrimaryColumn({ type: 'varchar' }) artifactId: string;
  @Column({ type: 'varchar' }) workspaceId: string;
  @Column({ type: 'varchar', nullable: true }) repositoryId: string | null;
  @Column({ type: 'varchar', nullable: true }) headSha: string | null;
  @Column({ type: 'varchar', nullable: true }) headBranch: string | null;
}

export const INTEGRATION_ENTITIES = [WebhookDeliveryEntity, ArtifactSourceEntity];
