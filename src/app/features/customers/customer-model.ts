import { CUSTOMER_STATUSES, isRequestDelivered } from '../../core/contracts/domain';
import type { ActorRef, Customer, Demand, DomainEvent, CustomerRequest, CustomerStatus, CustomerTier, Issue, Priority, Project } from '../../core/contracts/domain';

/** A customer request together with the issue or project it sits on. */
export interface RequestRow {
  request: CustomerRequest;
  issue?: Issue;
  project?: Project;
}

/** A customer request together with the customer who made it. */
export interface RequestWithCustomer {
  request: CustomerRequest;
  customer: Customer;
}

/** Important first, then newest first, then id so the order is stable. */
function byImportanceThenNewest(a: CustomerRequest, b: CustomerRequest): number {
  if (a.important !== b.important) return a.important ? -1 : 1;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return a.id.localeCompare(b.id);
}

/** The requests on one issue or one project, with their customer. Requests whose customer is missing are dropped. */
export function requestsOn(
  target: { issueId: string } | { projectId: string },
  requests: readonly CustomerRequest[],
  customers: ReadonlyMap<string, Customer>,
): RequestWithCustomer[] {
  const rows: RequestWithCustomer[] = [];
  for (const request of requests) {
    const hit = 'issueId' in target ? request.issueId === target.issueId : request.projectId === target.projectId;
    if (!hit) continue;
    const customer = customers.get(request.customerId);
    if (customer) rows.push({ request, customer });
  }
  return rows.sort((a, b) => byImportanceThenNewest(a.request, b.request));
}

/** One customer's requests, each with its issue or project; requests whose target is missing are dropped. */
export function requestRows(
  customerId: string,
  requests: readonly CustomerRequest[],
  issues: ReadonlyMap<string, Issue>,
  projects: ReadonlyMap<string, Project>,
): RequestRow[] {
  const rows: RequestRow[] = [];
  for (const request of requests) {
    if (request.customerId !== customerId) continue;
    const issue = request.issueId ? issues.get(request.issueId) : undefined;
    const project = request.projectId ? projects.get(request.projectId) : undefined;
    if (issue) rows.push({ request, issue });
    else if (project) rows.push({ request, project });
  }
  return rows.sort((a, b) => byImportanceThenNewest(a.request, b.request));
}

/** Distinct customers per issue. Requests on projects are not counted. */
export function customerCounts(requests: readonly CustomerRequest[]): Map<string, number> {
  const sets = new Map<string, Set<string>>();
  for (const request of requests) {
    if (!request.issueId) continue;
    let set = sets.get(request.issueId);
    if (!set) {
      set = new Set();
      sets.set(request.issueId, set);
    }
    set.add(request.customerId);
  }
  return new Map([...sets].map(([id, set]) => [id, set.size]));
}

