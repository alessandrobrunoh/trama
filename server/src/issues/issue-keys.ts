import type { EntityManager } from 'typeorm';
import { UNASSIGNED_ISSUE_KEY_PREFIX } from '../contracts/domain.js';
import type { CountersService } from '../common/counters.service.js';
import type { IssueEntity } from '../database/entities/index.js';
import { notFound } from '../common/util.js';

export type IssueRekeyReason =
  'project_changed' | 'project_tag_changed' | 'project_deleted';

export interface IssueKeyChange {
  issueId: string;
  from: string;
  to: string;
  fromProjectId: string | null;
  toProjectId: string | null;
  reason: IssueRekeyReason;
}

/** Project tags are locked while resolving the prefix so issue creation and tag edits serialize. */
export async function issueKeyPrefix(
  manager: EntityManager,
  workspaceId: string,
  projectId: string | null,
): Promise<string> {
  if (!projectId) return UNASSIGNED_ISSUE_KEY_PREFIX;
  const rows = (await manager.query(
    `SELECT "key" FROM "projects" WHERE "workspaceId" = $1 AND "id" = $2 FOR SHARE`,
    [workspaceId, projectId],
  )) as { key: string }[];
  if (!rows[0]) throw notFound('Project', projectId);
  return rows[0].key;
}

/** Allocate by key prefix and account for keys still retained as aliases. Call inside the write transaction. */
export async function allocateIssueNumbers(
  manager: EntityManager,
  counters: CountersService,
  workspaceId: string,
  prefix: string,
  count: number,
): Promise<number[]> {
  if (count <= 0) return [];
  const name = `issue-key:${prefix}`;
  const existing = (await manager.query(
    `SELECT "value" FROM "workspace_counters" WHERE "workspaceId" = $1 AND "name" = $2`,
    [workspaceId, name],
  )) as { value: number }[];
  let first: number;
  if (existing.length) {
    first = await counters.next(manager, workspaceId, name);
  } else {
    const rows = (await manager.query(
      `SELECT COALESCE(MAX((regexp_match(known."issueKey", '^' || $2 || '-([0-9]+)$'))[1]::integer), 0) AS "floor"
         FROM (
           SELECT "key" AS "issueKey" FROM "issues" WHERE "workspaceId" = $1
           UNION ALL
           SELECT a."issueKey"
             FROM "issues" i
             CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(i."aliases", '[]'::jsonb)) a("issueKey")
            WHERE i."workspaceId" = $1
         ) known
        WHERE known."issueKey" ~ ('^' || $2 || '-[0-9]+$')`,
      [workspaceId, prefix],
    )) as { floor: number | string }[];
    first = await counters.nextAbove(
      manager,
      workspaceId,
      name,
      Number(rows[0]?.floor ?? 0),
    );
  }
  const numbers = [first];
  for (let i = 1; i < count; i++)
    numbers.push(await counters.next(manager, workspaceId, name));
  return numbers;
}

/** Re-key existing issues under a new prefix, retaining their previous keys as look-up aliases. */
export async function rekeyIssues(
  manager: EntityManager,
  counters: CountersService,
  workspaceId: string,
  issues: IssueEntity[],
  prefix: string,
  toProjectId: string | null,
  reason: IssueRekeyReason,
  now = new Date(),
): Promise<IssueKeyChange[]> {
  const numbers = await allocateIssueNumbers(
    manager,
    counters,
    workspaceId,
    prefix,
    issues.length,
  );
  return issues.map((issue, index) => {
    const from = issue.key;
    const fromProjectId = issue.projectId;
    const number = numbers[index];
    const to = `${prefix}-${number}`;
    issue.aliases = [...new Set([...issue.aliases, from])];
    issue.number = number;
    issue.key = to;
    issue.updatedAt = now;
    return { issueId: issue.id, from, to, fromProjectId, toProjectId, reason };
  });
}
