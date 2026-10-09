import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, QueryFailedError, type Repository } from 'typeorm';
import type { ActorRef } from '../contracts/domain.js';
import { normalizeCustomerDomain } from '../contracts/domain.js';
import { notFound, uid } from '../common/util.js';
import {
  CustomerEntity,
  CustomerRequestEntity,
  IssueEntity,
} from '../database/entities/index.js';
import { EventsService } from '../events/events.service.js';

export interface CustomerInput {
  name?: string;
  /** Raw domain; stored normalized. */
  domain?: string;
  /** `true` archives, `false` restores. Links stay either way. */
  archived?: boolean;
}

export interface CustomerFilter {
  /** `true` only archived, `all` both, otherwise only active. */
  archived?: 'true' | 'false' | 'all';
  /** Only customers linked to this issue. */
  issueId?: string;
  q?: string;
}

export interface CustomerRequestView {
  id: string;
  workspaceId: string;
  customerId: string;
  issueId: string;
  body?: string;
  createdBy: ActorRef;
  createdAt: Date;
  issue: { id: string; key: string; title: string; status: string; updatedAt: Date };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof QueryFailedError && (error.driverError as { code?: string } | undefined)?.code === '23505';
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
    if (f.q) qb.andWhere('(c.name ILIKE :q OR c.domain ILIKE :q)', { q: `%${f.q}%` });
    return qb.getMany();
  }

  async get(workspaceId: string, id: string) {
    const row = await this.customers.findOneBy({ workspaceId, id });
    if (!row) throw notFound('Customer', id);
    return row;
  }

  async create(workspaceId: string, actor: ActorRef, input: { name: string; domain: string }) {
    const name = input.name.trim();
    const domain = this.domain(input.domain);
    const row = this.customers.create({
      id: uid('cus'),
      workspaceId,
      name,
      domain,
      createdBy: actor,
      archivedAt: null,
    });
    try {
      await this.customers.save(row);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException(`A customer with domain "${domain}" already exists`);
      throw error;
    }
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
    if (patch.domain !== undefined) {
      const domain = this.domain(patch.domain);
      if (domain !== row.domain) {
        row.domain = domain;
        fields.push('domain');
      }
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
    try {
      await this.customers.save(row);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException(`A customer with domain "${row.domain}" already exists`);
      throw error;
    }
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

  /** Removes the customer and its links. Issues stay. */
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
    const links = await this.requests.find({
      where: { workspaceId, customerId },
      order: { createdAt: 'DESC', id: 'ASC' },
    });
    return this.withIssues(workspaceId, links);
  }

  /** Customers linked to an issue, oldest link first. */
  async customersForIssue(workspaceId: string, issueId: string) {
    const issue = await this.ds.getRepository(IssueEntity).findOneBy({ workspaceId, id: issueId });
    if (!issue) throw notFound('Issue', issueId);
    const links = await this.requests.find({
      where: { workspaceId, issueId },
      order: { createdAt: 'ASC', id: 'ASC' },
    });
    if (!links.length) return [];
    const customers = await this.customers.findBy({ workspaceId, id: In(links.map((l) => l.customerId)) });
    const byId = new Map(customers.map((c) => [c.id, c]));
    return links.flatMap((link) => {
      const customer = byId.get(link.customerId);
      return customer ? [{ request: link, customer }] : [];
    });
  }

  async link(
    workspaceId: string,
    actor: ActorRef,
    customerId: string,
    input: { issueId: string; body?: string | null },
  ) {
    const customer = await this.get(workspaceId, customerId);
    const issue = await this.ds.getRepository(IssueEntity).findOneBy({ workspaceId, id: input.issueId });
    if (!issue) throw notFound('Issue', input.issueId);
    const existing = await this.requests.findOneBy({ workspaceId, customerId, issueId: issue.id });
    if (existing) throw new ConflictException(`${customer.name} is already linked to ${issue.key}`);
    const body = input.body?.trim() || null;
    const row = this.requests.create({
      id: uid('crq'),
      workspaceId,
      customerId,
      issueId: issue.id,
      body,
      createdBy: actor,
    });
    try {
      await this.requests.save(row);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException(`${customer.name} is already linked to ${issue.key}`);
      throw error;
    }
    await this.events.record({
      workspaceId,
      actor,
      type: 'customer_request.linked',
      subject: { type: 'customer_request', id: row.id },
      data: { customerId, issueId: issue.id, issueKey: issue.key, customer: customer.name },
    });
    const [view] = await this.withIssues(workspaceId, [row]);
    return view!;
  }

  async unlink(workspaceId: string, actor: ActorRef, customerId: string, requestId: string) {
    await this.get(workspaceId, customerId);
    const row = await this.requests.findOneBy({ workspaceId, customerId, id: requestId });
    if (!row) throw notFound('Customer request', requestId);
    await this.requests.delete({ id: row.id });
    await this.events.record({
      workspaceId,
      actor,
      type: 'customer_request.unlinked',
      subject: { type: 'customer_request', id: row.id },
      data: { customerId, issueId: row.issueId },
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

  private domain(input: string): string {
    const domain = normalizeCustomerDomain(input);
    if (!domain) throw new BadRequestException('domain must be a hostname like acme.com');
    return domain;
  }

  private async withIssues(workspaceId: string, links: CustomerRequestEntity[]): Promise<CustomerRequestView[]> {
    if (!links.length) return [];
    const issues = await this.ds.getRepository(IssueEntity).findBy({
      workspaceId,
      id: In(links.map((l) => l.issueId)),
    });
    const byId = new Map(issues.map((i) => [i.id, i]));
    return links.flatMap((link) => {
      const issue = byId.get(link.issueId);
      if (!issue) return [];
      const json = link.toJSON();
      return [{
        id: link.id,
        workspaceId: link.workspaceId,
        customerId: link.customerId,
        issueId: link.issueId,
        ...(json['body'] !== undefined ? { body: json['body'] as string } : {}),
        createdBy: link.createdBy,
        createdAt: link.createdAt,
        issue: {
          id: issue.id,
          key: issue.key,
          title: issue.title,
          status: issue.status,
          updatedAt: issue.updatedAt,
        },
      }];
    });
  }
}