/** `1234567` -> `1.2M`. Revenue has no stored currency, so it is shown unit-less and compact. */
export function compactNumber(value: number): string {
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

/** Free text (commas, spaces or new lines) to a list of domain candidates. */
export function splitDomains(text: string): string[] {
  return text.split(/[\s,;]+/).filter(Boolean);
}

// ───────────────────────── stats, states, grouping ─────────────────────────

/** Where a request stands: waiting on work, delivered with that work, or dropped because the work was canceled. */
export type RequestState = 'open' | 'delivered' | 'dropped';

/** The state of a request; a request whose issue or project is gone counts as dropped. */
export function requestState(
  request: Pick<CustomerRequest, 'issueId' | 'projectId'>,
  issues: ReadonlyMap<string, Pick<Issue, 'status'>>,
  projects: ReadonlyMap<string, Pick<Project, 'status'>>,
): RequestState {
  if (isRequestDelivered(request, issues, projects)) return 'delivered';
  const status = request.issueId ? issues.get(request.issueId)?.status : request.projectId ? projects.get(request.projectId)?.status : undefined;
  return status === undefined || status === 'canceled' ? 'dropped' : 'open';
}

/** One customer with the numbers the list and page show. Derived from the loaded requests, never stored. */
export interface CustomerStats {
  customer: Customer;
  tier?: CustomerTier;
  requests: number;
  important: number;
  /** Requests still waiting on work that is not done. */
  open: number;
  delivered: number;
  /** Open requests flagged important: the ones to look at first. */
  openImportant: number;
  /** Newest request, ISO. */
  lastRequestAt?: string;
}

export function customerStats(
  customers: readonly Customer[],
  requests: readonly CustomerRequest[],
  issues: ReadonlyMap<string, Issue>,
  projects: ReadonlyMap<string, Project>,
  tiers: readonly CustomerTier[],
): CustomerStats[] {
  const tierById = new Map(tiers.map((t) => [t.id, t]));
  const byCustomer = new Map<string, CustomerStats>();
  for (const customer of customers) {
    const tier = customer.tierId ? tierById.get(customer.tierId) : undefined;
    byCustomer.set(customer.id, {
      customer,
      ...(tier ? { tier } : {}),
      requests: 0,
      important: 0,
      open: 0,
      delivered: 0,
      openImportant: 0,
    });
  }
  for (const request of requests) {
    const stats = byCustomer.get(request.customerId);
    if (!stats) continue;
    stats.requests += 1;
    if (request.important) stats.important += 1;
    const state = requestState(request, issues, projects);
    if (state === 'open') {
      stats.open += 1;
      if (request.important) stats.openImportant += 1;
    } else if (state === 'delivered') stats.delivered += 1;
    if (!stats.lastRequestAt || request.createdAt > stats.lastRequestAt) stats.lastRequestAt = request.createdAt;
  }
  return [...byCustomer.values()];
}

export type CustomerSort = 'name' | 'tier' | 'revenue' | 'size' | 'requests' | 'important' | 'open' | 'last';
export type CustomerGroup = 'none' | 'tier' | 'status';

/** Sorts a copy. Rows with no value always go last, whatever the direction; name breaks ties. */
export function sortCustomerStats(rows: readonly CustomerStats[], sort: CustomerSort, dir: 'asc' | 'desc'): CustomerStats[] {
  const sign = dir === 'asc' ? 1 : -1;
  const value = (r: CustomerStats): number | string | undefined => {
    switch (sort) {
      case 'name': return r.customer.name.toLowerCase();
      case 'tier': return r.tier?.name.toLowerCase();
      case 'revenue': return r.customer.revenue;
      case 'size': return r.customer.size;
      case 'requests': return r.requests;
      case 'important': return r.important;
      case 'open': return r.open;
      case 'last': return r.lastRequestAt;
    }
  };
  return rows.slice().sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    if (va === undefined || vb === undefined) {
      if (va !== vb) return va === undefined ? 1 : -1;
    } else if (va !== vb) {
      return (va < vb ? -1 : 1) * sign;
    }
    return a.customer.name.localeCompare(b.customer.name);
  });
}

export interface CustomerBucket {
  key: string;
  label: string;
  color?: string;
  rows: CustomerStats[];
}

const STATUS_LABEL: Record<CustomerStatus, string> = { active: 'Active', prospect: 'Prospect', churned: 'Churned' };

/** Groups already-sorted rows. Tiers follow the workspace's order, then "No tier"; statuses active, prospect, churned. */
export function groupCustomerStats(
  rows: readonly CustomerStats[],
  group: CustomerGroup,
  tiers: readonly CustomerTier[],
): CustomerBucket[] {
  if (group === 'none') return [{ key: '', label: '', rows: rows.slice() }];
  const buckets: CustomerBucket[] =
    group === 'tier'
      ? [...tiers.map((t) => ({ key: t.id, label: t.name, color: t.color, rows: [] as CustomerStats[] })), { key: '', label: 'No tier', rows: [] }]
      : CUSTOMER_STATUSES.map((s) => ({ key: s, label: STATUS_LABEL[s], rows: [] as CustomerStats[] }));
  for (const row of rows) {
    const key = group === 'tier' ? (row.tier?.id ?? '') : row.customer.status;
    (buckets.find((b) => b.key === key) ?? buckets[buckets.length - 1]).rows.push(row);
  }
  return buckets.filter((b) => b.rows.length);
}

/** Where the customers' requests stand for an issue: delivered once it is done, dropped when canceled. */
export function issueWorkState(status: string): RequestState {
  return status === 'done' ? 'delivered' : status === 'canceled' ? 'dropped' : 'open';
}

/** The same for a project: delivered once completed, dropped when canceled. */
export function projectWorkState(status: string): RequestState {
  return status === 'completed' ? 'delivered' : status === 'canceled' ? 'dropped' : 'open';
}

