var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
export const SEARCH_TYPES = ['workstream', 'intake', 'decision', 'execution', 'artifact', 'repository', 'team'];
const SPECS = [
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
const escapeLike = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
export function scoreRow(q, row) {
    const n = q.toLowerCase();
    const key = row.key?.toLowerCase();
    const title = row.title.toLowerCase();
    let score = 0;
    if (key === n)
        score = 100;
    else if (key?.startsWith(n))
        score = 80;
    else if (key?.includes(n))
        score = 60;
    if (title === n)
        score = Math.max(score, 70);
    else if (title.startsWith(n))
        score = Math.max(score, 55);
    else if (title.includes(n))
        score = Math.max(score, 40);
    else if (n.split(/\s+/).every((t) => title.includes(t)))
        score = Math.max(score, 30);
    if (!score)
        score = row.body?.toLowerCase().includes(n) ? 20 : 10;
    return score;
}
let SearchService = class SearchService {
    ds;
    constructor(ds) {
        this.ds = ds;
    }
    async search(workspaceId, q, opts = {}) {
        const query = q.trim();
        if (!query)
            return { results: [] };
        const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
        const terms = query.split(/\s+/).slice(0, 6);
        const specs = SPECS.filter((s) => !opts.types?.length || opts.types.includes(s.type));
        const perType = await Promise.all(specs.map(async (spec) => {
            const params = [workspaceId];
            const termClauses = terms.map((t) => {
                params.push(`%${escapeLike(t)}%`);
                const p = `$${params.length}`;
                return `(${spec.fields.map(([col]) => `${col} ILIKE ${p}`).join(' OR ')})`;
            });
            const rows = await this.ds.query(`SELECT ${spec.select} FROM ${spec.from} WHERE x."workspaceId" = $1 AND ${termClauses.join(' AND ')} LIMIT 200`, params);
            return rows.map((r) => ({
                type: spec.type,
                id: r.id,
                ...(r.key ? { key: r.key } : {}),
                title: r.title,
                subtitle: r.subtitle,
                ...(r.workstreamKey ? { workstreamKey: r.workstreamKey } : {}),
                score: scoreRow(query, r),
                rank: spec.rank,
            }));
        }));
        const results = perType
            .flat()
            .sort((a, b) => b.score - a.score || a.rank - b.rank || a.title.localeCompare(b.title))
            .slice(0, limit)
            .map(({ rank: _rank, ...r }) => r);
        return { results };
    }
};
SearchService = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [DataSource])
], SearchService);
export { SearchService };
//# sourceMappingURL=search.service.js.map