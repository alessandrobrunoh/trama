import type { Customer, CustomerRequest, Issue } from '../../core/contracts/domain';

export interface LinkedIssue {
  request: CustomerRequest;
  issue: Issue;
}

export interface LinkedCustomer {
  request: CustomerRequest;
  customer: Customer;
}

/** Issues linked to one customer, newest issue update first. A pair is shown once. Missing issues are dropped. */
export function linkedIssues(
  customerId: string,
  requests: readonly CustomerRequest[],
  issues: ReadonlyMap<string, Issue>,
): LinkedIssue[] {
  const rows: LinkedIssue[] = [];
  const seen = new Set<string>();
  for (const request of requests) {
    if (request.customerId !== customerId || seen.has(request.issueId)) continue;
    const issue = issues.get(request.issueId);
    if (!issue) continue;
    seen.add(request.issueId);
    rows.push({ request, issue });
  }
  return rows.sort((a, b) => (a.issue.updatedAt < b.issue.updatedAt ? 1 : a.issue.updatedAt > b.issue.updatedAt ? -1 : a.issue.key.localeCompare(b.issue.key)));
}

/** Customers linked to one issue, by name. A pair is shown once. Missing customers are dropped. */
export function linkedCustomers(
  issueId: string,
  requests: readonly CustomerRequest[],
  customers: ReadonlyMap<string, Customer>,
): LinkedCustomer[] {
  const rows: LinkedCustomer[] = [];
  const seen = new Set<string>();
  for (const request of requests) {
    if (request.issueId !== issueId || seen.has(request.customerId)) continue;
    const customer = customers.get(request.customerId);
    if (!customer) continue;
    seen.add(request.customerId);
    rows.push({ request, customer });
  }
  return rows.sort((a, b) => a.customer.name.localeCompare(b.customer.name) || a.customer.domain.localeCompare(b.customer.domain));
}

/** Distinct customers per issue. */
export function customerCounts(requests: readonly CustomerRequest[]): Map<string, number> {
  const sets = new Map<string, Set<string>>();
  for (const request of requests) {
    let set = sets.get(request.issueId);
    if (!set) {
      set = new Set();
      sets.set(request.issueId, set);
    }
    set.add(request.customerId);
  }
  return new Map([...sets].map(([id, set]) => [id, set.size]));
}
