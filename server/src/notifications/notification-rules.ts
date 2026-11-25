import type {
  ActorRef,
  LegacySubjectRef,
  NotificationKind,
} from '../contracts/domain.js';

/** The slice of a recorded DomainEvent the rules need. */
export interface RuleEvent {
  type: string;
  actor: ActorRef;
  subject: LegacySubjectRef;
  data: Record<string, unknown>;
}

/** Records the rules may refer to. The service loads whichever the event is about. */
export interface RuleContext {
  event: RuleEvent;
  /** Display name of whoever caused the event. */
  actorName: string;
  issue?: {
    id: string;
    key: string;
    title: string;
    assigneeId?: string | null;
    reporterId?: string | null;
  };
}

/** One message for one person, before settings and delivery are applied. */
export interface NotificationDraft {
  userId: string;
  kind: NotificationKind;
  title: string;
  body?: string;
  /** Relative to the workspace, e.g. `tasks/AUTH-142`. */
  link: string;
  subject: LegacySubjectRef;
}

const asString = (v: unknown): string | undefined =>
  typeof v === 'string' && v ? v : undefined;

/**
 * Who should hear about an event, and what to tell them. Pure: no database, no delivery.
 * The actor never hears about their own action. Callers still apply membership and each
 * person's settings.
 */
export function planNotifications(ctx: RuleContext): NotificationDraft[] {
  const { event, actorName, issue } = ctx;
  const drafts: NotificationDraft[] = [];
  const add = (
    userId: string | null | undefined,
    draft: Omit<NotificationDraft, 'userId'>,
  ) => {
    if (userId) drafts.push({ userId, ...draft });
  };

  switch (event.type) {
    case 'issue.created': {
      add(asString(event.data['assigneeId']), assigned(issue, actorName));
      break;
    }
    case 'issue.updated': {
      const change = event.data['assignee'] as
        { to?: string | null } | undefined;
      add(asString(change?.to), assigned(issue, actorName));
      break;
    }
    case 'review.requested': {
      if (!issue) break;
      const draft = {
        kind: 'review_requested' as const,
        title: `Review requested: ${asString(event.data['title']) ?? 'a pull request'}`,
        body: `${issue.key} · ${issue.title}`,
        link: `tasks/${issue.key}`,
        subject: event.subject,
      };
      // The people the provider asked (mapped through their external identities) hear about it;
      // when none is known the task's assignee does.
      const asked: unknown = event.data['reviewerUserIds'];
      const reviewers = Array.isArray(asked)
        ? asked.filter((id): id is string => typeof id === 'string' && !!id)
        : [];
      if (reviewers.length) for (const id of reviewers) add(id, draft);
      else add(issue.assigneeId, draft);
      break;
    }
    case 'artifact.updated': {
      const ci = (
        event.data['changes'] as Record<string, [unknown, unknown]> | undefined
      )?.['ci'];
      if (!issue || ci?.[1] !== 'failing') break;
      add(issue.assigneeId, {
        kind: 'ci_failed',
        title: `Checks are failing: ${asString(event.data['title']) ?? 'a pull request'}`,
        body: `${issue.key} · ${issue.title}`,
        link: `tasks/${issue.key}`,
        subject: event.subject,
      });
      break;
    }
    case 'comment.created': {
      const excerpt = asString(event.data['excerpt']);
      if (event.subject.type === 'issue' && issue) {
        const draft = {
          kind: 'comment' as const,
          title: `${actorName} commented on ${issue.key}: ${issue.title}`,
          body: excerpt,
          link: `tasks/${issue.key}`,
          subject: event.subject,
        };
        add(issue.assigneeId, draft);
        add(issue.reporterId, draft);
      }
      break;
    }
  }

  // The actor never hears about their own action; one message per person and kind.
  const actorId = event.actor.type === 'user' ? event.actor.id : undefined;
  const seen = new Set<string>();
  return drafts.filter((d) => {
    const key = `${d.userId}:${d.kind}`;
    if (d.userId === actorId || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function assigned(
  issue: RuleContext['issue'],
  actorName: string,
): Omit<NotificationDraft, 'userId'> {
  return {
    kind: 'assigned',
    title: issue
      ? `${actorName} assigned you ${issue.key}: ${issue.title}`
      : `${actorName} assigned you an issue`,
    link: issue ? `tasks/${issue.key}` : 'tasks',
    subject: { type: 'issue', id: issue?.id ?? '' },
  };
}
