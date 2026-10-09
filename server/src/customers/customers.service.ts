import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, type Repository } from 'typeorm';
import type { ActorRef, CustomerStatus, IntakeProvider } from '../contracts/domain.js';
import {
  CUSTOMER_DOMAINS_MAX,
  CUSTOMER_REQUEST_BODY_MAX,
  CUSTOMER_REVENUE_MAX,
  CUSTOMER_SIZE_MAX,
  CUSTOMER_STATUSES,
  normalizeCustomerDomains,
  normalizeHttpUrl,
  resolveCustomerTiers,
} from '../contracts/domain.js';
import { notFound, uid } from '../common/util.js';
import {
  CustomerEntity,
  CustomerRequestEntity,
  IssueEntity,
  ProjectEntity,
  WorkspaceEntity,
} from '../database/entities/index.js';
import { demandScope } from './demand-filter.js';
import { EventsService } from '../events/events.service.js';

export interface CustomerInput {
  name?: string;
  /** Replaces the primary domain only; the other domains stay. Ignored when `domains` is sent. */
  domain?: string;
  /** Replaces the whole list; the first one is the primary domain. */
  domains?: string[];
  logoUrl?: string | null;
  revenue?: number | null;
  size?: number | null;
  tierId?: string | null;
  status?: CustomerStatus;
  /** `true` archives, `false` restores. Links stay either way. */
  archived?: boolean;
}

export interface CustomerFilter {
  /** `true` only archived, `all` both, otherwise only active. */
  archived?: 'true' | 'false' | 'all';
  /** Only customers with a request on this issue. */
  issueId?: string;
  /** Only customers with a request on this project. */
  projectId?: string;
  tierId?: string;
  status?: CustomerStatus;
  q?: string;
}

export interface CustomerRequestInput {
  /** Exactly one of `issueId` / `projectId`. */
  issueId?: string;
  projectId?: string;
  body?: string | null;
  important?: boolean;
  sourceUrl?: string | null;
  /** Provenance, set only by the customer-intake service (never by the REST body). */
  source?: IntakeProvider;
  externalId?: string;
  requesterEmail?: string;
  requesterName?: string;
}

export interface CustomerRequestPatch {
  body?: string | null;
  important?: boolean;
  sourceUrl?: string | null;
}

export interface CustomerRequestFilter {
  customerId?: string;
  issueId?: string;
  projectId?: string;
  important?: boolean;
}

export interface CustomerRequestView {
  id: string;
  workspaceId: string;
  customerId: string;
  issueId?: string;
  projectId?: string;
  body?: string;
  important: boolean;
  sourceUrl?: string;
  source?: IntakeProvider;
  externalId?: string;
  requesterEmail?: string;
  requesterName?: string;
  createdBy: ActorRef;
  createdAt: Date;
  updatedAt: Date;
  issue?: { id: string; key: string; title: string; status: string; updatedAt: Date };
  project?: { id: string; name: string; status: string; updatedAt: Date };
}

/** Whole non-negative number within `max`, or a 400 naming the field. */
function wholeNumber(field: string, value: number, max: number): number {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new BadRequestException(`${field} must be a whole number between 0 and ${max}`);
  }
  return value;
}

@Injectable()
export class CustomersService {
  constructor(
    private readonly ds: DataSource,
    private readonly events: EventsService,
    @InjectRepository(CustomerEntity) private readonly customers: Repository<CustomerEntity>,
    @InjectRepository(CustomerRequestEntity) private readonly requests: Repository<CustomerRequestEntity>,
  ) {}

