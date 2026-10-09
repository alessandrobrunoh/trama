/**
 * Demand filters for lists of issues and projects: which customers asked for the row, how many requests,
 * how much revenue. Builds `WHERE` fragments (with named parameters) that the list queries append.
 * Pure: no database access, so the SQL it produces is unit-tested as text.
 */

export interface DemandFilter {
  /** Only rows with a request from this customer. */
  customerId?: string;
  /** Only rows with a request from a customer of this tier. */
  tierId?: string;
  /** At least this many distinct requesting customers. */
  minCustomers?: number;
  /** At least this many requests (a customer can ask several times). */
  minRequests?: number;
  /** The requesting customers' revenue adds up to at least this (each customer counted once). */
  minRevenue?: number;
  /** `true`: at least one request flagged important. */
  important?: boolean;
}

export interface DemandCondition {
  sql: string;
  params: Record<string, unknown>;
}

/** The request column that points at the row: issues use `issueId`, projects `projectId`. */
export type DemandTarget = 'issueId' | 'projectId';

/**
 * Which requests belong to the row (`cr` is the request alias). An issue: its own. A project: its own plus those
 * on its issues, planned under it or linked to one of its workstreams (the meaning of the client's `issuesByProject`).
 */
export function demandScope(alias: string, target: DemandTarget): string {
  if (!/^[a-z][a-z0-9_]*$/i.test(alias)) throw new Error(`Bad SQL alias "${alias}"`);
  const same = `cr."workspaceId" = ${alias}."workspaceId"`;
  if (target === 'issueId') return `${same} AND cr."issueId" = ${alias}.id`;
  return (
    `${same} AND (cr."projectId" = ${alias}.id OR cr."issueId" IN (` +
    `SELECT di.id FROM issues di WHERE di."workspaceId" = ${alias}."workspaceId" AND (di."projectId" = ${alias}.id OR EXISTS (` +
    `SELECT 1 FROM workstreams dw WHERE dw."workspaceId" = di."workspaceId" AND dw."projectId" = ${alias}.id ` +
    `AND di."workstreamIds" @> jsonb_build_array(dw.id)))))`
  );
}

/** Whole numbers only; anything else is dropped rather than interpolated or compared. */
const count = (n: number | undefined): n is number => n !== undefined && Number.isFinite(n) && n >= 1;

export function demandConditions(alias: string, target: DemandTarget, f: DemandFilter): DemandCondition[] {
  const out: DemandCondition[] = [];
  const own = demandScope(alias, target);

  if (f.customerId) {
    out.push({
      sql: `EXISTS (SELECT 1 FROM customer_requests cr WHERE ${own} AND cr."customerId" = :dmCustomerId)`,
      params: { dmCustomerId: f.customerId },
    });
  }
  if (f.tierId) {
    out.push({
      sql: `EXISTS (SELECT 1 FROM customer_requests cr JOIN customers c ON c.id = cr."customerId" WHERE ${own} AND c."tierId" = :dmTierId)`,
      params: { dmTierId: f.tierId },
    });
  }
  if (count(f.minCustomers)) {
    out.push({
      sql: `(SELECT COUNT(DISTINCT cr."customerId") FROM customer_requests cr WHERE ${own}) >= :dmMinCustomers`,
      params: { dmMinCustomers: Math.floor(f.minCustomers) },
    });
  }
  if (count(f.minRequests)) {
    out.push({
      sql: `(SELECT COUNT(*) FROM customer_requests cr WHERE ${own}) >= :dmMinRequests`,
      params: { dmMinRequests: Math.floor(f.minRequests) },
    });
  }
  if (f.minRevenue !== undefined && Number.isFinite(f.minRevenue) && f.minRevenue > 0) {
    out.push({
      sql:
        `(SELECT COALESCE(SUM(c.revenue), 0) FROM customers c WHERE c."workspaceId" = ${alias}."workspaceId" AND c.id IN ` +
        `(SELECT cr."customerId" FROM customer_requests cr WHERE ${own})) >= :dmMinRevenue`,
      params: { dmMinRevenue: f.minRevenue },
    });
  }
  if (f.important === true) {
    out.push({
      sql: `EXISTS (SELECT 1 FROM customer_requests cr WHERE ${own} AND cr.important = true)`,
      params: {},
    });
  }
  return out;
}
