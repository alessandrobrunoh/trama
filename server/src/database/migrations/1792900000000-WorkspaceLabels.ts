import { MigrationInterface, QueryRunner } from 'typeorm';
import { adoptFreeTextLabels, type WorkspaceLabel } from '../../contracts/domain.js';

/**
 * Labels become a workspace catalog. Issues, projects and repositories gain a `labels` column.
 * Existing free-text workstream labels (and saved-view filters on that field) are rewritten to catalog ids.
 * Down drops the new columns; workstream labels stay as ids.
 */
export class WorkspaceLabels1792900000000 implements MigrationInterface {
  name = 'WorkspaceLabels1792900000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "issues" ADD "labels" jsonb NOT NULL DEFAULT '[]'`);
    await q.query(`ALTER TABLE "projects" ADD "labels" jsonb NOT NULL DEFAULT '[]'`);
    await q.query(`ALTER TABLE "repositories" ADD "labels" jsonb NOT NULL DEFAULT '[]'`);

    const workspaces = await q.query(`SELECT "id", "settings" FROM "workspaces"`) as { id: string; settings: { labels?: WorkspaceLabel[] } | null }[];
    for (const ws of workspaces) {
      const streams = await q.query(`SELECT "id", "labels" FROM "workstreams" WHERE "workspaceId" = $1`, [ws.id]) as { id: string; labels: string[] | null }[];
      const views = await q.query(`SELECT "id", "filters" FROM "saved_views" WHERE "workspaceId" = $1`, [ws.id]) as { id: string; filters: { field: string; op: string; value: string | string[] }[] | null }[];
      const viewValues = views.flatMap((view) =>
        (view.filters ?? []).flatMap((filter) =>
          filter.field === 'labels' ? (Array.isArray(filter.value) ? filter.value : [filter.value]) : [],
        ),
      );
      const { catalog, groups, lookup } = adoptFreeTextLabels(ws.settings?.labels, [
        ...streams.map((row) => row.labels ?? []),
        viewValues,
      ]);
      for (let i = 0; i < streams.length; i++) {
        if (JSON.stringify(streams[i].labels ?? []) === JSON.stringify(groups[i])) continue;
        await q.query(`UPDATE "workstreams" SET "labels" = $2::jsonb WHERE "id" = $1`, [streams[i].id, JSON.stringify(groups[i])]);
      }
      for (const view of views) {
        const next = rewriteLabelFilters(view.filters, lookup);
        if (JSON.stringify(next) === JSON.stringify(view.filters ?? [])) continue;
        await q.query(`UPDATE "saved_views" SET "filters" = $2::jsonb WHERE "id" = $1`, [view.id, JSON.stringify(next)]);
      }
      const settings = { ...(ws.settings ?? {}), labels: catalog };
      await q.query(`UPDATE "workspaces" SET "settings" = $2::jsonb WHERE "id" = $1`, [ws.id, JSON.stringify(settings)]);
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "repositories" DROP COLUMN "labels"`);
    await q.query(`ALTER TABLE "projects" DROP COLUMN "labels"`);
    await q.query(`ALTER TABLE "issues" DROP COLUMN "labels"`);
  }
}

function rewriteLabelFilters(
  filters: { field: string; op: string; value: string | string[] }[] | null,
  lookup: Map<string, string>,
): { field: string; op: string; value: string | string[] }[] {
  const idFor = (value: string): string => lookup.get(value.trim()) ?? value;
  return (filters ?? []).map((filter) => {
    if (filter.field !== 'labels') return filter;
    if (Array.isArray(filter.value)) return { ...filter, value: [...new Set(filter.value.map(idFor))] };
    return { ...filter, value: idFor(filter.value) };
  });
}
