import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, type Repository } from 'typeorm';
import type { PublicView, PublicViewGroup, PublicViewItem, ViewEntity } from '../contracts/domain.js';
import {
  DecisionEntity,
  IssueEntity,
  MembershipEntity,
  ProjectEntity,
  SavedViewEntity,
  TeamEntity,
  UserEntity,
  WorkspaceEntity,
  WorkstreamEntity,
} from '../database/entities/index.js';
import { applyFilters, groupItems, sortItems, VIEW_FIELDS, type QueryContext, type RefKind } from './view-query.js';
import { hashPublicToken, isPublicToken } from './view-token.js';

/** Rows returned for one public view; the rest is cut (and flagged as `truncated`). */
export const PUBLIC_VIEW_LIMIT = 500;

type Row = Record<string, unknown>;
type Names = Record<RefKind, Map<string, string>>;

const iso = (v: unknown): string | undefined => (v instanceof Date ? v.toISOString() : typeof v === 'string' ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const strs = (v: unknown): string[] | undefined => (Array.isArray(v) && v.length ? v.map(String) : undefined);

/**
 * The public, unauthenticated side of "anyone with the link". It resolves a secret token to ONE
 * view and runs that view's saved query; nothing about the request (query string, headers, session)
 * can change the filters, sort, grouping, entity or workspace. The result is a fixed projection of
 * a few display fields per row, never the full entities.
 */
@Injectable()
export class PublicViewsService {
  constructor(
    private readonly ds: DataSource,
    @InjectRepository(SavedViewEntity) private readonly repo: Repository<SavedViewEntity>,
  ) {}

  async get(token: string): Promise<PublicView> {
    // One generic error for malformed, unknown, revoked and no-longer-link-shared tokens.
    const missing = () => new NotFoundException('This shared view does not exist or is no longer shared');
    if (!isPublicToken(token)) throw missing();
    const view = await this.repo.findOneBy({ publicTokenHash: hashPublicToken(token) });
    if (!view || view.sharing.visibility !== 'link') throw missing();

    const { workspaceId, entity } = view;
    const rows = await this.rowsOf(entity, workspaceId);
    const ctx: QueryContext = {};
    if (entity === 'issue') {
      const ws = await this.ds.getRepository(WorkstreamEntity).find({ where: { workspaceId }, select: { id: true, projectId: true } });
      ctx.workstreamProjects = new Map(ws.map((w) => [w.id, w.projectId]));
    }

    const sort = view.sort ?? (view.layout === 'timeline' ? { field: 'startDate', direction: 'asc' as const } : null);
    const matched = sortItems(entity, applyFilters(entity, rows, view.filters, ctx), sort, ctx);
    const kept = matched.slice(0, PUBLIC_VIEW_LIMIT);
    // A board always has columns: by status unless the view says otherwise.
    const groupBy = view.groupBy ?? (view.layout === 'board' ? 'status' : null);
    const groups = groupItems(entity, kept, groupBy, ctx);

    const names = await this.namesFor(workspaceId, entity, groupBy);
    const workspace = await this.ds.getRepository(WorkspaceEntity).findOneBy({ id: workspaceId });

    const out: PublicViewGroup[] = groups.map((g) => ({
      key: g.key,
      label: this.groupLabel(entity, groupBy, g.key, names),
      items: g.items.map((r) => this.project(entity, r, names)),
    }));
    return {
      name: view.name,
      entity,
      layout: view.layout,
      ...(groupBy ? { groupBy } : {}),
      workspaceName: workspace?.name ?? '',
      groups: out,
      total: matched.length,
      truncated: matched.length > kept.length,
      generatedAt: new Date().toISOString(),
    };
  }

  private async rowsOf(entity: ViewEntity, workspaceId: string): Promise<Row[]> {
    const where = { workspaceId } as never;
    switch (entity) {
      case 'workstream':
        return (await this.ds.getRepository(WorkstreamEntity).find({ where })) as unknown as Row[];
      case 'issue':
        return (await this.ds.getRepository(IssueEntity).find({ where })) as unknown as Row[];
      case 'decision':
        return (await this.ds.getRepository(DecisionEntity).find({ where })) as unknown as Row[];
      case 'project':
        return (await this.ds.getRepository(ProjectEntity).find({ where })) as unknown as Row[];
    }
  }

  /** Display names for the teams, people, projects and workstreams the returned rows point at. */
  private async namesFor(workspaceId: string, entity: ViewEntity, groupBy: string | null): Promise<Names> {
    const names: Names = { team: new Map(), user: new Map(), project: new Map(), workstream: new Map() };
    const need = new Set<RefKind>();
    for (const field of ['teamId', 'ownerTeamId', 'assigneeId', 'accountableUserId', 'leadId', 'projectId', 'originWorkstreamId', groupBy]) {
      const spec = field ? VIEW_FIELDS[entity][field] : undefined;
      if (spec?.refersTo) need.add(spec.refersTo);
    }
    if (need.has('team')) for (const t of await this.ds.getRepository(TeamEntity).find({ where: { workspaceId } })) names.team.set(t.id, t.name);
    if (need.has('project')) for (const p of await this.ds.getRepository(ProjectEntity).find({ where: { workspaceId } })) names.project.set(p.id, p.name);
    if (need.has('workstream')) for (const w of await this.ds.getRepository(WorkstreamEntity).find({ where: { workspaceId } })) names.workstream.set(w.id, w.title);
    if (need.has('user')) {
      const members = await this.ds.getRepository(MembershipEntity).findBy({ workspaceId });
      const users = members.length ? await this.ds.getRepository(UserEntity).findBy({ id: In(members.map((m) => m.userId)) }) : [];
      for (const u of users) names.user.set(u.id, u.name);
    }
    return names;
  }

  private groupLabel(entity: ViewEntity, groupBy: string | null, key: string, names: Names): string {
    if (!key) return '';
    const refersTo = groupBy ? VIEW_FIELDS[entity][groupBy]?.refersTo : undefined;
    return (refersTo && names[refersTo].get(key)) || key;
  }

  /** The only place that decides which fields leave the server for an anonymous reader. */
  private project(entity: ViewEntity, r: Row, names: Names): PublicViewItem {
    const name = (kind: RefKind, id: unknown): string | undefined => (typeof id === 'string' ? names[kind].get(id) : undefined);
    const base = { id: String(r['id']), updatedAt: iso(r['updatedAt']) ?? '' };
    const compact = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
    switch (entity) {
      case 'workstream':
        return compact({
          ...base,
          key: str(r['key']),
          title: str(r['title']) ?? '',
          status: str(r['status']),
          priority: str(r['priority']) as PublicViewItem['priority'],
          team: name('team', r['ownerTeamId']),
          assignee: name('user', r['accountableUserId']),
          project: name('project', r['projectId']),
          labels: strs(r['labels']),
          startDate: iso(r['startDate']),
          targetDate: iso(r['targetDate']),
        });
      case 'issue':
        return compact({
          ...base,
          key: str(r['key']),
          title: str(r['title']) ?? '',
          kind: str(r['kind']),
          status: str(r['status']),
          priority: str(r['priority']) as PublicViewItem['priority'],
          team: name('team', r['teamId']),
          assignee: name('user', r['assigneeId']),
          project: name('project', r['projectId']),
          labels: strs(r['labels']),
        });
      case 'decision':
        return compact({
          ...base,
          key: str(r['key']),
          title: str(r['title']) ?? '',
          status: str(r['status']),
          labels: strs(r['tags']),
        });
      case 'project':
        return compact({
          ...base,
          title: str(r['name']) ?? '',
          status: str(r['status']),
          priority: str(r['priority']) as PublicViewItem['priority'],
          health: str(r['health']),
          assignee: name('user', r['leadId']),
          labels: strs(r['labels']),
          startDate: iso(r['startDate']),
          targetDate: iso(r['targetDate']),
        });
    }
  }
}
