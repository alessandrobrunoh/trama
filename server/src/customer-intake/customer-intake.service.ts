import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { type DataSource, type Repository } from 'typeorm';
import {
  CUSTOMER_REQUEST_BODY_MAX,
  INTAKE_PROVIDER_META,
  type ActorRef,
  type IntakeItemStatus,
  type IntakeProvider,
} from '../contracts/domain.js';
import { notFound, uid } from '../common/util.js';
import { CustomerEntity, IssueEntity, ProjectEntity } from '../database/entities/index.js';
import { CustomersService } from '../customers/customers.service.js';
import { SecretsService } from '../integrations/secrets.service.js';
import { IntakeItemEntity, IntakeSourceEntity } from './entities.js';
import { companyDomain, customerNameFromDomain, emailDomain, isFreeMailDomain, matchCustomerByEmail } from './intake-domain.js';
import { IntakePayloadError, parseIntake, sampleDelivery, type InboundRequest } from './intake-parsers.js';
import { signIntakeDelivery, verifyIntakeSignature, type IntakeHeaders } from './intake-signatures.js';

const SYSTEM: ActorRef = { type: 'system' };
const SECRET = (id: string) => `${id}:intake`;
const SUBDOMAIN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export interface ReceiveInput {
  sourceId: string;
  rawBody: Buffer | undefined;
  /** Parsed body: JSON, or the form fields of a Slack slash command. */
  payload: unknown;
  headers: IntakeHeaders;
}

export interface ReceiveResult {
  /** 200 handled / duplicate, 202 accepted but nothing to do. */
  httpStatus: 200 | 202;
  body: Record<string, unknown>;
}

export interface SourceInput {
  provider?: IntakeProvider;
  name?: string;
  enabled?: boolean;
  autoCreateCustomers?: boolean;
  targetProjectId?: string | null;
  subdomain?: string | null;
  /** The provider's own secret (Intercom, Zendesk, Front, Slack). Ignored for sources Trama generates the secret for. */
  secret?: string;
}

export interface LinkInput {
  issueId?: string;
  projectId?: string;
  /** Overrides the customer matched on arrival. */
  customerId?: string;
  /** No customer matched: create one from the sender's email domain. */
  createCustomer?: boolean;
  customerName?: string;
  important?: boolean;
}

interface Outcome {
  customer?: { id: string; name: string; created: boolean };
  /** Dry run only: the customer that would be created. */
  wouldCreate?: { name: string; domain: string };
  target?: { issueId?: string; projectId?: string };
}

@Injectable()
export class CustomerIntakeService {
  private readonly logger = new Logger(CustomerIntakeService.name);

  constructor(
    private readonly ds: DataSource,
    private readonly secrets: SecretsService,
    private readonly customers: CustomersService,
    @InjectRepository(IntakeSourceEntity) private readonly sources: Repository<IntakeSourceEntity>,
    @InjectRepository(IntakeItemEntity) private readonly items: Repository<IntakeItemEntity>,
  ) {}

  // ───────────────────────────── sources (admin) ─────────────────────────────

  static webhookUrl(origin: string, sourceId: string): string {
    return `${origin}/api/webhooks/intake/${sourceId}`;
  }

  present(row: IntakeSourceEntity, origin: string) {
    const json = row.toJSON();
    delete json['config'];
    return {
      ...json,
      hasSecret: !!row.secret,
      ...(row.config?.subdomain ? { subdomain: row.config.subdomain } : {}),
      webhookUrl: CustomerIntakeService.webhookUrl(origin, row.id),
    };
  }

  private async getSource(workspaceId: string, id: string): Promise<IntakeSourceEntity> {
    const row = await this.sources.findOneBy({ workspaceId, id });
    if (!row) throw notFound('Source', id);
    return row;
  }

  async listSources(workspaceId: string, origin: string) {
    const rows = await this.sources.find({ where: { workspaceId }, order: { createdAt: 'ASC', id: 'ASC' } });
    return rows.map((r) => this.present(r, origin));
  }

  async getSourcePresented(workspaceId: string, id: string, origin: string) {
    return this.present(await this.getSource(workspaceId, id), origin);
  }

