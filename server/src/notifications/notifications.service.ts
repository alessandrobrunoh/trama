import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DataSource, In, IsNull, LessThan, MoreThan } from 'typeorm';
import { appUrl } from '../common/app-url.js';
import { uid } from '../common/util.js';
import {
  NOTIFICATION_KINDS,
  resolveNotificationSettings,
  type ActorRef,
  type NotificationChannels,
  type NotificationKind,
  type NotificationSettings,
} from '../contracts/domain.js';
import {
  AgentEntity,
  DecisionEntity,
  DomainEventEntity,
  IssueEntity,
  MembershipEntity,
  NotificationEntity,
  TeamEntity,
  UserEntity,
  WorkspaceEntity,
  WorkstreamEntity,
} from '../database/entities/index.js';
import { EventsService } from '../events/events.service.js';
import { MailService } from '../mail/mail.service.js';
import { PushService } from './push.service.js';
import { planNotifications, type NotificationDraft, type RuleContext } from './notification-rules.js';

const DEDUPE_WINDOW_MS = 60_000;
const KEEP_READ_FOR_MS = 90 * 24 * 60 * 60 * 1000;

@Injectable()
export class NotificationsService implements OnModuleInit {
  private readonly log = new Logger(NotificationsService.name);

  constructor(
    private readonly ds: DataSource,
    private readonly events: EventsService,
    private readonly mail: MailService,
    private readonly push: PushService,
  ) {}

  onModuleInit(): void {
    this.events.recorded$.subscribe((event) => {
      void this.handle(event).catch((e: unknown) =>
        this.log.warn(`Could not notify about ${event.type}: ${e instanceof Error ? e.message : String(e)}`),
      );
    });
  }

  // ───────────── reading ─────────────

  async list(workspaceId: string, userId: string, opts: { limit?: number; unreadOnly?: boolean } = {}) {
    const repo = this.ds.getRepository(NotificationEntity);
    const items = await repo.find({
      where: { workspaceId, userId, ...(opts.unreadOnly ? { readAt: IsNull() } : {}) },
      order: { createdAt: 'DESC', id: 'DESC' },
      take: Math.min(Math.max(opts.limit ?? 50, 1), 200),
    });
    const unread = await repo.countBy({ workspaceId, userId, readAt: IsNull() });
    return { items, unread };
  }

  /** Mark some (or, without ids, all) of the caller's notifications in this workspace as read. */
  async markRead(workspaceId: string, userId: string, ids?: string[]): Promise<{ unread: number }> {
    const repo = this.ds.getRepository(NotificationEntity);
    await repo.update(
      { workspaceId, userId, readAt: IsNull(), ...(ids ? { id: In(ids) } : {}) },
      { readAt: new Date() },
    );
    this.events.publish(workspaceId, { type: 'updated', entity: 'notification', id: 'read' }, userId);
    return { unread: await repo.countBy({ workspaceId, userId, readAt: IsNull() }) };
  }

  // ───────────── settings ─────────────

  async getSettings(userId: string): Promise<{ settings: NotificationSettings; emailAvailable: boolean }> {
    const user = await this.ds.getRepository(UserEntity).findOneByOrFail({ id: userId });
    return { settings: resolveNotificationSettings(user.notificationSettings), emailAvailable: this.mail.enabled };
  }

  async updateSettings(
    userId: string,
    patch: Partial<Record<NotificationKind, Partial<NotificationChannels>>>,
  ): Promise<{ settings: NotificationSettings; emailAvailable: boolean }> {
    const repo = this.ds.getRepository(UserEntity);
    const user = await repo.findOneByOrFail({ id: userId });
    const next = resolveNotificationSettings(user.notificationSettings);
    for (const kind of NOTIFICATION_KINDS) next[kind] = { ...next[kind], ...(patch[kind] ?? {}) };
    user.notificationSettings = next;
    await repo.save(user);
    return { settings: next, emailAvailable: this.mail.enabled };
  }

  // ───────────── producing ─────────────

  private async handle(event: DomainEventEntity): Promise<void> {
    const ctx = await this.context(event);
    if (!ctx) return;
    const drafts = planNotifications(ctx);
    if (!drafts.length) return;
    const workspace = await this.ds.getRepository(WorkspaceEntity).findOneBy({ id: event.workspaceId });
    if (!workspace) return;
    for (const draft of drafts) await this.deliver(workspace, event.actor, draft);
  }

