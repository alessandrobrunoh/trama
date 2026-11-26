import { ConflictException } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { freshWorkspaceRoles, type Role } from '../contracts/domain.js';
import { isUniqueViolation, uid } from '../common/util.js';
import { MembershipEntity, WorkspaceEntity } from '../database/entities/index.js';
import { baseSlug, slugWithSuffix } from './workspace-slug.js';

const ATTEMPTS = 6;

/**
 * The person's personal workspace, created when they do not have one yet (sign-up, and a login that finds
 * none). Named after them, with a slug derived from the name that is free and not reserved. Idempotent and safe
 * under concurrency: the partial unique index on `primaryOwnerId` allows one, and a slug collision retries.
 */
export async function ensurePersonalWorkspace(
  ds: DataSource,
  user: { id: string; name: string },
): Promise<WorkspaceEntity & { role: Role }> {
  const repo = ds.getRepository(WorkspaceEntity);
  const find = () => repo.findOneBy({ primaryOwnerId: user.id, personal: true });
  const existing = await find();
  if (existing) return Object.assign(existing, { role: 'owner' as Role });

  const root = baseSlug(user.name, 'personal');
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    let slug = root;
    for (let n = 2; await repo.existsBy({ slug }); n++) slug = slugWithSuffix(root, n + attempt);
    try {
      const workspace = await ds.transaction(async (m) => {
        const created = await m.save(
          m.create(WorkspaceEntity, {
            id: uid('ws'),
            name: user.name.trim().slice(0, 80) || 'Personal',
            slug,
            primaryOwnerId: user.id,
            personal: true,
            settings: { roles: freshWorkspaceRoles() },
          }),
        );
        await m.save(
          m.create(MembershipEntity, { id: uid('mb'), workspaceId: created.id, userId: user.id, role: 'owner' }),
        );
        return created;
      });
      return Object.assign(workspace, { role: 'owner' as Role });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // either the person already got one in a parallel request, or the slug was taken in between
      const raced = await find();
      if (raced) return Object.assign(raced, { role: 'owner' as Role });
    }
  }
  throw new ConflictException('Could not pick an address for your personal workspace');
}
