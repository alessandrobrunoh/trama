import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, type Repository } from 'typeorm';
import type { ActorRef } from '../contracts/domain.js';
import { CountersService } from '../common/counters.service.js';
import { isUniqueViolation, uid } from '../common/util.js';
import { IssueEntity } from '../database/entities/index.js';
import { EventsService } from '../events/events.service.js';
import { allocateIssueNumbers, issueKeyPrefix } from '../issues/issue-keys.js';
import { ProjectsService } from '../projects/projects.service.js';
import {
  LunaGestIssueLinkEntity,
  LunaGestProjectLinkEntity,
} from './entities.js';
import type {
  LunaGestCredentials,
  LunaGestRemoteProject,
  LunaGestRemoteTask,
} from './lunagest.client.js';
import { LunagestService } from './lunagest.service.js';

const TITLE_MAX = 300;
const BODY_MAX = 20000;
/** Most remote projects one request may import. */
export const LUNAGEST_IMPORT_MAX_PROJECTS = 25;
const COUNT_CONCURRENCY = 3;

export interface LunaGestImportableProject {
  id: string;
  name: string;
  description: string | null;
  /** Tasks LunaGest returned for the project. `null` when that call failed. */
  taskCount: number | null;
  /** The Trama project this one is already bound to, when the caller may see it. */
  projectId: string | null;
  projectName: string | null;
  /** Bound to a Trama project (visible to the caller or not). */
  imported: boolean;
  /** Tasks of that Trama project already tied to a LunaGest task. */
  linkedTaskCount: number;
}

export interface LunaGestProjectImportResult {
  remoteProjectId: string;
  remoteProjectName: string;
  /** `created`: a new Trama project. `linked`: an existing unbound project with the same name was bound. `existing`: already bound. */
  project: 'created' | 'linked' | 'existing' | 'failed';
  projectId: string | null;
  projectKey: string | null;
  tasks: {
    /** New Trama tasks. */
    created: number;
    /** Existing unlinked Trama tasks (same title) now tied to a remote task. */
    linked: number;
    /** Remote tasks that were already tied to a Trama task. Left untouched: use realign for differences. */
    existing: number;
  };
  /** Set when this project could not be imported; others still ran. */
  error?: string;
}

export interface LunaGestImportResult {
  projects: LunaGestProjectImportResult[];
}

const norm = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase();
const clip = (value: string, max: number) =>
  value.length > max ? value.slice(0, max) : value;

/**
 * Imports LunaGest projects and their tasks into Trama. Idempotent: a remote project or task that is already
 * bound (through the project and task link rows) is reused, never duplicated. It only reads from LunaGest.
 */
@Injectable()
export class LunaGestImportService {
  constructor(
    private readonly lunagest: LunagestService,
    private readonly projects: ProjectsService,
    private readonly ds: DataSource,
    private readonly counters: CountersService,
    private readonly events: EventsService,
    @InjectRepository(LunaGestProjectLinkEntity)
    private readonly projectLinks: Repository<LunaGestProjectLinkEntity>,
    @InjectRepository(LunaGestIssueLinkEntity)
    private readonly issueLinks: Repository<LunaGestIssueLinkEntity>,
    @InjectRepository(IssueEntity)
    private readonly issues: Repository<IssueEntity>,
  ) {}

  /** Remote projects with their task count and whether they are already bound. */
  async listImportable(
    workspaceId: string,
  ): Promise<{ projects: LunaGestImportableProject[] }> {
    const { baseUrl, creds } = await this.lunagest.session(workspaceId);
    const remote = await this.lunagest.client.listProjects(baseUrl, creds);
    const links = await this.projectLinks.find({ where: { workspaceId } });
    const linkByRemote = new Map(links.map((row) => [row.remoteProjectId, row]));
    const visible = new Map(
      (await this.projects.list(workspaceId)).map((p) => [p.id, p.name]),
    );
    const issueLinks = await this.issueLinks.find({ where: { workspaceId } });
    const linkedIssues = new Set(issueLinks.filter((l) => l.remoteTaskId).map((l) => l.issueId));
    const counts = await this.mapLimited(remote, async (project) => {
      try {
        return (await this.lunagest.client.listTasks(baseUrl, creds, project.id)).length;
      } catch {
        return null;
      }
    });

    const out: LunaGestImportableProject[] = [];
    for (const [i, project] of remote.entries()) {
      const link = linkByRemote.get(project.id);
      const projectName = link ? (visible.get(link.projectId) ?? null) : null;
      let linkedTaskCount = 0;
      if (link && projectName !== null) {
        const rows = await this.issues.find({
          where: { workspaceId, projectId: link.projectId },
          select: { id: true },
        });
        linkedTaskCount = rows.filter((r) => linkedIssues.has(r.id)).length;
      }
      out.push({
        id: project.id,
        name: project.name,
        description: project.description,
        taskCount: counts[i] ?? null,
        projectId: projectName !== null ? (link?.projectId ?? null) : null,
        projectName,
        imported: !!link,
        linkedTaskCount,
      });
    }
    return { projects: out };
  }

