import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import type { ActorRef } from '../contracts/domain.js';
import { isUniqueViolation, notFound, uid } from '../common/util.js';
import { HttpClient } from '../integrations/http-client.js';
import { SecretsService } from '../integrations/secrets.service.js';
import { IssueEntity } from '../database/entities/index.js';
import { ProjectsService } from '../projects/projects.service.js';
import {
  LunaGestConnectionEntity,
  LunaGestIssueLinkEntity,
  LunaGestProjectLinkEntity,
  type LunaGestIssueLinkState,
} from './entities.js';
import {
  decideField,
  resolvedValue,
  type FieldAction,
  type SyncField,
  type SyncTake,
} from './lunagest-realign.js';
import {
  LUNAGEST_ANON_KEY,
  LunaGestClient,
  normalizeLunaGestBaseUrl,
  type LunaGestCredentials,
} from './lunagest.client.js';

const ALREADY_BOUND =
  'That LunaGest project is already bound to another project';
const UNKNOWN_PROJECT = 'Unknown LunaGest project';
const NO_CONNECTION = 'Save a LunaGest connection first';
const ALREADY_LINKED_TASK =
  'That LunaGest task is already linked to another issue';
const UNKNOWN_TASK = 'Unknown LunaGest task';

export type LunaGestConnectionView =
  | { configured: false }
  | {
      configured: true;
      id: string;
      baseUrl: string;
      account: string;
      updatedAt: Date;
    };

export type LunaGestLinkView =
  | { state: 'unlinked' }
  | {
      state: 'linked';
      remoteProjectId: string;
      remoteProjectName: string;
      updatedAt: Date;
    };

export type LunaGestIssueLinkView =
  | { applicable: false }
  | {
      applicable: true;
      state: LunaGestIssueLinkState;
      remoteTaskId: string | null;
      lastError: string | null;
      updatedAt: Date | null;
    };

export interface LunaGestIssueSnapshot {
  id: string;
  projectId: string | null;
  title: string;
  body: string | null;
}

export interface RealignChoice {
  issueId: string;
  field: SyncField;
  take: SyncTake;
}

export interface RealignConflict {
  issueId: string;
  issueKey: string;
  field: SyncField;
  local: string;
  remote: string;
}

export interface RealignResult {
  pulled: { issueId: string; field: SyncField }[];
  pushed: { issueId: string; field: SyncField }[];
  conflicts: RealignConflict[];
  /** Linked work was not created or deleted. These rows need a manual link or push. */
  skipped: { issueId?: string; remoteTaskId?: string; reason: string }[];
}

const secretAad = (id: string) => `${id}:lunagest`;

/** Workspace LunaGest connection and the single project binding that uses it. */
@Injectable()
export class LunagestService {
  private readonly client: LunaGestClient;

  constructor(
    http: HttpClient,
    private readonly secrets: SecretsService,
    @InjectRepository(LunaGestConnectionEntity)
    private readonly connections: Repository<LunaGestConnectionEntity>,
    @InjectRepository(LunaGestProjectLinkEntity)
    private readonly links: Repository<LunaGestProjectLinkEntity>,
    @InjectRepository(LunaGestIssueLinkEntity)
    private readonly issueLinks: Repository<LunaGestIssueLinkEntity>,
    @InjectRepository(IssueEntity)
    private readonly issues: Repository<IssueEntity>,
    private readonly projects: ProjectsService,
  ) {
    this.client = new LunaGestClient(http);
  }

  async getConnection(workspaceId: string): Promise<LunaGestConnectionView> {
    const row = await this.connections.findOneBy({ workspaceId });
    return row ? this.present(row) : { configured: false };
  }

