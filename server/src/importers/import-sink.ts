import type { DataSource, EntityManager } from 'typeorm';
import {
  ISSUE_KEY_PREFIX,
  LABEL_SWATCHES,
  resolveLabelCatalog,
  type ActorRef,
  type ExternalProvider,
  type ExternalRef,
  type ImportMapping,
  type ImportTarget,
  type WorkspaceLabel,
} from '../contracts/domain.js';
import type { CountersService } from '../common/counters.service.js';
import { isUniqueViolation, uid } from '../common/util.js';
import {
  CommentEntity,
  IssueEntity,
  MilestoneEntity,
  ProjectEntity,
  TeamEntity,
  WorkspaceEntity,
} from '../database/entities/index.js';
import type { MilestonesService } from '../milestones/milestones.service.js';
import type { ProjectsService } from '../projects/projects.service.js';
import type { TeamsService } from '../teams/teams.service.js';
import { ImportFatalError, type ImportSink } from './import-engine.js';
import { ImportLinkEntity, type ImportLinkKind } from './entities.js';
import { deriveTeamKey, labelColor, labelName, matchByName, type NewIssue, type ResolvedPlan } from './mapping.js';
import type { Discovery } from './types.js';

const CUSTOM_LABELS_MAX = 100;
const EXTERNAL_REF_INDEX = 'UQ_issues_external_ref';

export interface SinkDeps {
  ds: DataSource;
  counters: CountersService;
  teams: TeamsService;
  projects: ProjectsService;
  milestones: MilestonesService;
}

/**
 * Writes an import into one workspace. Every query carries the workspace id, so a job can only ever see
 * and touch its own workspace's rows. Imported issues are written directly (no per-issue domain event):
 * a 5,000-issue import must not wake every open browser 5,000 times; the job emits its own events.
 */
export class TypeormImportSink implements ImportSink {
  constructor(
    private readonly deps: SinkDeps,
    private readonly workspaceId: string,
    private readonly actor: ActorRef,
    private readonly jobId: string,
    private readonly provider: ExternalProvider,
  ) {}

  private get ds() {
    return this.deps.ds;
  }

  // ───────────── links ─────────────

  private async link(kind: ImportLinkKind, externalId: string): Promise<string | null> {
    const row = await this.ds
      .getRepository(ImportLinkEntity)
      .findOneBy({ workspaceId: this.workspaceId, provider: this.provider, kind, externalId });
    return row?.tramaId ?? null;
  }

  private async saveLink(kind: ImportLinkKind, externalId: string, tramaId: string, m: EntityManager = this.ds.manager) {
    await m
      .createQueryBuilder()
      .insert()
      .into(ImportLinkEntity)
      .values({ workspaceId: this.workspaceId, provider: this.provider, kind, externalId, tramaId, jobId: this.jobId })
      .orUpdate(['tramaId', 'jobId'], ['workspaceId', 'provider', 'kind', 'externalId'])
      .execute();
  }

  private async resolveTarget(
    kind: ImportLinkKind,
    label: string,
    externalId: string,
    target: ImportTarget | undefined,
    exists: (id: string) => Promise<boolean>,
    create: () => Promise<string>,
  ): Promise<string | null> {
    if (!target || target.action === 'skip') return null;
    if (target.action === 'map') {
      if (!(await exists(target.id))) throw new ImportFatalError(`The ${label} you mapped to no longer exists`);
      return target.id;
    }
    const linked = await this.link(kind, externalId);
    if (linked && (await exists(linked))) return linked;
    const id = await create();
    await this.saveLink(kind, externalId, id);
    return id;
  }

  // ───────────── plan ─────────────