  /** Returns the source and, when Trama generated its secret, that secret once. */
  async createSource(workspaceId: string, actor: ActorRef, input: SourceInput & { provider: IntakeProvider; name: string }, origin: string) {
    const meta = INTAKE_PROVIDER_META[input.provider];
    if (!meta) throw new BadRequestException('Unknown provider');
    const name = this.name(input.name);
    const id = uid('isrc');
    const generated = meta.generatesSecret ? SecretsService.generateWebhookSecret() : undefined;
    const provided = !meta.generatesSecret && input.secret?.trim() ? input.secret.trim() : undefined;
    const secret = generated ?? provided;
    const row = this.sources.create({
      id,
      workspaceId,
      provider: input.provider,
      name,
      secret: secret ? this.secrets.encrypt(secret, SECRET(id)) : null,
      enabled: input.enabled ?? true,
      autoCreateCustomers: input.autoCreateCustomers ?? true,
      targetProjectId: input.targetProjectId ? await this.project(workspaceId, input.targetProjectId) : null,
      config: this.config(input.provider, input.subdomain),
      lastReceivedAt: null,
      createdBy: actor,
    });
    await this.sources.save(row);
    return { source: this.present(row, origin), ...(generated ? { secret: generated } : {}) };
  }

  async updateSource(workspaceId: string, id: string, patch: SourceInput, origin: string) {
    const row = await this.getSource(workspaceId, id);
    if (patch.name !== undefined) row.name = this.name(patch.name);
    if (patch.enabled !== undefined) row.enabled = patch.enabled;
    if (patch.autoCreateCustomers !== undefined) row.autoCreateCustomers = patch.autoCreateCustomers;
    if (patch.targetProjectId !== undefined) {
      row.targetProjectId = patch.targetProjectId ? await this.project(workspaceId, patch.targetProjectId) : null;
    }
    if (patch.subdomain !== undefined) row.config = this.config(row.provider, patch.subdomain);
    if (patch.secret !== undefined) {
      if (INTAKE_PROVIDER_META[row.provider].generatesSecret)
        throw new BadRequestException('Trama generates the secret of this source: use rotate-secret');
      const secret = patch.secret.trim();
      if (!secret) throw new BadRequestException('secret must not be empty');
      row.secret = this.secrets.encrypt(secret, SECRET(row.id));
    }
    row.updatedAt = new Date();
    await this.sources.save(row);
    return this.present(row, origin);
  }

  async rotateSecret(workspaceId: string, id: string, origin: string) {
    const row = await this.getSource(workspaceId, id);
    if (!INTAKE_PROVIDER_META[row.provider].generatesSecret)
      throw new BadRequestException(`${INTAKE_PROVIDER_META[row.provider].label} issues its own secret: paste the new one with PATCH`);
    const secret = SecretsService.generateWebhookSecret();
    row.secret = this.secrets.encrypt(secret, SECRET(row.id));
    row.updatedAt = new Date();
    await this.sources.save(row);
    return { source: this.present(row, origin), secret };
  }

  async removeSource(workspaceId: string, id: string) {
    const row = await this.getSource(workspaceId, id);
    await this.sources.delete({ id: row.id });
  }

  /**
   * Runs a sample delivery of the source's provider through the real pipeline (signature included, signed with the
   * stored secret) without saving anything, and reports what would have happened.
   */
  async testSource(workspaceId: string, id: string) {
    const row = await this.getSource(workspaceId, id);
    if (!row.secret) throw new BadRequestException('Add the provider secret first: there is nothing to sign the test with');
    const secret = this.secrets.decrypt(row.secret, SECRET(row.id));
    const sample = sampleDelivery(row.provider);
    const rawBody = Buffer.from(sample.body);
    const headers: IntakeHeaders = { 'content-type': sample.contentType, ...signIntakeDelivery(row.provider, secret, rawBody) };
    const payload =
      sample.contentType === 'application/json' ? (JSON.parse(sample.body) as unknown) : Object.fromEntries(new URLSearchParams(sample.body));
    const result = await this.handle(row, { sourceId: id, rawBody, payload, headers }, true);
    return { ok: result.httpStatus === 200, dryRun: true, ...result.body };
  }