  /** Logs in first. A rejected login does not insert or update. */
  async saveConnection(
    workspaceId: string,
    actor: ActorRef,
    input: {
      username: string;
      password: string;
      apiKey?: string;
      baseUrl?: string;
    },
  ): Promise<LunaGestConnectionView> {
    const baseUrl = await normalizeLunaGestBaseUrl(input.baseUrl);
    const username = input.username.trim();
    const password = input.password;
    const apiKey = input.apiKey?.trim() || LUNAGEST_ANON_KEY;
    if (!username || !password) {
      throw new BadRequestException('username and password are required');
    }
    const creds: LunaGestCredentials = { username, password, apiKey };
    await this.client.login(baseUrl, creds);

    const existing = await this.connections.findOneBy({ workspaceId });
    const id = existing?.id ?? uid('lgc');
    const now = new Date();
    const saved = await this.connections.save(
      this.connections.create({
        id,
        workspaceId,
        baseUrl,
        account: username,
        secret: this.secrets.encrypt(JSON.stringify(creds), secretAad(id)),
        createdBy: existing?.createdBy ?? actor,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      }),
    );
    return this.present(saved);
  }

  /** Remote projects the saved login can see. `{ projects }` matches the settings client. */
  async listRemoteProjects(
    workspaceId: string,
  ): Promise<{ projects: { id: string; name: string }[] }> {
    const connection = await this.connections.findOneBy({ workspaceId });
    if (!connection) throw new BadRequestException(NO_CONNECTION);
    const projects = await this.client.listProjects(
      connection.baseUrl,
      this.credentials(connection),
    );
    return {
      projects: projects.map((row) => ({ id: row.id, name: row.name })),
    };
  }

  /** Project links are removed by the connection foreign key's ON DELETE CASCADE. */
  async removeConnection(workspaceId: string): Promise<void> {
    await this.connections.delete({ workspaceId });
  }

  async getLink(
    workspaceId: string,
    projectId: string,
  ): Promise<LunaGestLinkView> {
    await this.projects.get(workspaceId, projectId);
    const link = await this.links.findOneBy({ projectId, workspaceId });
    if (!link) return { state: 'unlinked' };
    return {
      state: 'linked',
      remoteProjectId: link.remoteProjectId,
      remoteProjectName: link.remoteProjectName,
      updatedAt: link.updatedAt,
    };
  }

  /** Binds an existing remote project. Does not create one. */
  async bind(
    workspaceId: string,
    projectId: string,
    remoteProjectId: string,
  ): Promise<LunaGestLinkView> {
    await this.projects.get(workspaceId, projectId);
    const remoteId = remoteProjectId.trim();
    if (!remoteId) throw new BadRequestException(UNKNOWN_PROJECT);
    const connection = await this.connections.findOneBy({ workspaceId });
    if (!connection) throw new BadRequestException(NO_CONNECTION);

    const remote = (
      await this.client.listProjects(
        connection.baseUrl,
        this.credentials(connection),
      )
    ).find((row) => row.id === remoteId);
    if (!remote) throw new BadRequestException(UNKNOWN_PROJECT);

    const taken = await this.links.findOneBy({
      workspaceId,
      remoteProjectId: remote.id,
    });
    if (taken && taken.projectId !== projectId)
      throw new BadRequestException(ALREADY_BOUND);

    const existing = await this.links.findOneBy({ projectId });
    if (existing && existing.workspaceId !== workspaceId)
      throw notFound('Project', projectId);
    const now = new Date();
    try {
      const saved = await this.links.save(
        this.links.create({
          projectId,
          workspaceId,
          connectionId: connection.id,
          remoteProjectId: remote.id,
          remoteProjectName: remote.name,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        }),
      );
      return {
        state: 'linked',
        remoteProjectId: saved.remoteProjectId,
        remoteProjectName: saved.remoteProjectName,
        updatedAt: saved.updatedAt,
      };
    } catch (e) {
      if (isUniqueViolation(e)) throw new BadRequestException(ALREADY_BOUND);
      throw e;
    }
  }

  /** Missing project is 404. A project with no link is still a successful unlink. */
  async unbind(workspaceId: string, projectId: string): Promise<void> {
    await this.projects.get(workspaceId, projectId);
    await this.links.delete({ projectId, workspaceId });
  }

