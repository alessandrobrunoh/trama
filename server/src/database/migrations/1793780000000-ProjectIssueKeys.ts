import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  uniqueProjectKey,
  UNASSIGNED_ISSUE_KEY_PREFIX,
} from '../../contracts/domain.js';

type ProjectRow = { id: string; workspaceId: string; name: string };
type IssueRow = {
  id: string;
  workspaceId: string;
  key: string;
  number: number;
  kind: string;
  aliases: string[] | null;
  prefix: string;
};
type StoredLabel = {
  id: string;
  name?: string;
  color?: string;
  template?: boolean;
  scope?: string;
  [key: string]: unknown;
};

const LEGACY_LABELS = [
  { id: 'lb_bug', name: 'Bug', color: '#e11d48' },
  { id: 'lb_feature', name: 'Feature', color: '#2563eb' },
  { id: 'lb_improvement', name: 'Improvement', color: '#16a34a' },
  { id: 'lb_documentation', name: 'Documentation', color: '#7c3aed' },
] as const;

const LEGACY_ISSUE_PREFIX: Record<string, string> = {
  bug: 'BUG',
  feature: 'FEAT',
  incident: 'INC',
  tech_debt: 'DEBT',
  feedback: 'FB',
  idea: 'IDEA',
  security: 'SEC',
};

/** Give projects short unique tags, re-key issues by project, and make old type labels editable. */
export class ProjectIssueKeys1793780000000 implements MigrationInterface {
  name = 'ProjectIssueKeys1793780000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "projects" ADD "key" character varying(4)`);
    const projects = (await q.query(
      `SELECT "id", "workspaceId", "name" FROM "projects" ORDER BY "workspaceId", "createdAt", "id"`,
    )) as ProjectRow[];
    const usedByWorkspace = new Map<string, Set<string>>();
    for (const project of projects) {
      const used =
        usedByWorkspace.get(project.workspaceId) ?? new Set<string>();
      const key = uniqueProjectKey(project.name, used);
      used.add(key);
      usedByWorkspace.set(project.workspaceId, used);
      await q.query(`UPDATE "projects" SET "key" = $2 WHERE "id" = $1`, [
        project.id,
        key,
      ]);
    }
    await q.query(`ALTER TABLE "projects" ALTER COLUMN "key" SET NOT NULL`);
    await q.query(
      `CREATE UNIQUE INDEX "UQ_projects_workspace_key" ON "projects" ("workspaceId", "key")`,
    );

    const issues = (await q.query(
      `SELECT i."id", i."workspaceId", i."key", i."number", i."kind", i."aliases",
              COALESCE(p."key", $1) AS "prefix"
         FROM "issues" i
         LEFT JOIN "projects" p
           ON p."id" = i."projectId" AND p."workspaceId" = i."workspaceId"
        ORDER BY i."workspaceId", "prefix", i."createdAt", i."id"`,
      [UNASSIGNED_ISSUE_KEY_PREFIX],
    )) as IssueRow[];

    const highWaterByPrefix = new Map<string, number>();
    const scopeKey = (workspaceId: string, prefix: string) =>
      `${workspaceId}\u0000${prefix}`;
    for (const issue of issues) {
      const scope = scopeKey(issue.workspaceId, issue.prefix);
      const pattern = new RegExp(`^${issue.prefix}-([0-9]+)$`);
      for (const key of [issue.key, ...(issue.aliases ?? [])]) {
        const match = pattern.exec(key);
        if (match)
          highWaterByPrefix.set(
            scope,
            Math.max(highWaterByPrefix.get(scope) ?? 0, Number(match[1])),
          );
      }
    }

    const counters = new Map<
      string,
      { workspaceId: string; prefix: string; value: number }
    >();
    for (const issue of issues) {
      const scope = scopeKey(issue.workspaceId, issue.prefix);
      const number = (highWaterByPrefix.get(scope) ?? 0) + 1;
      highWaterByPrefix.set(scope, number);
      const key = `${issue.prefix}-${number}`;
      const aliases = [...new Set([...(issue.aliases ?? []), issue.key])];
      await q.query(
        `UPDATE "issues" SET "key" = $2, "number" = $3, "aliases" = $4::jsonb
          WHERE "workspaceId" = $1 AND "id" = $5`,
        [issue.workspaceId, key, number, JSON.stringify(aliases), issue.id],
      );
      counters.set(scope, {
        workspaceId: issue.workspaceId,
        prefix: issue.prefix,
        value: number,
      });
    }
    for (const counter of counters.values())
      await q.query(
        `INSERT INTO "workspace_counters" ("workspaceId", "name", "value")
         VALUES ($1, $2, $3)
         ON CONFLICT ("workspaceId", "name")
         DO UPDATE SET "value" = GREATEST("workspace_counters"."value", EXCLUDED."value")`,
        [counter.workspaceId, `issue-key:${counter.prefix}`, counter.value],
      );

