import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

/**
 * Atomic per-workspace sequences (table `workspace_counters`):
 *   `wskey:<KEY>`  workstream numbers per team key (AUTH-42); keyed by the key, not the team id, so the
 *                  sequence survives deleting and recreating a team with the same key
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

  /**
   * Like `next`, but never returns a number `<= floor`: one atomic statement that moves the counter to at
   * least `floor` and then increments it. Pass the highest number already used by rows that share the key
   * prefix, so a lagging counter can never hand out a key that exists. Concurrent callers serialize on the
   * counter row and each get a distinct number.
   */
  async nextAbove(m: EntityManager, workspaceId: string, name: string, floor: number): Promise<number> {
    const rows = await m.query<{ value: number }[]>(
      `INSERT INTO "workspace_counters" ("workspaceId","name","value") VALUES ($1,$2,$3 + 1)
       ON CONFLICT ("workspaceId","name") DO UPDATE SET "value" = GREATEST("workspace_counters"."value", $3) + 1
       RETURNING "value"`,
      [workspaceId, name, floor],
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