  /**
   * Push title and description after a Trama save. Never throws: a panel failure
   * leaves the issue in place and records `push_failed`.
   */
  async afterIssueSaved(
    workspaceId: string,
    issue: LunaGestIssueSnapshot,
    flags: {
      created: boolean;
      titleChanged: boolean;
      bodyChanged: boolean;
      projectChanged: boolean;
    },
  ): Promise<void> {
    if (!issue.projectId) return;
    const projectLink = await this.links.findOneBy({
      workspaceId,
      projectId: issue.projectId,
    });
    if (!projectLink) return;
    const existing = await this.issueLinks.findOneBy({ issueId: issue.id });
    if (existing && existing.workspaceId !== workspaceId) return;
    const remoteId = existing?.remoteTaskId ?? null;
    const create =
      !remoteId &&
      (flags.created ||
        flags.titleChanged ||
        flags.bodyChanged ||
        flags.projectChanged);
    const update = !!remoteId && (flags.titleChanged || flags.bodyChanged);
    if (!create && !update) return;
    await this.pushSnapshot(workspaceId, issue, projectLink.remoteProjectId, remoteId);
  }

  async getIssueLink(
    workspaceId: string,
    idOrKey: string,
  ): Promise<LunaGestIssueLinkView> {
    const issue = await this.requireIssue(workspaceId, idOrKey);
    if (!issue.projectId) return { applicable: false };
    const projectLink = await this.links.findOneBy({
      workspaceId,
      projectId: issue.projectId,
    });
    if (!projectLink) return { applicable: false };
    const link = await this.issueLinks.findOneBy({ issueId: issue.id });
    if (!link || link.workspaceId !== workspaceId) {
      return {
        applicable: true,
        state: 'local_only',
        remoteTaskId: null,
        lastError: null,
        updatedAt: null,
      };
    }
    return this.presentIssue(link);
  }

  /** Retry the create, or PUT the stored remote id. The Trama issue is not rolled back. */
  async pushIssue(
    workspaceId: string,
    idOrKey: string,
  ): Promise<LunaGestIssueLinkView> {
    const issue = await this.requireIssue(workspaceId, idOrKey);
    if (!issue.projectId) return { applicable: false };
    const projectLink = await this.links.findOneBy({
      workspaceId,
      projectId: issue.projectId,
    });
    if (!projectLink) return { applicable: false };
    const existing = await this.issueLinks.findOneBy({ issueId: issue.id });
    await this.pushSnapshot(
      workspaceId,
      issue,
      projectLink.remoteProjectId,
      existing?.workspaceId === workspaceId ? existing.remoteTaskId : null,
    );
    return this.getIssueLink(workspaceId, issue.id);
  }

  async listRemoteTasks(
    workspaceId: string,
    idOrKey: string,
  ): Promise<{ tasks: { id: string; title: string }[] }> {
    const issue = await this.requireIssue(workspaceId, idOrKey);
    const projectLink = await this.projectLinkFor(workspaceId, issue.projectId);
    const connection = await this.requireConnection(workspaceId);
    const tasks = await this.client.listTasks(
      connection.baseUrl,
      this.credentials(connection),
      projectLink.remoteProjectId,
    );
    return { tasks: tasks.map((row) => ({ id: row.id, title: row.title })) };
  }

  /** Attach an existing remote task. A task already linked to another issue is rejected. */
  async linkIssueTask(
    workspaceId: string,
    idOrKey: string,
    remoteTaskId: string,
  ): Promise<LunaGestIssueLinkView> {
    const issue = await this.requireIssue(workspaceId, idOrKey);
    const remoteId = remoteTaskId.trim();
    if (!remoteId) throw new BadRequestException(UNKNOWN_TASK);
    const projectLink = await this.projectLinkFor(workspaceId, issue.projectId);
    const connection = await this.requireConnection(workspaceId);
    const remote = (
      await this.client.listTasks(
        connection.baseUrl,
        this.credentials(connection),
        projectLink.remoteProjectId,
      )
    ).find((row) => row.id === remoteId);
    if (!remote) throw new BadRequestException(UNKNOWN_TASK);
    const taken = await this.issueLinks.findOneBy({
      workspaceId,
      remoteTaskId: remote.id,
    });
    if (taken && taken.issueId !== issue.id)
      throw new BadRequestException(ALREADY_LINKED_TASK);
    const now = new Date();
    const existing = await this.issueLinks.findOneBy({ issueId: issue.id });
    try {
      const saved = await this.issueLinks.save(
        this.issueLinks.create({
          issueId: issue.id,
          workspaceId,
          remoteTaskId: remote.id,
          state: 'linked',
          lastError: null,
          lastSyncedAt: now,
          syncedTitle: existing?.syncedTitle ?? null,
          syncedBody: existing?.syncedBody ?? null,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        }),
      );
      return this.presentIssue(saved);
    } catch (e) {
      if (isUniqueViolation(e)) throw new BadRequestException(ALREADY_LINKED_TASK);
      throw e;
    }
  }