  async resolvePlan(discovery: Discovery, mapping: ImportMapping): Promise<ResolvedPlan> {
    const ws = this.workspaceId;
    const plan: ResolvedPlan = { teams: {}, projects: {}, labels: {}, milestones: {}, users: {}, statuses: { ...mapping.statuses } };

    const teamKeys = new Set((await this.ds.getRepository(TeamEntity).findBy({ workspaceId: ws })).map((t) => t.key));
    for (const t of discovery.teams) {
      plan.teams[t.id] = await this.resolveTarget(
        'team',
        'team',
        t.id,
        mapping.teams[t.id],
        (id) => this.ds.getRepository(TeamEntity).existsBy({ id, workspaceId: ws }),
        async () => {
          const key = deriveTeamKey(t.key, t.name, teamKeys);
          teamKeys.add(key);
          return (await this.deps.teams.create(ws, this.actor, { name: t.name.slice(0, 80), key, memberIds: [] })).id;
        },
      );
    }

    const projects = await this.ds.getRepository(ProjectEntity).findBy({ workspaceId: ws });
    for (const p of discovery.projects) {
      plan.projects[p.id] = await this.resolveTarget(
        'project',
        'project',
        p.id,
        mapping.projects[p.id],
        (id) => this.ds.getRepository(ProjectEntity).existsBy({ id, workspaceId: ws }),
        async () => {
          // A project with this name may already exist from an earlier run whose link was lost: reuse it.
          const same = matchByName(p.name, projects);
          if (same) return same.id;
          return (await this.deps.projects.create(ws, this.actor, { name: p.name.slice(0, 120), color: labelColor(p.color) })).id;
        },
      );
    }

    for (const m of discovery.milestones) {
      const projectId = m.projectId ? plan.projects[m.projectId] : null;
      if (!projectId) {
        plan.milestones[m.id] = null;
        continue;
      }
      plan.milestones[m.id] = await this.resolveTarget(
        'milestone',
        'milestone',
        m.id,
        { action: 'create' },
        (id) => this.ds.getRepository(MilestoneEntity).existsBy({ id, workspaceId: ws, projectId }),
        async () => {
          const same = await this.ds.getRepository(MilestoneEntity).findOneBy({ workspaceId: ws, projectId, name: m.name.slice(0, 120) });
          if (same) return same.id;
          return (
            await this.deps.milestones.create(ws, this.actor, {
              projectId,
              name: m.name.slice(0, 120),
              description: m.description ?? null,
              targetDate: m.dueOn ?? null,
            })
          ).id;
        },
      );
    }

    Object.assign(plan.labels, await this.resolveLabels(discovery, mapping));
    for (const u of discovery.users) plan.users[u.id] = mapping.users[u.id] ?? null;
    return plan;
  }

  /** Labels live in the workspace settings, so all new ones are written in a single transaction. */
  private async resolveLabels(discovery: Discovery, mapping: ImportMapping): Promise<Record<string, string | null>> {
    const out: Record<string, string | null> = {};
    const wanted = discovery.labels.filter((l) => mapping.labels[l.id]?.action === 'create');
    const links = new Map<string, string>();
    for (const l of wanted) {
      const id = await this.link('label', l.id);
      if (id) links.set(l.id, id);
    }
    await this.ds.transaction(async (m) => {
      const ws = await m.getRepository(WorkspaceEntity).findOneByOrFail({ id: this.workspaceId });
      let catalog = resolveLabelCatalog(ws.settings?.labels);
      let changed = false;
      for (const l of discovery.labels) {
        const target = mapping.labels[l.id];
        if (!target || target.action === 'skip') out[l.id] = null;
        else if (target.action === 'map') {
          if (!catalog.some((c) => c.id === target.id)) throw new ImportFatalError('A label you mapped to no longer exists');
          out[l.id] = target.id;
        } else {
          const linked = links.get(l.id);
          const name = labelName(l.name);
          const existing = (linked ? catalog.find((c) => c.id === linked) : undefined) ?? catalog.find((c) => c.name.toLowerCase() === name.toLowerCase());
          if (existing) out[l.id] = existing.id;
          else if (catalog.filter((c) => !c.template).length >= CUSTOM_LABELS_MAX) out[l.id] = null;
          else {
            const used = new Set(catalog.map((c) => c.color));
            const color = labelColor(l.color) ?? LABEL_SWATCHES.find((c) => !used.has(c)) ?? LABEL_SWATCHES[catalog.length % LABEL_SWATCHES.length];
            const label: WorkspaceLabel = { id: uid('lb'), name, color, template: false };
            catalog = [...catalog, label];
            out[l.id] = label.id;
            changed = true;
          }
          if (out[l.id]) await this.saveLink('label', l.id, out[l.id]!, m);
        }
      }
      if (changed) {
        ws.settings = { ...ws.settings, labels: catalog };
        await m.save(WorkspaceEntity, ws);
      }
    });
    return out;
  }