// ───────────────────────── a customer's work ─────────────────────────

/** One issue or project a customer asked for, with that customer's requests on it rolled up. */
export interface WorkRow {
  kind: 'issue' | 'project';
  id: string;
  /** `BUG-142` for issues; absent for projects. */
  key?: string;
  title: string;
  status: string;
  priority: Priority;
  teamId?: string;
  /** This customer's requests on it. */
  requests: number;
  important: number;
  state: RequestState;
  /** Newest request of this customer on it, ISO. */
  lastRequestAt: string;
}

/** The issues and projects one customer asked for, one row each. Requests whose target is gone are left out. */
export function workRows(
  customerId: string,
  requests: readonly CustomerRequest[],
  issues: ReadonlyMap<string, Issue>,
  projects: ReadonlyMap<string, Project>,
): WorkRow[] {
  const rows = new Map<string, WorkRow>();
  for (const request of requests) {
    if (request.customerId !== customerId) continue;
    const issue = request.issueId ? issues.get(request.issueId) : undefined;
    const project = request.projectId ? projects.get(request.projectId) : undefined;
    const target = issue ?? project;
    if (!target) continue;
    let row = rows.get(target.id);
    if (!row) {
      row = {
        kind: issue ? 'issue' : 'project',
        id: target.id,
        ...(issue ? { key: issue.key } : {}),
        title: issue ? issue.title : project!.name,
        status: target.status,
        priority: target.priority,
        ...((issue ? issue.teamId : project!.teamIds[0]) ? { teamId: (issue ? issue.teamId : project!.teamIds[0]) as string } : {}),
        requests: 0,
        important: 0,
        state: requestState(request, issues, projects),
        lastRequestAt: request.createdAt,
      };
      rows.set(target.id, row);
    }
    row.requests += 1;
    if (request.important) row.important += 1;
    if (request.createdAt > row.lastRequestAt) row.lastRequestAt = request.createdAt;
  }
  return [...rows.values()];
}

export type WorkGroup = 'state' | 'status' | 'priority' | 'team' | 'kind';

const STATE_ORDER: readonly string[] = ['open', 'delivered', 'dropped'];
const PRIORITY_ORDER: readonly string[] = ['urgent', 'high', 'medium', 'low', 'none'];
const STATUS_ORDER: readonly string[] = ['in_progress', 'in_review', 'todo', 'planned', 'backlog', 'paused', 'draft', 'done', 'completed', 'canceled'];

/** Important first, then the most requested, then newest: what to look at first. */
export function sortWork(rows: readonly WorkRow[]): WorkRow[] {
  return rows
    .slice()
    .sort((a, b) => Number(b.important > 0) - Number(a.important > 0) || b.requests - a.requests || b.lastRequestAt.localeCompare(a.lastRequestAt) || a.id.localeCompare(b.id));
}

/** Groups rows (already in the order to show). Keys follow a meaningful order; rows with no value land in `''` last. */
export function groupWork(rows: readonly WorkRow[], group: WorkGroup): { key: string; rows: WorkRow[] }[] {
  const keyOf = (r: WorkRow): string => {
    switch (group) {
      case 'state': return r.state;
      case 'status': return r.status;
      case 'priority': return r.priority;
      case 'team': return r.teamId ?? '';
      case 'kind': return r.kind;
    }
  };
  const buckets = new Map<string, WorkRow[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const list = buckets.get(key);
    if (list) list.push(row);
    else buckets.set(key, [row]);
  }
  const rank = (key: string): number => {
    const order = group === 'state' ? STATE_ORDER : group === 'priority' ? PRIORITY_ORDER : group === 'status' ? STATUS_ORDER : group === 'kind' ? ['issue', 'project'] : [];
    const i = order.indexOf(key);
    return i < 0 ? order.length : i;
  };
  return [...buckets.entries()]
    .map(([key, list]) => ({ key, rows: list }))
    .sort((a, b) => (a.key === '' ? 1 : b.key === '' ? -1 : rank(a.key) - rank(b.key) || a.key.localeCompare(b.key)));
}

// ───────────────────────── activity ─────────────────────────