    await this.convertLegacyLabels(q);
  }

  public async down(q: QueryRunner): Promise<void> {
    const issues = (await q.query(
      `SELECT "id", "workspaceId", "key", "kind", "aliases", "createdAt"
         FROM "issues" ORDER BY "workspaceId", "kind", "createdAt", "id"`,
    )) as Omit<IssueRow, 'number' | 'prefix'>[];
    const highWaterByKind = new Map<string, number>();
    const scopeKey = (workspaceId: string, kind: string) =>
      `${workspaceId}\u0000${kind}`;
    for (const issue of issues) {
      const prefix = LEGACY_ISSUE_PREFIX[issue.kind] ?? 'BUG';
      const scope = scopeKey(issue.workspaceId, issue.kind);
      const pattern = new RegExp(`^${prefix}-([0-9]+)$`);
      for (const key of [issue.key, ...(issue.aliases ?? [])]) {
        const match = pattern.exec(key);
        if (match)
          highWaterByKind.set(
            scope,
            Math.max(highWaterByKind.get(scope) ?? 0, Number(match[1])),
          );
      }
    }
    const counters = new Map<
      string,
      { workspaceId: string; kind: string; value: number }
    >();
    for (const issue of issues) {
      const prefix = LEGACY_ISSUE_PREFIX[issue.kind] ?? 'BUG';
      const scope = scopeKey(issue.workspaceId, issue.kind);
      const number = (highWaterByKind.get(scope) ?? 0) + 1;
      highWaterByKind.set(scope, number);
      const aliases = [...new Set([...(issue.aliases ?? []), issue.key])];
      await q.query(
        `UPDATE "issues" SET "key" = $2, "number" = $3, "aliases" = $4::jsonb
          WHERE "workspaceId" = $1 AND "id" = $5`,
        [
          issue.workspaceId,
          `${prefix}-${number}`,
          number,
          JSON.stringify(aliases),
          issue.id,
        ],
      );
      counters.set(scope, {
        workspaceId: issue.workspaceId,
        kind: issue.kind,
        value: number,
      });
    }
    for (const counter of counters.values())
      await q.query(
        `INSERT INTO "workspace_counters" ("workspaceId", "name", "value")
         VALUES ($1, $2, $3)
         ON CONFLICT ("workspaceId", "name")
         DO UPDATE SET "value" = GREATEST("workspace_counters"."value", EXCLUDED."value")`,
        [counter.workspaceId, `issue:${counter.kind}`, counter.value],
      );

    await this.restoreLegacyLabels(q);
    await q.query(`DROP INDEX "UQ_projects_workspace_key"`);
    await q.query(`ALTER TABLE "projects" DROP COLUMN "key"`);
  }

  private async convertLegacyLabels(q: QueryRunner): Promise<void> {
    const workspaces = (await q.query(
      `SELECT "id", "settings" FROM "workspaces"`,
    )) as { id: string; settings: Record<string, unknown> | null }[];
    for (const workspace of workspaces) {
      const settings = workspace.settings ?? {};
      const labels = Array.isArray(settings['labels'])
        ? [...(settings['labels'] as StoredLabel[])]
        : [];
      let changed = false;
      for (const legacy of LEGACY_LABELS) {
        const index = labels.findIndex((label) => label.id === legacy.id);
        if (index >= 0) {
          labels[index] = { ...labels[index], template: false, scope: 'issue' };
          changed = true;
          continue;
        }
        const [used] = (await q.query(
          `SELECT EXISTS (
             SELECT 1 FROM "issues" WHERE "workspaceId" = $1 AND "labels" ? $2
           ) AS "used"`,
          [workspace.id, legacy.id],
        )) as { used: boolean }[];
        if (used?.used) {
          labels.push({
            ...legacy,
            template: false,
            scope: 'issue',
          });
          changed = true;
        }
      }
      if (changed)
        await q.query(
          `UPDATE "workspaces" SET "settings" = $2::jsonb WHERE "id" = $1`,
          [workspace.id, JSON.stringify({ ...settings, labels })],
        );
    }
  }

  private async restoreLegacyLabels(q: QueryRunner): Promise<void> {
    const workspaces = (await q.query(
      `SELECT "id", "settings" FROM "workspaces"`,
    )) as { id: string; settings: Record<string, unknown> | null }[];
    const legacyIds = new Set<string>(LEGACY_LABELS.map((label) => label.id));
    for (const workspace of workspaces) {
      const settings = workspace.settings;
      const labels = Array.isArray(settings?.['labels'])
        ? (settings['labels'] as StoredLabel[])
        : [];
      if (!labels.some((label) => legacyIds.has(label.id))) continue;
      const restored = labels.map((label) =>
        legacyIds.has(label.id)
          ? { ...label, template: true, scope: 'issue' }
          : label,
      );
      await q.query(
        `UPDATE "workspaces" SET "settings" = $2::jsonb WHERE "id" = $1`,
        [
          workspace.id,
          JSON.stringify({ ...(settings ?? {}), labels: restored }),
        ],
      );
    }
  }
}