  /** Loads the records an event is about; null when the event cannot produce a notification. */
  private async context(event: DomainEventEntity): Promise<RuleContext | null> {
    const interesting =
      event.type === 'issue.created' ||
      event.type === 'issue.updated' ||
      event.type === 'input.requested' ||
      event.type === 'decision.proposed' ||
      event.type === 'review.requested' ||
      event.type === 'artifact.updated' ||
      event.type === 'comment.created' ||
      event.type === 'workstream.status_changed';
    if (!interesting) return null;
    if (event.type === 'issue.updated' && !(event.data['assignee'] as { to?: unknown } | undefined)?.to) return null;
    if (event.type === 'issue.created' && !event.data['assigneeId']) return null;

    const { workspaceId, subject } = event;
    const rule: RuleContext = { event, actorName: await this.actorName(event.actor) };

    if (subject.type === 'issue') {
      const issue = await this.ds.getRepository(IssueEntity).findOneBy({ workspaceId, id: subject.id });
      if (!issue) return null;
      rule.issue = issue;
    }
    if (subject.type === 'decision') {
      const decision = await this.ds.getRepository(DecisionEntity).findOneBy({ workspaceId, id: subject.id });
      if (!decision) return null;
      rule.decision = decision;
    }
    const workstreamId = event.workstreamId ?? (subject.type === 'workstream' ? subject.id : null);
    if (workstreamId) {
      rule.workstream =
        (await this.ds.getRepository(WorkstreamEntity).findOneBy({ workspaceId, id: workstreamId })) ?? undefined;
    }
    return rule;
  }

  /** Applies the person's settings and membership, stores the notification and emails it if asked. */
  private async deliver(workspace: WorkspaceEntity, actor: ActorRef, draft: NotificationDraft): Promise<void> {
    const user = await this.ds.getRepository(UserEntity).findOneBy({ id: draft.userId });
    if (!user) return;
    if (!(await this.ds.getRepository(MembershipEntity).existsBy({ workspaceId: workspace.id, userId: user.id }))) return;
    const channels = resolveNotificationSettings(user.notificationSettings)[draft.kind];

    if (channels.inApp) {
      const repo = this.ds.getRepository(NotificationEntity);
      const duplicate = await repo.existsBy({
        workspaceId: workspace.id,
        userId: user.id,
        kind: draft.kind,
        title: draft.title,
        createdAt: MoreThan(new Date(Date.now() - DEDUPE_WINDOW_MS)),
      });
      if (!duplicate) {
        const row = await repo.save(
          repo.create({
            id: uid('ntf'),
            workspaceId: workspace.id,
            userId: user.id,
            kind: draft.kind,
            title: draft.title,
            body: draft.body?.slice(0, 500) ?? null,
            actor,
            subject: draft.subject,
            link: draft.link,
            readAt: null,
          }),
        );
        this.events.publish(workspace.id, { type: 'created', entity: 'notification', id: row.id }, user.id);
        void repo.delete({ userId: user.id, readAt: LessThan(new Date(Date.now() - KEEP_READ_FOR_MS)) });
      }
    }

    if (channels.push && this.push.enabled) {
      await this.push
        .send(user.id, {
          title: draft.title,
          body: draft.body?.slice(0, 200),
          path: `/${workspace.slug}/${draft.link}`,
          tag: `${draft.kind}:${draft.subject.id}`,
        })
        .catch((e: unknown) =>
          this.log.warn(`Could not push "${draft.title}": ${e instanceof Error ? e.message : String(e)}`),
        );
    }

    if (channels.email && this.mail.enabled) {
      const url = `${appUrl()}/${workspace.slug}/${draft.link}`;
      await this.mail.send({
        to: user.email,
        subject: draft.title,
        text: [
          draft.title,
          ...(draft.body ? [draft.body] : []),
          '',
          url,
          '',
          'You can change what Trama emails you in Settings → Notifications.',
        ].join('\n'),
      });
    }
  }

  private async actorName(actor: ActorRef): Promise<string> {
    if (actor.type === 'user' && actor.id)
      return (await this.ds.getRepository(UserEntity).findOneBy({ id: actor.id }))?.name ?? 'Someone';
    if (actor.type === 'agent' && actor.id)
      return (await this.ds.getRepository(AgentEntity).findOneBy({ id: actor.id }))?.name ?? 'An agent';
    if (actor.type === 'team' && actor.id)
      return (await this.ds.getRepository(TeamEntity).findOneBy({ id: actor.id }))?.name ?? 'A team';
    return 'Trama';
  }
}