  // ───────────────────────────── inbound (public) ─────────────────────────────

  /** A provider delivery. Authenticity is the signature of the source's secret; the workspace is the source's, never the payload's. */
  async receive(input: ReceiveInput): Promise<ReceiveResult> {
    const source = await this.sources.findOneBy({ id: input.sourceId });
    if (!source) throw new NotFoundException('Unknown webhook endpoint');
    return this.handle(source, input, false);
  }

  private async handle(source: IntakeSourceEntity, input: ReceiveInput, dryRun: boolean): Promise<ReceiveResult> {
    if (!source.secret) throw new UnauthorizedException('Webhook secret not configured');
    let secret: string;
    try {
      secret = this.secrets.decrypt(source.secret, SECRET(source.id));
    } catch {
      this.logger.error(`Cannot decrypt the secret of intake source ${source.id} (TRAMA_ENCRYPTION_KEY changed?)`);
      throw new UnauthorizedException('Webhook secret unavailable');
    }
    if (!input.rawBody || !verifyIntakeSignature(source.provider, secret, { rawBody: input.rawBody, headers: input.headers })) {
      throw new UnauthorizedException('Invalid webhook signature');
    }
    if (!source.enabled) return this.reply(source, 202, { status: 'ignored', reason: 'source is disabled' }, 'This source is turned off in Trama.');

    let parsed;
    try {
      parsed = parseIntake(source.provider, input.payload, { subdomain: source.config?.subdomain });
    } catch (e) {
      if (e instanceof IntakePayloadError) throw new BadRequestException(`Malformed webhook payload: ${e.message}`);
      throw e;
    }
    if (parsed.kind === 'ping') return { httpStatus: 200, body: parsed.response ?? { status: 'pong' } };
    if (parsed.kind === 'ignored') return { httpStatus: 202, body: { status: 'ignored', reason: parsed.reason } };

    const request = parsed.request;
    const existing = await this.items.findOneBy({ sourceId: source.id, externalId: request.externalId });
    if (existing) return this.reply(source, 200, { status: 'duplicate', itemId: existing.id }, 'Already recorded.');

    const issue = request.issueKey ? await this.issueByKey(source.workspaceId, request.issueKey) : null;
    const outcome = await this.resolve(source, request, dryRun);
    if (dryRun) {
      return {
        httpStatus: 200,
        body: {
          status: 'processed',
          request,
          ...outcome,
          target: issue ? { issueId: issue.id, issueKey: issue.key } : source.targetProjectId ? { projectId: source.targetProjectId } : undefined,
          inbox: !(outcome.customer && (issue || source.targetProjectId)),
        },
      };
    }

    const itemId = uid('cin');
    const inserted = await this.ds
      .createQueryBuilder()
      .insert()
      .into(IntakeItemEntity)
      .values({
        id: itemId,
        workspaceId: source.workspaceId,
        sourceId: source.id,
        provider: source.provider,
        externalId: request.externalId,
        externalUrl: request.externalUrl ?? null,
        requesterEmail: request.requesterEmail ?? null,
        requesterName: request.requesterName ?? null,
        subject: request.subject ?? null,
        body: request.body,
        status: 'pending',
        customerId: outcome.customer?.id ?? null,
      })
      .orIgnore()
      .returning('id')
      .execute();
    if (!(inserted.raw as unknown[]).length) return this.reply(source, 200, { status: 'duplicate' }, 'Already recorded.');
    void this.touch(source);

    const item = (await this.items.findOneBy({ id: itemId }))!;
    const target = issue ? { issueId: issue.id } : source.targetProjectId ? { projectId: source.targetProjectId } : null;
    if (outcome.customer && target) {
      try {
        await this.attach(item, outcome.customer.id, SYSTEM, target);
        return this.reply(source, 200, { status: 'processed', itemId, linked: true, customerId: outcome.customer.id }, 'Recorded.');
      } catch (e) {
        // the target vanished meanwhile: the request stays in the inbox instead of being lost
        this.logger.warn(`Auto-linking intake item ${itemId} failed: ${(e as Error).message}`);
      }
    }
    return this.reply(source, 200, { status: 'processed', itemId, linked: false, ...(outcome.customer ? { customerId: outcome.customer.id } : {}) }, 'Recorded in the Trama inbox.');
  }