  list(workspaceId: string, f: CustomerFilter = {}) {
    const qb = this.customers
      .createQueryBuilder('c')
      .where('c.workspaceId = :workspaceId', { workspaceId })
      .orderBy('c.name', 'ASC')
      .addOrderBy('c.id', 'ASC');
    if (f.archived === 'true') qb.andWhere('c.archivedAt IS NOT NULL');
    else if (f.archived !== 'all') qb.andWhere('c.archivedAt IS NULL');
    if (f.issueId) {
      qb.andWhere(
        `EXISTS (SELECT 1 FROM customer_requests cr WHERE cr."workspaceId" = c."workspaceId" AND cr."customerId" = c.id AND cr."issueId" = :issueId)`,
        { issueId: f.issueId },
      );
    }
    if (f.projectId) {
      qb.andWhere(
        `EXISTS (SELECT 1 FROM customer_requests cr WHERE cr."workspaceId" = c."workspaceId" AND cr."customerId" = c.id AND cr."projectId" = :projectId)`,
        { projectId: f.projectId },
      );
    }
    if (f.tierId) qb.andWhere('c.tierId = :tierId', { tierId: f.tierId });
    if (f.status) qb.andWhere('c.status = :status', { status: f.status });
    if (f.q) qb.andWhere('(c.name ILIKE :q OR c.domains::text ILIKE :q)', { q: `%${f.q}%` });
    return qb.getMany();
  }

  async get(workspaceId: string, id: string) {
    const row = await this.customers.findOneBy({ workspaceId, id });
    if (!row) throw notFound('Customer', id);
    return row;
  }

  async create(workspaceId: string, actor: ActorRef, input: CustomerInput & { name: string }) {
    const name = input.name.trim();
    if (!name) throw new BadRequestException('name is required');
    const domains = this.domainList(input.domains ?? (input.domain !== undefined ? [input.domain] : []));
    const row = this.customers.create({
      id: uid('cus'),
      workspaceId,
      name,
      domain: domains[0],
      domains,
      logoUrl: input.logoUrl ? this.logo(input.logoUrl) : null,
      revenue: input.revenue == null ? null : wholeNumber('revenue', input.revenue, CUSTOMER_REVENUE_MAX),
      size: input.size == null ? null : wholeNumber('size', input.size, CUSTOMER_SIZE_MAX),
      tierId: input.tierId ? await this.tier(workspaceId, input.tierId) : null,
      status: this.status(input.status ?? 'active'),
      createdBy: actor,
      archivedAt: null,
    });
    await this.saveWithDomainCheck(workspaceId, row);
    await this.events.record({
      workspaceId,
      actor,
      type: 'customer.created',
      subject: { type: 'customer', id: row.id },
      data: { name: row.name, domain: row.domain },
    });
    return row;
  }

