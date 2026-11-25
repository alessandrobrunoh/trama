import { Column, Entity, ForeignKey, Index, PrimaryColumn } from 'typeorm';
import type {
  ExternalIdentityProvider,
  ExternalIdentitySource,
} from '../contracts/domain.js';
import { UserEntity } from '../database/entities/index.js';
import { Wire } from '../database/entities/wire.js';

/**
 * A login a person has in another tool. The unique index on (lower(provider), lower(host),
 * lower(login)) lives in the migration (TypeORM cannot declare an expression index).
 */
@Entity('external_identities')
@Index('IDX_external_identities_user', ['userId'])
@ForeignKey(() => UserEntity, ['userId'], ['id'], { onDelete: 'CASCADE' })
export class ExternalIdentityEntity extends Wire {
  @PrimaryColumn({ type: 'varchar' }) id: string;
  @Column({ type: 'varchar' }) userId: string;
  @Column({ type: 'varchar' }) provider: ExternalIdentityProvider;
  /** Lower-case, no scheme or path. */
  @Column({ type: 'varchar' }) host: string;
  /** As the tool spells it; uniqueness ignores case. */
  @Column({ type: 'varchar', length: 100 }) login: string;
  @Column({ type: 'varchar', default: 'manual' }) source: ExternalIdentitySource;
  @Column({ type: 'timestamptz', default: () => 'now()' }) createdAt: Date;
}

export const EXTERNAL_IDENTITY_ENTITIES = [ExternalIdentityEntity];