  /**
   * One project, one pass. A field both sides changed is left alone unless `choices`
   * names it. Unlinked issues are not created on LunaGest, and unknown remote tasks
   * are not turned into issues. Project name is pulled only; there is no project-update call.
   */
  async realign(
    workspaceId: string,
    actor: ActorRef,
    projectId: string,
    choices: RealignChoice[] = [],
  ): Promise<RealignResult> {
    const projectLink = await this.projectLinkFor(workspaceId, projectId);
    const connection = await this.requireConnection(workspaceId);
    const creds = this.credentials(connection);
    const [remoteProjects, remoteTasks] = await Promise.all([
      this.client.listProjects(connection.baseUrl, creds),
      this.client.listTasks(connection.baseUrl, creds, projectLink.remoteProjectId),
    ]);
    const remoteProject = remoteProjects.find((row) => row.id === projectLink.remoteProjectId);
    if (!remoteProject) throw new BadRequestException(UNKNOWN_PROJECT);

    const result: RealignResult = { pulled: [], pushed: [], conflicts: [], skipped: [] };
    await this.realignProject(workspaceId, actor, projectLink, remoteProject);

    const issues = await this.issues.find({ where: { workspaceId, projectId } });
    const links = await this.issueLinks.find({ where: { workspaceId } });
    const linkByIssue = new Map(links.map((row) => [row.issueId, row]));
    const linkedRemote = new Set(
      links.map((row) => row.remoteTaskId).filter((id): id is string => !!id),
    );

    for (const issue of issues) {
      const link = linkByIssue.get(issue.id);
      if (!link?.remoteTaskId || link.workspaceId !== workspaceId) {
        result.skipped.push({ issueId: issue.id, reason: 'not linked' });
        continue;
      }
      const remote = remoteTasks.find((row) => row.id === link.remoteTaskId);
      if (!remote) {
        result.skipped.push({
          issueId: issue.id,
          remoteTaskId: link.remoteTaskId,
          reason: 'missing on LunaGest',
        });
        continue;
      }
      await this.realignIssue(workspaceId, connection, issue, link, remote, choices, result);
    }

    for (const task of remoteTasks) {
      if (!linkedRemote.has(task.id))
        result.skipped.push({ remoteTaskId: task.id, reason: 'not linked' });
    }
    return result;
  }

  private async realignProject(
    workspaceId: string,
    actor: ActorRef,
    link: LunaGestProjectLinkEntity,
    remote: { name: string; description: string | null },
  ): Promise<void> {
    const project = await this.projects.get(workspaceId, link.projectId);
    if (typeof project.name !== 'string') return;
    const nameAction = decideField(project.name, remote.name, link.syncedName ?? null);
    let changed = false;
    if (nameAction === 'pull') {
      await this.projects.update(workspaceId, actor, link.projectId, { name: remote.name });
      link.syncedName = remote.name;
      changed = true;
    } else if (nameAction === 'adopt' || nameAction === 'same') {
      link.syncedName = project.name;
      changed = true;
    }
    if (remote.description !== null && nameAction !== 'conflict' && nameAction !== 'push') {
      const localDescription = project.description ?? '';
      const descriptionAction = decideField(
        localDescription,
        remote.description,
        link.syncedDescription ?? null,
      );
      if (descriptionAction === 'pull') {
        await this.projects.update(workspaceId, actor, link.projectId, {
          description: remote.description,
        });
        link.syncedDescription = remote.description;
        changed = true;
      } else if (descriptionAction === 'adopt' || descriptionAction === 'same') {
        link.syncedDescription = localDescription;
        changed = true;
      }
    }
    if (changed) {
      link.updatedAt = new Date();
      await this.links.save(link);
    }
  }

