import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

export const SEARCH_TYPES = ['workstream', 'intake', 'decision', 'execution', 'artifact', 'repository', 'team'] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];

export interface SearchResult {
  type: SearchType;
  id: string;
  key?: string;
  title: string;
  subtitle: string;
  workstreamKey?: string;
  score: number;
}

interface Spec {
  type: SearchType;
  from: string;
  /** SQL columns selected as id, key, title, subtitle, workstreamKey, body */
  select: string;
  /** searchable columns: [column, role] */
  fields: [string, 'key' | 'title' | 'body'][];
  /** tie-break order between types */
  rank: number;
}

const SPECS: Spec[] = [
  {
    type: 'workstream',
    from: `"workstreams" x JOIN "teams" t ON t."id" = x."ownerTeamId"`,
    select: `x."id" AS id, x."key" AS key, x."title" AS title, x."status" || ' · ' || t."name" AS subtitle, NULL AS "workstreamKey", x."objective" AS body`,
    fields: [['x."key"', 'key'], ['x."title"', 'title'], ['x."objective"', 'body']],
    rank: 0,
  },
  {
    type: 'intake',
    from: `"intake_items" x`,
    select: `x."id", x."key", x."title", x."kind" || ' · ' || x."state" AS subtitle, NULL AS "workstreamKey", x."body" AS body`,
    fields: [['x."key"', 'key'], ['x."title"', 'title'], ['x."body"', 'body']],
    rank: 2,
  },
  {
    type: 'decision',
    from: `"decisions" x`,
    select: `x."id", x."key", x."title", x."status" AS subtitle, NULL AS "workstreamKey", x."statement" AS body`,
    fields: [['x."key"', 'key'], ['x."title"', 'title'], ['x."statement"', 'body']],
    rank: 1,
  },
  {
    type: 'execution',
    from: `"executions" x JOIN "workstreams" w ON w."id" = x."workstreamId"`,
    select: `x."id", NULL AS key, x."title", x."state" || ' · ' || x."provider" AS subtitle, w."key" AS "workstreamKey", x."description" AS body`,
    fields: [['x."title"', 'title'], ['x."description"', 'body']],
    rank: 3,
  },
  {
    type: 'artifact',
    from: `"artifacts" x JOIN "workstreams" w ON w."id" = x."workstreamId"`,
    select: `x."id", x."externalId" AS key, x."title", x."kind" || ' · ' || x."state" AS subtitle, w."key" AS "workstreamKey", x."url" AS body`,
    fields: [['x."externalId"', 'key'], ['x."title"', 'title']],
    rank: 4,
  },
  {
    type: 'repository',
    from: `"repositories" x`,
    select: `x."id", NULL AS key, x."fullName" AS title, x."provider" AS subtitle, NULL AS "workstreamKey", NULL AS body`,
    fields: [['x."fullName"', 'title']],
    rank: 5,
  },
  {
    type: 'team',
    from: `"teams" x`,
    select: `x."id", x."key", x."name" AS title, 'Team' AS subtitle, NULL AS "workstreamKey", x."description" AS body`,
    fields: [['x."key"', 'key'], ['x."name"', 'title'], ['x."description"', 'body']],
    rank: 6,
  },
];

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

interface Row {
  id: string;
  key: string | null;
  title: string;
  subtitle: string;
  workstreamKey: string | null;
  body: string | null;
}

/** Scores a row: exact key 100, key prefix 80, key contains 60, title exact 70, prefix 55, contains 40, body 20. */
export function scoreRow(q: string, row: Pick<Row, 'key' | 'title' | 'body'>): number {
  const n = q.toLowerCase();
  const key = row.key?.toLowerCase();
  const title = row.title.toLowerCase();
  let score = 0;
  if (key === n) score = 100;
  else if (key?.startsWith(n)) score = 80;
  else if (key?.includes(n)) score = 60;
  if (title === n) score = Math.max(score, 70);
  else if (title.startsWith(n)) score = Math.max(score, 55);
  else if (title.includes(n)) score = Math.max(score, 40);
  else if (n.split(/\s+/).every((t) => title.includes(t))) score = Math.max(score, 30);
  if (!score) score = row.body?.toLowerCase().includes(n) ? 20 : 10;
  return score;
}

@Injectable()
export class SearchService {
  constructor(private readonly ds: DataSource) {}

  async search(workspaceId: string, q: string, opts: { types?: SearchType[]; limit?: number } = {}): Promise<{ results: SearchResult[] }> {
    const query = q.trim();
    if (!query) return { results: [] };
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
    const terms = query.split(/\s+/).slice(0, 6);
    const specs = SPECS.filter((s) => !opts.types?.length || opts.types.includes(s.type));

    const perType = await Promise.all(
      specs.map(async (spec) => {
        const params: unknown[] = [workspaceId];
        const termClauses = terms.map((t) => {
          params.push(`%${escapeLike(t)}%`);
          const p = `$${params.length}`;
          return `(${spec.fields.map(([col]) => `${col} ILIKE ${p}`).join(' OR ')})`;
        });
        const rows = await this.ds.query<Row[]>(
          `SELECT ${spec.select} FROM ${spec.from} WHERE x."workspaceId" = $1 AND ${termClauses.join(' AND ')} LIMIT 200`,
          params,
        );
        return rows.map((r): SearchResult & { rank: number } => ({
          type: spec.type,
          id: r.id,
          ...(r.key ? { key: r.key } : {}),
          title: r.title,
          subtitle: r.subtitle,
          ...(r.workstreamKey ? { workstreamKey: r.workstreamKey } : {}),
          score: scoreRow(query, r),
          rank: spec.rank,
        }));
      }),
    );
    const results = perType
      .flat()
      .sort((a, b) => b.score - a.score || a.rank - b.rank || a.title.localeCompare(b.title))
      .slice(0, limit)
      .map(({ rank: _rank, ...r }) => r);
    return { results };
  }
}