  async update(workspaceId: string, actor: ActorRef, id: string, patch: CustomerInput) {
    const row = await this.get(workspaceId, id);
    const fields: string[] = [];
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw new BadRequestException('name is required');
      if (name !== row.name) {
        row.name = name;
        fields.push('name');
      }
    }
    let domains: string[] | undefined;
    if (patch.domains !== undefined) domains = this.domainList(patch.domains);
    else if (patch.domain !== undefined) {
      const [primary] = this.domainList([patch.domain]);
      domains = [primary, ...row.domains.filter((d) => d !== primary)];
    }
    if (domains && JSON.stringify(domains) !== JSON.stringify(row.domains)) {
      row.domains = domains;
      row.domain = domains[0];
      fields.push('domains');
    }
    if (patch.logoUrl !== undefined) {
      const logoUrl = patch.logoUrl ? this.logo(patch.logoUrl) : null;
      if (logoUrl !== row.logoUrl) {
        row.logoUrl = logoUrl;
        fields.push('logoUrl');
      }
    }
    if (patch.revenue !== undefined) {
      const revenue = patch.revenue === null ? null : wholeNumber('revenue', patch.revenue, CUSTOMER_REVENUE_MAX);
      if (revenue !== row.revenue) {
        row.revenue = revenue;
        fields.push('revenue');
      }
    }
    if (patch.size !== undefined) {
      const size = patch.size === null ? null : wholeNumber('size', patch.size, CUSTOMER_SIZE_MAX);
      if (size !== row.size) {
        row.size = size;
        fields.push('size');
      }
    }
    if (patch.tierId !== undefined) {
      const tierId = patch.tierId ? await this.tier(workspaceId, patch.tierId) : null;
      if (tierId !== row.tierId) {
        row.tierId = tierId;
        fields.push('tierId');
      }
    }
    if (patch.status !== undefined && patch.status !== row.status) {
      row.status = this.status(patch.status);
      fields.push('status');
    }
    if (patch.archived === true && !row.archivedAt) {
      row.archivedAt = new Date();
      fields.push('archived');
    } else if (patch.archived === false && row.archivedAt) {
      row.archivedAt = null;
      fields.push('archived');
    }
    if (!fields.length) return row;
    row.updatedAt = new Date();
    await this.saveWithDomainCheck(workspaceId, row);
    const type = fields.length === 1 && fields[0] === 'archived'
      ? row.archivedAt ? 'customer.archived' : 'customer.restored'
      : 'customer.updated';
    await this.events.record({
      workspaceId,
      actor,
      type,
      subject: { type: 'customer', id: row.id },
      data: { name: row.name, domain: row.domain, fields },
    });
    return row;
  }

  /** Removes the customer and its requests. Issues and projects stay. */
  async remove(workspaceId: string, actor: ActorRef, id: string) {
    const row = await this.get(workspaceId, id);
    await this.customers.delete({ id: row.id });
    await this.events.record({
      workspaceId,
      actor,
      type: 'customer.deleted',
      subject: { type: 'customer', id: row.id },
      data: { name: row.name, domain: row.domain },
    });
  }

  async requestsFor(workspaceId: string, customerId: string): Promise<CustomerRequestView[]> {
    await this.get(workspaceId, customerId);
    return this.listRequests(workspaceId, { customerId });
  }

  /** Requests of the workspace, newest first. Every filter narrows; none returns all. */
  async listRequests(workspaceId: string, f: CustomerRequestFilter = {}): Promise<CustomerRequestView[]> {
    const where: Record<string, unknown> = { workspaceId };
    if (f.customerId) where['customerId'] = f.customerId;
    if (f.issueId) where['issueId'] = f.issueId;
    if (f.projectId) where['projectId'] = f.projectId;
    if (f.important !== undefined) where['important'] = f.important;
    const rows = await this.requests.find({ where, order: { createdAt: 'DESC', id: 'ASC' } });
    return this.withTargets(workspaceId, rows);
  }

  async createRequest(workspaceId: string, actor: ActorRef, customerId: string, input: CustomerRequestInput) {
    const customer = await this.get(workspaceId, customerId);
    if (!input.issueId === !input.projectId) {
      throw new BadRequestException('Send exactly one of issueId or projectId');
    }
    let issue: IssueEntity | null = null;
    let project: ProjectEntity | null = null;
    if (input.issueId) {
      issue = await this.ds.getRepository(IssueEntity).findOneBy({ workspaceId, id: input.issueId });
      if (!issue) throw notFound('Issue', input.issueId);
    } else if (input.projectId) {
      project = await this.ds.getRepository(ProjectEntity).findOneBy({ workspaceId, id: input.projectId });
      if (!project) throw notFound('Project', input.projectId);
    }
    const now = new Date();
    const row = this.requests.create({
      id: uid('crq'),
      workspaceId,
      customerId,
      issueId: issue?.id ?? null,
      projectId: project?.id ?? null,
      body: this.requestBody(input.body),
      important: input.important === true,
      sourceUrl: this.sourceUrl(input.sourceUrl),
      source: input.source ?? null,
      externalId: input.externalId ?? null,
      requesterEmail: input.requesterEmail ?? null,
      requesterName: input.requesterName ?? null,
      createdBy: actor,
      createdAt: now,
      updatedAt: now,
    });
    await this.requests.save(row);
    await this.events.record({
      workspaceId,
      actor,
      type: 'customer_request.linked',
      subject: { type: 'customer_request', id: row.id },
      data: {
        customerId,
        customer: customer.name,
        important: row.important,
        ...(row.body ? { excerpt: row.body.slice(0, 200) } : {}),
        ...(issue ? { issueId: issue.id, issueKey: issue.key } : {}),
        ...(project ? { projectId: project.id, project: project.name } : {}),
      },
    });
    const [view] = await this.withTargets(workspaceId, [row]);
    return view!;
  }

  async updateRequest(
    workspaceId: string,
    actor: ActorRef,
    customerId: string,
    requestId: string,
    patch: CustomerRequestPatch,
  ) {
    await this.get(workspaceId, customerId);
    const row = await this.requests.findOneBy({ workspaceId, customerId, id: requestId });
    if (!row) throw notFound('Customer request', requestId);
    const fields: string[] = [];
    if (patch.body !== undefined) {
      const body = this.requestBody(patch.body);
      if (body !== row.body) {
        row.body = body;
        fields.push('body');
      }
    }
    if (patch.important !== undefined && patch.important !== row.important) {
      row.important = patch.important;
      fields.push('important');
    }
    if (patch.sourceUrl !== undefined) {
      const sourceUrl = this.sourceUrl(patch.sourceUrl);
      if (sourceUrl !== row.sourceUrl) {
        row.sourceUrl = sourceUrl;
        fields.push('sourceUrl');
      }
    }
    if (fields.length) {
      row.updatedAt = new Date();
      await this.requests.save(row);
      await this.events.record({
        workspaceId,
        actor,
        type: 'customer_request.updated',
        subject: { type: 'customer_request', id: row.id },
        data: { customerId, issueId: row.issueId, projectId: row.projectId, fields, important: row.important },
      });
    }
    const [view] = await this.withTargets(workspaceId, [row]);
    return view!;
  }

  async removeRequest(workspaceId: string, actor: ActorRef, customerId: string, requestId: string) {
    await this.get(workspaceId, customerId);
    const row = await this.requests.findOneBy({ workspaceId, customerId, id: requestId });
    if (!row) throw notFound('Customer request', requestId);
    await this.requests.delete({ id: row.id });
    await this.events.record({
      workspaceId,
      actor,
      type: 'customer_request.unlinked',
      subject: { type: 'customer_request', id: row.id },
      data: { customerId, issueId: row.issueId, projectId: row.projectId },
    });
  }

  /** Sets `customerCount` (including 0) on issue rows about to be serialized. */
  async attachCounts(workspaceId: string, issues: { id: string; customerCount?: number }[]) {
    if (!issues.length) return issues;
    const rows = await this.ds.query<{ id: string; n: number }[]>(
      `SELECT "issueId" AS id, COUNT(DISTINCT "customerId")::int AS n
       FROM customer_requests
       WHERE "workspaceId" = $1 AND "issueId" = ANY($2)
       GROUP BY "issueId"`,
      [workspaceId, issues.map((i) => i.id)],
    );
    const counts = new Map(rows.map((r) => [r.id, Number(r.n)]));
    for (const issue of issues) issue.customerCount = counts.get(issue.id) ?? 0;
    return issues;
  }

  /** Sets `customerCount` (including 0) on project rows about to be serialized: its own requests plus those on its issues. */
  async attachProjectCounts(workspaceId: string, projects: { id: string; customerCount?: number }[]) {
    if (!projects.length) return projects;
    const rows = await this.ds.query<{ id: string; n: number }[]>(
      `SELECT p.id AS id,
              (SELECT COUNT(DISTINCT cr."customerId") FROM customer_requests cr WHERE ${demandScope('p', 'projectId')})::int AS n
       FROM projects p
       WHERE p."workspaceId" = $1 AND p.id = ANY($2)`,
      [workspaceId, projects.map((p) => p.id)],
    );
    const counts = new Map(rows.map((r) => [r.id, Number(r.n)]));
    for (const project of projects) project.customerCount = counts.get(project.id) ?? 0;
    return projects;
  }

  // ───────────────────────────── validation ─────────────────────────────

  private domainList(inputs: readonly string[]): string[] {
    const { domains, invalid } = normalizeCustomerDomains(inputs);
    if (invalid.length) throw new BadRequestException(`"${invalid[0]}" is not a domain; use a hostname like acme.com`);
    if (!domains.length) throw new BadRequestException('At least one domain is required');
    if (domains.length > CUSTOMER_DOMAINS_MAX) {
      throw new BadRequestException(`A customer can have at most ${CUSTOMER_DOMAINS_MAX} domains`);
    }
    return domains;
  }

  private logo(input: string): string {
    const url = normalizeHttpUrl(input);
    if (!url) throw new BadRequestException('logoUrl must be an http(s) URL');
    return url;
  }

  private sourceUrl(input: string | null | undefined): string | null {
    if (input === undefined || input === null || !input.trim()) return null;
    const url = normalizeHttpUrl(input);
    if (!url) throw new BadRequestException('sourceUrl must be an http(s) URL');
    return url;
  }

  private requestBody(input: string | null | undefined): string | null {
    const body = input?.trim();
    if (!body) return null;
    if (body.length > CUSTOMER_REQUEST_BODY_MAX) {
      throw new BadRequestException(`body must be at most ${CUSTOMER_REQUEST_BODY_MAX} characters`);
    }
    return body;
  }

  private status(input: string): CustomerStatus {
    if (!CUSTOMER_STATUSES.includes(input as CustomerStatus)) {
      throw new BadRequestException(`status must be one of ${CUSTOMER_STATUSES.join(', ')}`);
    }
    return input as CustomerStatus;
  }

  /** The tier id when it belongs to this workspace's configured tiers. */
  private async tier(workspaceId: string, tierId: string): Promise<string> {
    const ws = await this.ds.getRepository(WorkspaceEntity).findOneBy({ id: workspaceId });
    if (!resolveCustomerTiers(ws?.settings?.customerTiers).some((t) => t.id === tierId)) {
      throw new BadRequestException(`Unknown customer tier "${tierId}"`);
    }
    return tierId;
  }

  /**
   * Saves the customer after checking that none of its domains belongs to another customer of the workspace.
   * Runs under a per-workspace advisory lock so two concurrent writes cannot both claim a domain.
   */
  private async saveWithDomainCheck(workspaceId: string, row: CustomerEntity): Promise<void> {
    await this.ds.transaction(async (m) => {
      await m.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`customer-domains:${workspaceId}`]);
      const clash = await m.query<{ domain: string }[]>(
        `SELECT d AS domain
         FROM customers c, jsonb_array_elements_text(c."domains") d
         WHERE c."workspaceId" = $1 AND c."id" <> $2 AND d = ANY($3::text[])
         LIMIT 1`,
        [workspaceId, row.id, row.domains],
      );
      if (clash.length) throw new ConflictException(`A customer with domain "${clash[0]!.domain}" already exists`);
      await m.getRepository(CustomerEntity).save(row);
    });
  }

  private async withTargets(workspaceId: string, rows: CustomerRequestEntity[]): Promise<CustomerRequestView[]> {
    if (!rows.length) return [];
    const issueIds = [...new Set(rows.flatMap((r) => (r.issueId ? [r.issueId] : [])))];
    const projectIds = [...new Set(rows.flatMap((r) => (r.projectId ? [r.projectId] : [])))];
    const issues = issueIds.length
      ? await this.ds.getRepository(IssueEntity).findBy({ workspaceId, id: In(issueIds) })
      : [];
    const projects = projectIds.length
      ? await this.ds.getRepository(ProjectEntity).findBy({ workspaceId, id: In(projectIds) })
      : [];
    const issueById = new Map(issues.map((i) => [i.id, i]));
    const projectById = new Map(projects.map((p) => [p.id, p]));
    return rows.flatMap((row) => {
      const issue = row.issueId ? issueById.get(row.issueId) : undefined;
      const project = row.projectId ? projectById.get(row.projectId) : undefined;
      if (!issue && !project) return [];
      const json = row.toJSON();
      const view: CustomerRequestView = {
        id: row.id,
        workspaceId: row.workspaceId,
        customerId: row.customerId,
        ...(row.issueId ? { issueId: row.issueId } : {}),
        ...(row.projectId ? { projectId: row.projectId } : {}),
        ...(json['body'] !== undefined ? { body: json['body'] as string } : {}),
        important: row.important,
        ...(json['sourceUrl'] !== undefined ? { sourceUrl: json['sourceUrl'] as string } : {}),
        ...(row.source ? { source: row.source } : {}),
        ...(row.externalId ? { externalId: row.externalId } : {}),
        ...(row.requesterEmail ? { requesterEmail: row.requesterEmail } : {}),
        ...(row.requesterName ? { requesterName: row.requesterName } : {}),
        createdBy: row.createdBy,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        ...(issue ? { issue: { id: issue.id, key: issue.key, title: issue.title, status: issue.status, updatedAt: issue.updatedAt } } : {}),
        ...(project ? { project: { id: project.id, name: project.name, status: project.status, updatedAt: project.updatedAt } } : {}),
      };
      return [view];
    });
  }
}
