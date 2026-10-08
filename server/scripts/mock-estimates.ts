// Adds (or removes) ~12 weeks of mock issue history so the statistics → "Estimates & time" tab has data.
//
//   npm run db:mock-estimates                    add to workspace "acme" (skips when already present)
//   npm run db:mock-estimates -- --remove        delete everything this script created
//   npm run db:mock-estimates -- --workspace <slug> --dry-run
//
// Idempotent and non-destructive: mock rows are tagged by id prefix (in_mock_ / ev_mock_ / ms_mock_). Real
// issues only get a missing estimate and missing startedAt/completedAt. Dates are relative to "now".
import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { DataSource } from 'typeorm';
import { resolveWorkspaceSettings, type IssueKind } from '../src/contracts/domain.js';
import { dataSourceOptions } from '../src/database/data-source.options.js';
import {
  DomainEventEntity,
  IssueEntity,
  MembershipEntity,
  MilestoneEntity,
  TeamEntity,
  WorkspaceEntity,
  WorkstreamEntity,
} from '../src/database/entities/index.js';
import {
  MOCK_EVENT_PREFIX,
  MOCK_ISSUE_PREFIX,
  MOCK_MILESTONE_PREFIX,
  generateMockHistory,
  resolveScale,
} from '../src/database/mock-history.js';

if (existsSync('.env')) process.loadEnvFile('.env');

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

async function main() {
  const ds = new DataSource(dataSourceOptions());
  await ds.initialize();
  try {
    const workspaces = ds.getRepository(WorkspaceEntity);
    const slug = option('workspace');
    const ws = slug
      ? await workspaces.findOneBy({ slug })
      : ((await workspaces.findOneBy({ slug: 'acme' })) ?? ((await workspaces.count()) === 1 ? (await workspaces.find())[0] : null));
    if (!ws) throw new Error(`Workspace not found (${slug ?? 'acme'}); pass --workspace <slug>`);
    const workspaceId = ws.id;
    console.log(`Workspace ${ws.name} (${ws.slug})`);

    if (flag('remove')) {
      await ds.transaction(async (m) => {
        // DELETE … RETURNING comes back as [rows, affectedCount]
        const q = async (sql: string) => ((await m.query(sql, [workspaceId])) as [unknown[], number])[1];
        const events = await q(`DELETE FROM "domain_events" WHERE "workspaceId" = $1 AND "id" LIKE '${MOCK_EVENT_PREFIX}%' RETURNING 1`);
        const comments = await q(`DELETE FROM "comments" WHERE "workspaceId" = $1 AND "subject"->>'id' LIKE '${MOCK_ISSUE_PREFIX}%' RETURNING 1`);
        const issues = await q(`DELETE FROM "issues" WHERE "workspaceId" = $1 AND "id" LIKE '${MOCK_ISSUE_PREFIX}%' RETURNING 1`);
        const milestones = await q(`DELETE FROM "milestones" WHERE "workspaceId" = $1 AND "id" LIKE '${MOCK_MILESTONE_PREFIX}%' RETURNING 1`);
        console.log(`Removed ${issues} issues, ${milestones} milestones, ${events} events, ${comments} comments.`);
      });
      return;
    }

    const issueRepo = ds.getRepository(IssueEntity);
    const all = await issueRepo.findBy({ workspaceId });
    const mockExists = all.some((i) => i.id.startsWith(MOCK_ISSUE_PREFIX));
    const real = all.filter((i) => !i.id.startsWith(MOCK_ISSUE_PREFIX));

    const memberships = await ds.getRepository(MembershipEntity).findBy({ workspaceId });
    const counters = (await ds.query(`SELECT "name","value" FROM "workspace_counters" WHERE "workspaceId" = $1 AND "name" LIKE 'issue:%'`, [workspaceId])) as {
      name: string;
      value: number;
    }[];
    const issueCounters: Partial<Record<IssueKind, number>> = {};
    for (const c of counters) issueCounters[c.name.slice('issue:'.length) as IssueKind] = Number(c.value);
    for (const i of all) issueCounters[i.kind] = Math.max(issueCounters[i.kind] ?? 0, i.number);

    const history = generateMockHistory({
      now: Date.now(),
      workspaceId,
      estimateScale: resolveScale(resolveWorkspaceSettings(ws.settings).estimateScale),
      userIds: memberships.filter((x) => x.role !== 'viewer').map((x) => x.userId),
      teamIds: (await ds.getRepository(TeamEntity).findBy({ workspaceId })).map((t) => t.id),
      workstreams: (await ds.getRepository(WorkstreamEntity).findBy({ workspaceId })).map((w) => ({ id: w.id, key: w.key, ownerTeamId: w.ownerTeamId, status: w.status, projectId: w.projectId })),
      milestones: (await ds.getRepository(MilestoneEntity).findBy({ workspaceId })).map((m) => ({ id: m.id, projectId: m.projectId })),
      issueCounters,
      existingIssues: real,
    });

    if (flag('dry-run')) {
      console.log(`Dry run: would add ${mockExists ? 0 : history.issues.length} issues, ${mockExists ? 0 : history.events.length} events, ${mockExists ? 0 : history.milestones.length} milestones; patch ${history.patches.length} existing issues.`);
      return;
    }

    await ds.transaction(async (m) => {
      for (const p of history.patches) await m.update(IssueEntity, { id: p.id, workspaceId }, p.set);
      if (mockExists) return;
      await m.insert(MilestoneEntity, history.milestones as never[]);
      for (let i = 0; i < history.issues.length; i += 100) await m.insert(IssueEntity, history.issues.slice(i, i + 100) as never[]);
      for (let i = 0; i < history.events.length; i += 100) await m.insert(DomainEventEntity, history.events.slice(i, i + 100) as never[]);
      for (const [name, value] of Object.entries(history.counters))
        await m.query(
          `INSERT INTO "workspace_counters" ("workspaceId","name","value") VALUES ($1,$2,$3)
           ON CONFLICT ("workspaceId","name") DO UPDATE SET "value" = GREATEST("workspace_counters"."value", $3)`,
          [workspaceId, name, value],
        );
    });
    console.log(`Filled estimates/timestamps on ${history.patches.length} existing issues.`);
    console.log(
      mockExists
        ? 'Mock history already present: nothing else to add.'
        : `Added ${history.issues.length} issues, ${history.milestones.length} milestones and ${history.events.length} events.`,
    );
  } finally {
    await ds.destroy();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