/** One line of a customer's timeline. */
export interface CustomerActivityItem {
  id: string;
  at: string;
  /** Who did it; absent for "delivered", which happens when the work is done. */
  actor?: ActorRef;
  text: string;
  /** Where it leads, below `/:workspace`. */
  link?: string[];
}

const plainFields = (v: unknown): string =>
  (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []).map((f) => (f === 'tierId' ? 'tier' : f === 'logoUrl' ? 'logo' : f)).join(', ');

/**
 * The timeline of one customer, newest first: what the team did to the record and its requests (from the recorded
 * events) and, derived from the work itself, when something they asked for was delivered.
 */
export function customerActivity(
  customerId: string,
  events: readonly DomainEvent[],
  requests: readonly CustomerRequest[],
  issues: ReadonlyMap<string, Issue>,
  projects: ReadonlyMap<string, Project>,
): CustomerActivityItem[] {
  const where = (issueId?: unknown, projectId?: unknown): { label: string; link?: string[] } => {
    const issue = typeof issueId === 'string' ? issues.get(issueId) : undefined;
    if (issue) return { label: issue.key, link: ['issues', issue.key] };
    const project = typeof projectId === 'string' ? projects.get(projectId) : undefined;
    if (project) return { label: project.name, link: ['projects', project.id] };
    return { label: 'work that no longer exists' };
  };
  const items: CustomerActivityItem[] = [];
  for (const e of events) {
    const mine = e.type.startsWith('customer_request.') ? e.data['customerId'] === customerId : e.type.startsWith('customer.') && e.subject.id === customerId;
    if (!mine) continue;
    const base = { id: e.id, at: e.at, actor: e.actor };
    const target = where(e.data['issueId'], e.data['projectId']);
    switch (e.type) {
      case 'customer.created':
        items.push({ ...base, text: 'Added the customer' });
        break;
      case 'customer.updated':
        items.push({ ...base, text: `Updated ${plainFields(e.data['fields']) || 'the details'}` });
        break;
      case 'customer.archived':
        items.push({ ...base, text: 'Archived the customer' });
        break;
      case 'customer.restored':
        items.push({ ...base, text: 'Restored the customer' });
        break;
      case 'customer_request.linked':
        items.push({ ...base, text: `Recorded ${e.data['important'] === true ? 'an important request' : 'a request'} on ${target.label}`, link: target.link });
        break;
      case 'customer_request.updated': {
        const fields = Array.isArray(e.data['fields']) ? (e.data['fields'] as unknown[]) : [];
        const text = fields.includes('important')
          ? e.data['important'] === true ? `Flagged the request on ${target.label} as important` : `Removed the important flag on ${target.label}`
          : `Edited the request on ${target.label}`;
        items.push({ ...base, text, link: target.link });
        break;
      }
      case 'customer_request.unlinked':
        items.push({ ...base, text: `Removed a request on ${target.label}` });
        break;
    }
  }
  const seen = new Set<string>();
  for (const request of requests) {
    if (request.customerId !== customerId) continue;
    const issue = request.issueId ? issues.get(request.issueId) : undefined;
    const project = request.projectId ? projects.get(request.projectId) : undefined;
    const target = issue ?? project;
    if (!target || seen.has(target.id) || requestState(request, issues, projects) !== 'delivered') continue;
    seen.add(target.id);
    items.push({
      id: `delivered:${target.id}`,
      at: target.completedAt ?? target.updatedAt,
      text: issue ? `${issue.key} was delivered` : `${project!.name} was delivered`,
      link: issue ? ['issues', issue.key] : ['projects', project!.id],
    });
  }
  return items.sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id));
}

/** The request counts people read at a glance: "3 open · 2 delivered". */
export function describeRequestStates(open: number, delivered: number): string {
  const parts = [open ? `${open} open` : '', delivered ? `${delivered} delivered` : ''].filter(Boolean);
  return parts.join(' · ') || 'No requests';
}

/** "3 customers · 5 requests · 2 important · 340K revenue": what a row's demand adds up to. */
export function describeDemand(d: Pick<Demand, 'customerCount' | 'requestCount' | 'importantCount' | 'revenue'>): string {
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  return [
    plural(d.customerCount, 'customer'),
    plural(d.requestCount, 'request'),
    d.importantCount ? `${d.importantCount} important` : '',
    d.revenue ? `${compactNumber(d.revenue)} revenue` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}