  // ───────────── issues ─────────────

  async existingIssues(provider: ExternalProvider, ids: string[]): Promise<Map<string, string>> {
    if (!ids.length) return new Map();
    const rows = await this.ds.query<{ id: string; ext: string }[]>(
      `SELECT "id", "externalRef"->>'id' AS "ext" FROM "issues"
       WHERE "workspaceId" = $1 AND "externalRef"->>'provider' = $2 AND "externalRef"->>'id' = ANY($3::text[])`,
      [this.workspaceId, provider, ids],
    );
    return new Map(rows.map((r) => [r.ext, r.id]));
  }

  async createIssue(n: NewIssue): Promise<'created' | 'exists'> {
    try {
      await this.ds.transaction(async (m) => {
        const number = await this.deps.counters.next(m, this.workspaceId, `issue:${n.kind}`);
        await m.save(
          m.create(IssueEntity, {
            id: uid('in'),
            workspaceId: this.workspaceId,
            key: `${ISSUE_KEY_PREFIX[n.kind]}-${number}`,
            number,
            kind: n.kind,
            title: n.title,
            body: n.body,
            source: n.source,
            reporterName: n.reporterName,
            reporterId: null,
            assigneeId: n.assigneeId,
            teamId: n.teamId,
            projectId: n.projectId,
            priority: n.priority,
            status: n.status,
            workstreamIds: [],
            milestoneIds: n.milestoneIds,
            estimate: n.estimate,
            startedAt: n.startedAt,
            completedAt: n.completedAt,
            labels: n.labels,
            aliases: [],
            duplicateOfId: null,
            externalUrl: n.externalRef.url,
            externalRef: n.externalRef,
            createdAt: n.createdAt,
            updatedAt: n.updatedAt,
          }),
        );
      });
      return 'created';
    } catch (e) {
      const constraint = (e as { driverError?: { constraint?: string }; constraint?: string }).driverError?.constraint ?? (e as { constraint?: string }).constraint;
      if (isUniqueViolation(e) && constraint === EXTERNAL_REF_INDEX) return 'exists';
      throw e;
    }
  }

  async refreshRef(provider: ExternalProvider, id: string, ref: ExternalRef): Promise<void> {
    await this.ds.query(
      `UPDATE "issues" SET "externalRef" = "externalRef" || jsonb_build_object('state', $4::text, 'stateType', $5::text, 'syncedAt', $6::text, 'key', $7::text, 'url', $8::text)
       WHERE "workspaceId" = $1 AND "externalRef"->>'provider' = $2 AND "externalRef"->>'id' = $3`,
      [this.workspaceId, provider, id, ref.state ?? null, ref.stateType ?? null, ref.syncedAt ?? null, ref.key ?? null, ref.url],
    );
  }

  // ───────────── comments ─────────────

  async existingComments(provider: ExternalProvider, ids: string[]): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const rows = await this.ds.query<{ externalId: string }[]>(
      `SELECT "externalId" FROM "import_links" WHERE "workspaceId" = $1 AND "provider" = $2 AND "kind" = 'comment' AND "externalId" = ANY($3::text[])`,
      [this.workspaceId, provider, ids],
    );
    return new Set(rows.map((r) => r.externalId));
  }

  async createComment(
    provider: ExternalProvider,
    c: { externalId: string; issueId: string; body: string; createdAt: Date },
  ): Promise<boolean> {
    return this.ds.transaction(async (m) => {
      const id = uid('cm');
      // The link row is the idempotency key: whoever inserts it first writes the comment.
      const claimed = await m.query<{ externalId: string }[]>(
        `INSERT INTO "import_links" ("workspaceId","provider","kind","externalId","tramaId","jobId") VALUES ($1,$2,'comment',$3,$4,$5)
         ON CONFLICT DO NOTHING RETURNING "externalId"`,
        [this.workspaceId, provider, c.externalId, id, this.jobId],
      );
      if (!claimed.length) return false;
      await m.save(
        m.create(CommentEntity, {
          id,
          workspaceId: this.workspaceId,
          subject: { type: 'issue', id: c.issueId },
          author: this.actor,
          body: c.body,
          createdAt: c.createdAt,
          updatedAt: c.createdAt,
        }),
      );
      return true;
    });
  }
}