  private async realignIssue(
    workspaceId: string,
    connection: LunaGestConnectionEntity,
    issue: IssueEntity,
    link: LunaGestIssueLinkEntity,
    remote: { id: string; title: string; description: string },
    choices: RealignChoice[],
    result: RealignResult,
  ): Promise<void> {
    const take = (field: SyncField) =>
      choices.find((choice) => choice.issueId === issue.id && choice.field === field)?.take;
    const localBody = issue.body ?? '';
    const titleAction = decideField(issue.title, remote.title, link.syncedTitle, take('title'));
    const bodyAction = decideField(localBody, remote.description, link.syncedBody, take('description'));
    const blocked = titleAction === 'conflict' || bodyAction === 'conflict';
    if (titleAction === 'conflict') {
      result.conflicts.push({
        issueId: issue.id,
        issueKey: issue.key,
        field: 'title',
        local: issue.title,
        remote: remote.title,
      });
    }
    if (bodyAction === 'conflict') {
      result.conflicts.push({
        issueId: issue.id,
        issueKey: issue.key,
        field: 'description',
        local: localBody,
        remote: remote.description,
      });
    }

    let title = issue.title;
    let body = localBody;
    let syncedTitle = link.syncedTitle;
    let syncedBody = link.syncedBody;
    let writeLocal = false;
    let writeRemote = false;
    const note = (field: SyncField, action: FieldAction, local: string, remoteValue: string) => {
      if (action === 'conflict') return;
      const value = resolvedValue(local, remoteValue, action);
      if (field === 'title') {
        title = value;
        syncedTitle = value;
      } else {
        body = value;
        syncedBody = value;
      }
      if (action === 'pull') {
        writeLocal = true;
        result.pulled.push({ issueId: issue.id, field });
      } else if (action === 'push' && !blocked) {
        writeRemote = true;
        result.pushed.push({ issueId: issue.id, field });
      } else if (action === 'push' && field === 'title') {
        syncedTitle = link.syncedTitle;
      } else if (action === 'push') {
        syncedBody = link.syncedBody;
      }
    };
    note('title', titleAction, issue.title, remote.title);
    note('description', bodyAction, localBody, remote.description);

    if (writeRemote) {
      const written = await this.client.updateTask(
        connection.baseUrl,
        this.credentials(connection),
        { id: remote.id, title, description: body },
      );
      if (!written.ok) {
        result.pulled = result.pulled.filter((row) => row.issueId !== issue.id);
        result.pushed = result.pushed.filter((row) => row.issueId !== issue.id);
        await this.writeIssueLink(workspaceId, issue.id, {
          remoteTaskId: link.remoteTaskId,
          state: 'push_failed',
          lastError: written.error,
          synced: false,
        });
        return;
      }
    }
    if (writeLocal && (issue.title !== title || (issue.body ?? '') !== body)) {
      issue.title = title;
      issue.body = body.length > 0 ? body : null;
      issue.updatedAt = new Date();
      await this.issues.save(issue);
    }
    const baselineChanged = syncedTitle !== link.syncedTitle || syncedBody !== link.syncedBody;
    if (!writeLocal && !writeRemote && !baselineChanged) return;
    await this.writeIssueLink(workspaceId, issue.id, {
      remoteTaskId: link.remoteTaskId,
      state: 'linked',
      lastError: null,
      synced: true,
      syncedTitle,
      syncedBody,
    });
  }

