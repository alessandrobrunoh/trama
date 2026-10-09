import type { Customer, CustomerRequest, Issue, Project } from '../../core/contracts/domain';

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