  /**
   * Imports the chosen remote projects. One project failing (for example a permission or a panel error) does
   * not stop the others; its result carries `error`.
   */
  async importProjects(
    workspaceId: string,
    actor: ActorRef,
    remoteProjectIds: string[],
  ): Promise<LunaGestImportResult> {
    const wanted = [...new Set(remoteProjectIds.map((id) => id.trim()).filter(Boolean))];
    if (!wanted.length) throw new BadRequestException('Pick at least one LunaGest project');
    if (wanted.length > LUNAGEST_IMPORT_MAX_PROJECTS)
      throw new BadRequestException(
        `Import at most ${LUNAGEST_IMPORT_MAX_PROJECTS} projects at a time`,
      );
    const { connectionId, baseUrl, creds } = await this.lunagest.session(workspaceId);
    const remote = await this.lunagest.client.listProjects(baseUrl, creds);
    const byId = new Map(remote.map((row) => [row.id, row]));
    const unknown = wanted.filter((id) => !byId.has(id));
    if (unknown.length)
      throw new BadRequestException(`Unknown LunaGest project: ${unknown.join(', ')}`);

    const results: LunaGestProjectImportResult[] = [];
    for (const id of wanted) {
      const project = byId.get(id)!;
      results.push(
        await this.importOne(workspaceId, actor, connectionId, baseUrl, creds, project),
      );
    }
    return { projects: results };
  }

  private async importOne(
    workspaceId: string,
    actor: ActorRef,
    connectionId: string,
    baseUrl: string,
    creds: LunaGestCredentials,
    remote: LunaGestRemoteProject,
  ): Promise<LunaGestProjectImportResult> {
    const result: LunaGestProjectImportResult = {
      remoteProjectId: remote.id,
      remoteProjectName: remote.name,
      project: 'failed',
      projectId: null,
      projectKey: null,
      tasks: { created: 0, linked: 0, existing: 0 },
    };
    try {
      const tasks = await this.lunagest.client.listTasks(baseUrl, creds, remote.id);
      const bound = await this.bindProject(workspaceId, actor, connectionId, remote);
      result.project = bound.action;
      result.projectId = bound.projectId;
      result.projectKey = bound.projectKey;
      await this.importTasks(workspaceId, actor, bound.projectId, tasks, result);
    } catch (e) {
      result.error =
        e instanceof Error && e.message ? e.message : 'The import of this project failed';
    }
    return result;
  }

  /** Reuses the bound project, else binds the one unbound project with the same name, else creates one. */
  private async bindProject(
    workspaceId: string,
    actor: ActorRef,
    connectionId: string,
    remote: LunaGestRemoteProject,
  ): Promise<{
    action: 'created' | 'linked' | 'existing';
    projectId: string;
    projectKey: string;
  }> {
    const existing = await this.projectLinks.findOneBy({
      workspaceId,
      remoteProjectId: remote.id,
    });
    if (existing) {
      const project = await this.projects.get(workspaceId, existing.projectId);
      return { action: 'existing', projectId: project.id, projectKey: project.key };
    }

    const bound = new Set(
      (await this.projectLinks.find({ where: { workspaceId } })).map((l) => l.projectId),
    );
    const sameName = (await this.projects.list(workspaceId)).filter(
      (p) => !bound.has(p.id) && norm(p.name) === norm(remote.name),
    );
    let action: 'created' | 'linked' = 'linked';
    let project = sameName.length === 1 ? sameName[0] : null;
    if (!project) {
      action = 'created';
      project = await this.projects.create(workspaceId, actor, {
        name: clip(remote.name.trim(), 200) || 'LunaGest project',
        description: remote.description ? clip(remote.description, BODY_MAX) : undefined,
      });
    }
    const now = new Date();
    try {
      await this.projectLinks.save(
        this.projectLinks.create({
          projectId: project.id,
          workspaceId,
          connectionId,
          remoteProjectId: remote.id,
          remoteProjectName: remote.name,
          // A created project starts equal to the remote: realign sees no change. A linked one has no baseline yet.
          syncedName: action === 'created' ? project.name : null,
          syncedDescription: action === 'created' ? (project.description ?? '') : null,
          createdAt: now,
          updatedAt: now,
        }),
      );
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      // Another import bound it first: use that binding.
      const raced = await this.projectLinks.findOneBy({
        workspaceId,
        remoteProjectId: remote.id,
      });
      if (!raced) throw e;
      const winner = await this.projects.get(workspaceId, raced.projectId);
      return { action: 'existing', projectId: winner.id, projectKey: winner.key };
    }
    return { action, projectId: project.id, projectKey: project.key };
  }