  private reply(source: IntakeSourceEntity, httpStatus: 200 | 202, body: Record<string, unknown>, message: string): ReceiveResult {
    // Slack shows whatever JSON `text` it gets back to the person who typed the command
    return source.provider === 'slack' ? { httpStatus, body: { response_type: 'ephemeral', text: message } } : { httpStatus, body };
  }

  private async touch(source: IntakeSourceEntity) {
    try {
      await this.sources.update({ id: source.id }, { lastReceivedAt: new Date() });
    } catch (e) {
      this.logger.warn(`lastReceivedAt update failed: ${(e as Error).message}`);
    }
  }

  /**
   * Finds the customer owning the sender's domain; creates it when the source allows and the domain is a company's
   * (never a mailbox provider's). Dry runs create nothing.
   */
  private async resolve(source: IntakeSourceEntity, request: InboundRequest, dryRun: boolean): Promise<Outcome> {
    const domain = emailDomain(request.requesterEmail);
    if (!domain || isFreeMailDomain(domain)) return {};
    const find = async () => matchCustomerByEmail(await this.customers.list(source.workspaceId, { archived: 'all' }), request.requesterEmail);
    const found = await find();
    if (found) return { customer: { id: found.id, name: found.name, created: false } };
    if (!source.autoCreateCustomers) return {};
    const own = companyDomain(domain);
    const name = customerNameFromDomain(domain);
    if (dryRun) return { wouldCreate: { name, domain: own } };
    try {
      const created = await this.customers.create(source.workspaceId, SYSTEM, { name, domains: [own], status: 'prospect' });
      return { customer: { id: created.id, name: created.name, created: true } };
    } catch (e) {
      if (!(e instanceof ConflictException)) throw e;
      const raced = await find(); // another delivery created it first
      return raced ? { customer: { id: raced.id, name: raced.name, created: false } } : {};
    }
  }

  private async issueByKey(workspaceId: string, key: string): Promise<IssueEntity | null> {
    const upper = key.toUpperCase();
    return (
      (await this.ds.getRepository(IssueEntity).findOneBy({ workspaceId, key: upper })) ??
      (await this.ds
        .getRepository(IssueEntity)
        .createQueryBuilder('i')
        .where('i.workspaceId = :workspaceId', { workspaceId })
        .andWhere('i.aliases @> :a::jsonb', { a: JSON.stringify([upper]) })
        .getOne())
    );
  }

  // ───────────────────────────── triage inbox ─────────────────────────────

  async listItems(workspaceId: string, f: { status?: IntakeItemStatus | 'all'; limit?: number } = {}) {
    const where: Record<string, unknown> = { workspaceId };
    const status = f.status ?? 'pending';
    if (status !== 'all') where['status'] = status;
    const rows = await this.items.find({ where, order: { receivedAt: 'DESC', id: 'ASC' }, take: Math.min(Math.max(f.limit ?? 200, 1), 500) });
    return rows;
  }

  async pendingCount(workspaceId: string): Promise<number> {
    return this.items.countBy({ workspaceId, status: 'pending' });
  }

  async link(workspaceId: string, actor: ActorRef, id: string, input: LinkInput) {
    const item = await this.items.findOneBy({ workspaceId, id });
    if (!item) throw notFound('Inbox item', id);
    if (item.status !== 'pending') throw new ConflictException(`This request is already ${item.status}`);
    if (!input.issueId === !input.projectId) throw new BadRequestException('Send exactly one of issueId or projectId');

    let customerId = input.customerId ?? item.customerId ?? undefined;
    if (customerId && !(await this.ds.getRepository(CustomerEntity).existsBy({ workspaceId, id: customerId })))
      throw notFound('Customer', customerId);
    if (!customerId) {
      const domain = emailDomain(item.requesterEmail);
      if (!input.createCustomer || !domain || isFreeMailDomain(domain))
        throw new BadRequestException('Choose the customer this request belongs to');
      const own = companyDomain(domain);
      try {
        const created = await this.customers.create(workspaceId, actor, {
          name: input.customerName?.trim() || customerNameFromDomain(domain),
          domains: [own],
          status: 'prospect',
        });
        customerId = created.id;
      } catch (e) {
        if (!(e instanceof ConflictException)) throw e;
        const match = matchCustomerByEmail(await this.customers.list(workspaceId, { archived: 'all' }), item.requesterEmail);
        if (!match) throw e;
        customerId = match.id;
      }
    }
    return this.attach(item, customerId, actor, { issueId: input.issueId, projectId: input.projectId }, input.important);
  }

