import { Column, Entity, ForeignKey, Index, PrimaryColumn } from 'typeorm';
import type { ActorRef, IntakeItemStatus, IntakeProvider } from '../contracts/domain.js';
import { CustomerEntity, CustomerRequestEntity, ProjectEntity, WorkspaceEntity } from '../database/entities/index.js';
import { Wire } from '../database/entities/wire.js';

/** One endpoint per provider connection. The secret is AES-GCM encrypted (aad `<id>:intake`) and never serialized. */
@Entity('customer_intake_sources')
@Index('IDX_customer_intake_sources_workspace', ['workspaceId'])
@ForeignKey(() => WorkspaceEntity, ['workspaceId'], ['id'], { onDelete: 'CASCADE' })
@ForeignKey(() => ProjectEntity, ['targetProjectId'], ['id'], { onDelete: 'SET NULL' })
export class IntakeSourceEntity extends Wire {
  @PrimaryColumn({ type: 'varchar' }) id: string;
  @Column({ type: 'varchar' }) workspaceId: string;
  @Column({ type: 'varchar' }) provider: IntakeProvider;
  @Column({ type: 'varchar' }) name: string;
  @Column({ type: 'text', nullable: true }) secret: string | null;
  @Column({ type: 'boolean', default: true }) enabled: boolean;
  @Column({ type: 'boolean', default: true }) autoCreateCustomers: boolean;
  @Column({ type: 'varchar', nullable: true }) targetProjectId: string | null;
  /** Non-secret provider settings (Zendesk `subdomain`). */
  @Column({ type: 'jsonb', default: () => `'{}'` }) config: { subdomain?: string };
  @Column({ type: 'timestamptz', nullable: true }) lastReceivedAt: Date | null;
  @Column({ type: 'jsonb' }) createdBy: ActorRef;
  @Column({ type: 'timestamptz', default: () => 'now()' }) createdAt: Date;
  @Column({ type: 'timestamptz', default: () => 'now()' }) updatedAt: Date;

  protected override hidden() {
    return ['secret', 'createdBy'];
  }
}

/** A request that arrived through a source. Unique per (source, externalId); `pending` ones are the triage inbox. */
@Entity('customer_intake_items')
@Index('UQ_customer_intake_items_external', ['sourceId', 'externalId'], { unique: true })
@Index('IDX_customer_intake_items_inbox', ['workspaceId', 'status', 'receivedAt'])
@ForeignKey(() => WorkspaceEntity, ['workspaceId'], ['id'], { onDelete: 'CASCADE' })
@ForeignKey(() => IntakeSourceEntity, ['sourceId'], ['id'], { onDelete: 'CASCADE' })
@ForeignKey(() => CustomerEntity, ['customerId'], ['id'], { onDelete: 'SET NULL' })
@ForeignKey(() => CustomerRequestEntity, ['customerRequestId'], ['id'], { onDelete: 'SET NULL' })
export class IntakeItemEntity extends Wire {
  @PrimaryColumn({ type: 'varchar' }) id: string;
  @Column({ type: 'varchar' }) workspaceId: string;
  @Column({ type: 'varchar' }) sourceId: string;
  @Column({ type: 'varchar' }) provider: IntakeProvider;
  @Column({ type: 'varchar' }) externalId: string;
  @Column({ type: 'varchar', nullable: true }) externalUrl: string | null;
  @Column({ type: 'varchar', nullable: true }) requesterEmail: string | null;
  @Column({ type: 'varchar', nullable: true }) requesterName: string | null;
  @Column({ type: 'varchar', nullable: true }) subject: string | null;
  @Column({ type: 'text', default: '' }) body: string;
  @Column({ type: 'varchar', default: 'pending' }) status: IntakeItemStatus;
  @Column({ type: 'varchar', nullable: true }) customerId: string | null;
  @Column({ type: 'varchar', nullable: true }) issueId: string | null;
  @Column({ type: 'varchar', nullable: true }) projectId: string | null;
  @Column({ type: 'varchar', nullable: true }) customerRequestId: string | null;
  @Column({ type: 'timestamptz', default: () => 'now()' }) receivedAt: Date;
  @Column({ type: 'timestamptz', nullable: true }) resolvedAt: Date | null;
}

export const INTAKE_ENTITIES = [IntakeSourceEntity, IntakeItemEntity];