  private async importTasks(
    workspaceId: string,
    actor: ActorRef,
    projectId: string,
    tasks: LunaGestRemoteTask[],
    result: LunaGestProjectImportResult,
  ): Promise<void> {
    const links = await this.issueLinks.find({ where: { workspaceId } });
    const taken = new Map<string, string>();
    for (const link of links) if (link.remoteTaskId) taken.set(link.remoteTaskId, link.issueId);
    const linkedIssueIds = new Set(links.map((l) => l.issueId));
    const local = await this.issues.find({ where: { workspaceId, projectId } });
    // Unlinked local tasks by title, so a same-titled one is tied instead of duplicated (only when unambiguous).
    const free = new Map<string, IssueEntity[]>();
    for (const issue of local) {
      if (linkedIssueIds.has(issue.id)) continue;
      const key = norm(issue.title);
      free.set(key, [...(free.get(key) ?? []), issue]);
    }

    const seen = new Set<string>();
    for (const task of tasks) {
      if (seen.has(task.id)) continue;
      seen.add(task.id);
      if (taken.has(task.id)) {
        result.tasks.existing += 1;
        continue;
      }
      const title = clip(task.title.trim(), TITLE_MAX) || 'Untitled task';
      const body = clip(task.description, BODY_MAX);
      const matches = free.get(norm(title)) ?? [];
      if (matches.length === 1) {
        const [issue] = matches;
        free.delete(norm(title));
        await this.saveIssueLink(workspaceId, issue.id, task.id, null, null);
        taken.set(task.id, issue.id);
        result.tasks.linked += 1;
        continue;
      }
      try {
        const issue = await this.createIssue(workspaceId, actor, projectId, title, body);
        await this.saveIssueLink(workspaceId, issue.id, task.id, title, body);
        taken.set(task.id, issue.id);
        result.tasks.created += 1;
      } catch (e) {
        if (isUniqueViolation(e)) {
          result.tasks.existing += 1;
          continue;
        }
        throw e;
      }
    }
  }

  /**
   * Creates the task without going through IssuesService: that would push it straight back to LunaGest and
   * create a second remote task. Status and priority are not mapped (their enums are not recorded).
   */
  private async createIssue(
    workspaceId: string,
    actor: ActorRef,
    projectId: string,
    title: string,
    body: string,
  ): Promise<IssueEntity> {
    const row = await this.ds.transaction(async (m) => {
      const prefix = await issueKeyPrefix(m, workspaceId, projectId);
      const [number] = await allocateIssueNumbers(m, this.counters, workspaceId, prefix, 1);
      return m.save(
        m.create(IssueEntity, {
          id: uid('in'),
          workspaceId,
          key: `${prefix}-${number}`,
          number,
          kind: 'feature',
          title,
          body: body.length > 0 ? body : null,
          source: 'api',
          reporterName: null,
          reporterId: null,
          assigneeId: null,
          projectId,
          parentId: null,
          priority: 'none',
          status: 'backlog',
          estimate: null,
          startedAt: null,
          completedAt: null,
          externalUrl: null,
          threadUrl: null,
          labels: [],
        }),
      );
    });
    await this.events.record({
      workspaceId,
      actor,
      type: 'issue.created',
      subject: { type: 'issue', id: row.id },
      data: {
        key: row.key,
        kind: row.kind,
        title: row.title,
        status: row.status,
        assigneeId: row.assigneeId,
        source: 'lunagest_import',
      },
    });
    return row;
  }

  /** Baseline null means "never agreed": realign then adopts equal fields and reports differing ones as conflicts. */
  private async saveIssueLink(
    workspaceId: string,
    issueId: string,
    remoteTaskId: string,
    syncedTitle: string | null,
    syncedBody: string | null,
  ): Promise<void> {
    const now = new Date();
    await this.issueLinks.save(
      this.issueLinks.create({
        issueId,
        workspaceId,
        remoteTaskId,
        state: 'linked',
        lastError: null,
        lastSyncedAt: now,
        syncedTitle,
        syncedBody,
        createdAt: now,
        updatedAt: now,
      }),
    );
  }

  private async mapLimited<T, R>(
    items: readonly T[],
    run: (item: T) => Promise<R>,
  ): Promise<R[]> {
    const out: R[] = Array.from({ length: items.length });
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await run(items[i]);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(COUNT_CONCURRENCY, items.length) }, worker),
    );
    return out;
  }
}
