import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, type Repository } from 'typeorm';
import { resolveLabelCatalog } from '../contracts/domain.js';
import type {
  PublicView,
  PublicViewGroup,
  PublicViewItem,
  ViewEntity,
} from '../contracts/domain.js';
import {
  IssueEntity,
  MembershipEntity,
  ProjectEntity,
  SavedViewEntity,
  UserEntity,
  WorkspaceEntity,
} from '../database/entities/index.js';
import {
  applyFilters,
  fieldValues,
  groupItems,
  sortItems,
  VIEW_FIELDS,
  type QueryContext,
  type RefKind,
} from './view-query.js';
import { VIEW_ENTITIES } from './view-rules.js';
import { hashPublicToken, isPublicToken } from './view-token.js';

/** Rows returned for one public view; the rest is cut (and flagged as `truncated`). */
export const PUBLIC_VIEW_LIMIT = 500;
/** Maximum workspace rows evaluated for one unauthenticated public-view request. */
export const PUBLIC_VIEW_SCAN_LIMIT = 20_000;

type Row = Record<string, unknown>;
type Names = Record<RefKind, Map<string, string>>;

const iso = (v: unknown): string | undefined =>
  v instanceof Date ? v.toISOString() : typeof v === 'string' ? v : undefined;
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v ? v : undefined;
const strs = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.length ? v.map(String) : undefined;

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
    @InjectRepository(SavedViewEntity)
    private readonly repo: Repository<SavedViewEntity>,
  ) {}

  async get(token: string): Promise<PublicView> {
    // One generic error for malformed, unknown, revoked and no-longer-link-shared tokens.
    const missing = () =>
      new NotFoundException(
        'This shared view does not exist or is no longer shared',
      );
    if (!isPublicToken(token)) throw missing();
    const view = await this.repo.findOneBy({
      publicTokenHash: hashPublicToken(token),
    });
    if (
      !view ||
      view.sharing.visibility !== 'link' ||
      !VIEW_ENTITIES.includes(view.entity)
    )
      throw missing();

    const { workspaceId, entity } = view;
    const rows = await this.rowsOf(entity, workspaceId);
    const ctx: QueryContext = {};

    const sort =
      view.sort ??
      (view.layout === 'timeline'
        ? { field: 'startDate', direction: 'asc' as const }
        : null);
    const matched = sortItems(
      entity,
      applyFilters(entity, rows, view.filters, ctx),
      sort,
      ctx,
    );
    const kept = matched.slice(0, PUBLIC_VIEW_LIMIT);
    // A board always has columns: by status unless the view says otherwise.
    const groupBy = view.groupBy ?? (view.layout === 'board' ? 'status' : null);
    const groups = groupItems(entity, kept, groupBy, ctx);

    const names = await this.namesFor(workspaceId, entity, groupBy, kept, ctx);
    const workspace = await this.ds
      .getRepository(WorkspaceEntity)
      .findOneBy({ id: workspaceId });

    // Label ids mean nothing to a reader of the link: show the names.
    const labelNames = new Map(
      resolveLabelCatalog(workspace?.settings?.labels).map((l) => [
        l.id,
        l.name,
      ]),
    );
    const out: PublicViewGroup[] = groups.map((g) => ({
      key: g.key,
      label: this.groupLabel(entity, groupBy, g.key, names),
      items: g.items.map((r) => this.project(entity, r, names, labelNames)),
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

  private async rowsOf(
    entity: ViewEntity,
    workspaceId: string,
  ): Promise<Row[]> {
    const where = { workspaceId };
    const take = PUBLIC_VIEW_SCAN_LIMIT + 1;
    switch (entity) {
      case 'issue':
        return (await this.boundedRows(
          this.ds.getRepository(IssueEntity).find({ where, take }),
        )) as unknown as Row[];
      case 'project':
        return (await this.boundedRows(
          this.ds.getRepository(ProjectEntity).find({ where, take }),
        )) as unknown as Row[];
      default:
        return [];
    }
  }

  private async boundedRows<T>(query: Promise<T[]>): Promise<T[]> {
    const rows = await query;
    if (rows.length > PUBLIC_VIEW_SCAN_LIMIT) {
      throw new UnprocessableEntityException(
        `This shared view exceeds the ${PUBLIC_VIEW_SCAN_LIMIT.toLocaleString('en-US')}-row evaluation limit. Ask the owner to narrow it.`,
      );
    }
    return rows;
  }

  /** Display names for the people and projects the returned rows point at. */
  private async namesFor(
    workspaceId: string,
    entity: ViewEntity,
    groupBy: string | null,
    rows: readonly Row[],
    ctx: QueryContext,
  ): Promise<Names> {
    const names: Names = {
      user: new Map(),
      project: new Map(),
    };
    const fields = new Set<string>(
      entity === 'issue'
        ? ['assigneeId', 'projectId']
        : entity === 'project'
          ? ['leadId']
          : [],
    );
    if (groupBy) fields.add(groupBy);
    const ids: Record<RefKind, Set<string>> = {
      user: new Set(),
      project: new Set(),
    };
    let referenceCount = 0;
    for (const field of fields) {
      const spec = VIEW_FIELDS[entity]?.[field];
      if (!spec?.refersTo) continue;
      for (const row of rows) {
        for (const id of fieldValues(entity, row, field, ctx)) {
          const values = ids[spec.refersTo];
          if (values.has(id)) continue;
          values.add(id);
          referenceCount += 1;
          if (referenceCount > PUBLIC_VIEW_SCAN_LIMIT) {
            throw new UnprocessableEntityException(
              `This shared view exceeds the ${PUBLIC_VIEW_SCAN_LIMIT.toLocaleString('en-US')}-row evaluation limit. Ask the owner to narrow it.`,
            );
          }
        }
      }
    }
    if (ids.project.size)
      for (const p of await this.boundedRows(
        this.ds.getRepository(ProjectEntity).find({
          where: { workspaceId, id: In([...ids.project]) },
          select: { id: true, name: true },
          take: PUBLIC_VIEW_SCAN_LIMIT + 1,
        }),
      ))
        names.project.set(p.id, p.name);
    if (ids.user.size) {
      const members = await this.boundedRows(
        this.ds.getRepository(MembershipEntity).find({
          where: { workspaceId, userId: In([...ids.user]) },
          select: { userId: true },
          take: PUBLIC_VIEW_SCAN_LIMIT + 1,
        }),
      );
      const users = members.length
        ? await this.boundedRows(
            this.ds.getRepository(UserEntity).find({
              where: { id: In(members.map((m) => m.userId)) },
              select: { id: true, name: true },
              take: PUBLIC_VIEW_SCAN_LIMIT + 1,
            }),
          )
        : [];
      for (const u of users) names.user.set(u.id, u.name);
    }
    return names;
  }

  private groupLabel(
    entity: ViewEntity,
    groupBy: string | null,
    key: string,
    names: Names,
  ): string {
    if (!key) return '';
    const refersTo = groupBy
      ? VIEW_FIELDS[entity]?.[groupBy]?.refersTo
      : undefined;
    return (refersTo && names[refersTo]?.get(key)) || key;
  }

  /** The only place that decides which fields leave the server for an anonymous reader. */
  private project(
    entity: ViewEntity,
    r: Row,
    names: Names,
    labelNames: ReadonlyMap<string, string>,
  ): PublicViewItem {
    const name = (kind: RefKind, id: unknown): string | undefined =>
      typeof id === 'string' ? names[kind]?.get(id) : undefined;
    const base = { id: String(r['id']), updatedAt: iso(r['updatedAt']) ?? '' };
    const labels = (v: unknown): string[] | undefined =>
      strs(
        Array.isArray(v)
          ? v
              .map((id) => labelNames.get(String(id)))
              .filter((n): n is string => !!n)
          : undefined,
      );
    const compact = <T extends object>(o: T): T =>
      Object.fromEntries(
        Object.entries(o).filter(([, v]) => v !== undefined),
      ) as T;
    switch (entity) {
      case 'issue':
        return compact({
          ...base,
          key: str(r['key']),
          title: str(r['title']) ?? '',
          kind: str(r['kind']),
          status: str(r['status']),
          priority: str(r['priority']) as PublicViewItem['priority'],
          assignee: name('user', r['assigneeId']),
          project: name('project', r['projectId']),
          labels: labels(r['labels']),
        });
      case 'project':
        return compact({
          ...base,
          title: str(r['name']) ?? '',
          status: str(r['status']),
          priority: str(r['priority']) as PublicViewItem['priority'],
          assignee: name('user', r['leadId']),
          labels: labels(r['labels']),
          startDate: iso(r['startDate']),
          targetDate: iso(r['targetDate']),
        });
      default:
        return compact({ ...base, title: str(r['title']) ?? '' });
    }
  }
}