  private async pushSnapshot(
    workspaceId: string,
    issue: LunaGestIssueSnapshot,
    remoteProjectId: string,
    remoteTaskId: string | null,
  ): Promise<void> {
    const connection = await this.connections.findOneBy({ workspaceId });
    if (!connection) {
      await this.writeIssueLink(workspaceId, issue.id, {
        remoteTaskId,
        state: 'push_failed',
        lastError: NO_CONNECTION,
        synced: false,
      });
      return;
    }
    const description = issue.body ?? '';
    const result = remoteTaskId
      ? await this.client.updateTask(connection.baseUrl, this.credentials(connection), {
          id: remoteTaskId,
          title: issue.title,
          description,
        })
      : await this.client.createTask(connection.baseUrl, this.credentials(connection), {
          title: issue.title,
          description,
          projectId: remoteProjectId,
        });
    if (result.ok) {
      await this.writeIssueLink(workspaceId, issue.id, {
        remoteTaskId: result.id,
        state: 'linked',
        lastError: null,
        synced: true,
        syncedTitle: issue.title,
        syncedBody: description,
      });
      return;
    }
    await this.writeIssueLink(workspaceId, issue.id, {
      remoteTaskId,
      state: 'push_failed',
      lastError: result.error,
      synced: false,
    });
  }

  private async writeIssueLink(
    workspaceId: string,
    issueId: string,
    next: {
      remoteTaskId: string | null;
      state: LunaGestIssueLinkState;
      lastError: string | null;
      synced: boolean;
      syncedTitle?: string | null;
      syncedBody?: string | null;
    },
  ): Promise<void> {
    const now = new Date();
    const existing = await this.issueLinks.findOneBy({ issueId });
    await this.issueLinks.save(
      this.issueLinks.create({
        issueId,
        workspaceId,
        remoteTaskId: next.remoteTaskId,
        state: next.state,
        lastError: next.lastError,
        lastSyncedAt: next.synced ? now : (existing?.lastSyncedAt ?? null),
        syncedTitle: next.synced ? (next.syncedTitle ?? null) : (existing?.syncedTitle ?? null),
        syncedBody: next.synced ? (next.syncedBody ?? null) : (existing?.syncedBody ?? null),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      }),
    );
  }

  private async projectLinkFor(workspaceId: string, projectId: string | null) {
    if (!projectId) throw new BadRequestException('This issue is not on a linked project');
    const link = await this.links.findOneBy({ workspaceId, projectId });
    if (!link) throw new BadRequestException('This issue is not on a linked project');
    return link;
  }

  private async requireConnection(workspaceId: string) {
    const connection = await this.connections.findOneBy({ workspaceId });
    if (!connection) throw new BadRequestException(NO_CONNECTION);
    return connection;
  }

  private async requireIssue(workspaceId: string, idOrKey: string) {
    const issue =
      (await this.issues.findOneBy({ workspaceId, id: idOrKey })) ??
      (await this.issues.findOneBy({ workspaceId, key: idOrKey }));
    if (!issue) throw notFound('Issue', idOrKey);
    return issue;
  }

  private presentIssue(row: LunaGestIssueLinkEntity): LunaGestIssueLinkView {
    return {
      applicable: true,
      state: row.state,
      remoteTaskId: row.remoteTaskId,
      lastError: row.lastError,
      updatedAt: row.updatedAt,
    };
  }

  private present(row: LunaGestConnectionEntity): LunaGestConnectionView {
    return {
      configured: true,
      id: row.id,
      baseUrl: row.baseUrl,
      account: row.account,
      updatedAt: row.updatedAt,
    };
  }

  private credentials(row: LunaGestConnectionEntity): LunaGestCredentials {
    let parsed: unknown;
    try {
      parsed = JSON.parse(this.secrets.decrypt(row.secret, secretAad(row.id)));
    } catch {
      throw new BadRequestException('LunaGest rejected the login');
    }
    if (!parsed || typeof parsed !== 'object')
      throw new BadRequestException('LunaGest rejected the login');
    const creds = parsed as Partial<LunaGestCredentials>;
    if (
      typeof creds.username !== 'string' ||
      typeof creds.password !== 'string' ||
      typeof creds.apiKey !== 'string'
    ) {
      throw new BadRequestException('LunaGest rejected the login');
    }
    return {
      username: creds.username,
      password: creds.password,
      apiKey: creds.apiKey,
    };
  }
}
