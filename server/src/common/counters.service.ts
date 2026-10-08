import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

/**
 * Atomic per-workspace sequences (table `workspace_counters`):
 *   `ws:<teamId>`  workstream numbers per owner team (AUTH-42)
 *   `issue:<kind>` issue numbers per kind (BUG-142)
 *   `adr`          decision numbers (ADR-21)
 * Always call inside the transaction that inserts the numbered row.
 */
@Injectable()
export class CountersService {
  async next(m: EntityManager, workspaceId: string, name: string): Promise<number> {
    const rows = await m.query<{ value: number }[]>(
      `INSERT INTO "workspace_counters" ("workspaceId","name","value") VALUES ($1,$2,1)
       ON CONFLICT ("workspaceId","name") DO UPDATE SET "value" = "workspace_counters"."value" + 1
       RETURNING "value"`,
      [workspaceId, name],
    );
    return rows[0].value;
  }

  /** Ensures the counter is at least `value` (seed / import with explicit numbers). */
  async bumpTo(m: EntityManager, workspaceId: string, name: string, value: number): Promise<void> {
    await m.query(
      `INSERT INTO "workspace_counters" ("workspaceId","name","value") VALUES ($1,$2,$3)
       ON CONFLICT ("workspaceId","name") DO UPDATE SET "value" = GREATEST("workspace_counters"."value", $3)`,
      [workspaceId, name, value],
    );
  }
}