  async dismiss(workspaceId: string, id: string) {
    return this.transition(workspaceId, id, 'pending', 'dismissed');
  }

  async restore(workspaceId: string, id: string) {
    return this.transition(workspaceId, id, 'dismissed', 'pending');
  }

  private async transition(workspaceId: string, id: string, from: IntakeItemStatus, to: IntakeItemStatus) {
    const item = await this.items.findOneBy({ workspaceId, id });
    if (!item) throw notFound('Inbox item', id);
    const res = await this.items.update({ id, workspaceId, status: from }, { status: to, resolvedAt: to === 'pending' ? null : new Date() });
    if (!res.affected) throw new ConflictException(`This request is ${item.status}, not ${from}`);
    return (await this.items.findOneBy({ id }))!;
  }

  /**
   * Turns a pending item into a customer request on an issue or project. The item is claimed first, so two
   * people (or a person and an auto-link) cannot both create a request from it; a failure releases the claim.
   */
  private async attach(
    item: IntakeItemEntity,
    customerId: string,
    actor: ActorRef,
    target: { issueId?: string | undefined; projectId?: string | undefined },
    important = false,
  ) {
    const claimed = await this.items.update({ id: item.id, status: 'pending' }, { status: 'linked', resolvedAt: new Date() });
    if (!claimed.affected) throw new ConflictException('This request is already handled');
    try {
      const request = await this.customers.createRequest(item.workspaceId, actor, customerId, {
        ...(target.issueId ? { issueId: target.issueId } : { projectId: target.projectId! }),
        body: this.requestBody(item),
        important,
        sourceUrl: item.externalUrl,
        source: item.provider,
        externalId: item.externalId,
        ...(item.requesterEmail ? { requesterEmail: item.requesterEmail } : {}),
        ...(item.requesterName ? { requesterName: item.requesterName } : {}),
      });
      await this.items.update(
        { id: item.id },
        { customerId, issueId: target.issueId ?? null, projectId: target.projectId ?? null, customerRequestId: request.id },
      );
      return (await this.items.findOneBy({ id: item.id }))!;
    } catch (e) {
      await this.items.update({ id: item.id }, { status: 'pending', resolvedAt: null });
      throw e;
    }
  }

  private requestBody(item: IntakeItemEntity): string {
    const text = item.subject && item.subject !== item.body ? `**${item.subject}**\n\n${item.body}` : item.body;
    return text.length > CUSTOMER_REQUEST_BODY_MAX ? text.slice(0, CUSTOMER_REQUEST_BODY_MAX) : text;
  }

  // ───────────────────────────── validation ─────────────────────────────

  private name(input: string): string {
    const name = input.trim();
    if (!name) throw new BadRequestException('name is required');
    return name;
  }

  private config(provider: IntakeProvider, subdomain: string | null | undefined): { subdomain?: string } {
    const value = subdomain?.trim().toLowerCase();
    if (!value) return {};
    if (provider !== 'zendesk') throw new BadRequestException('subdomain only applies to Zendesk sources');
    if (!SUBDOMAIN.test(value)) throw new BadRequestException('subdomain must be the part before .zendesk.com');
    return { subdomain: value };
  }

  private async project(workspaceId: string, projectId: string): Promise<string> {
    const project = await this.ds.getRepository(ProjectEntity).findOneBy({ workspaceId, id: projectId });
    if (!project) throw notFound('Project', projectId);
    return project.id;
  }
}
